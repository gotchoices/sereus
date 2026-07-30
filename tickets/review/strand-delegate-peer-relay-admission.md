description: A machine's private data-sharing session can now start behind a home router: the party's storage machine accepts connection-forwarding for the extra network names its own members announce, and only those. Review the deliberate security widening and the announce timing.
files: packages/cadre-core/src/delegate-admission.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/strand-addr-protocol.ts, packages/cadre-core/src/types.ts, packages/cadre-core/src/strand-transport-key.ts, packages/cadre-core/src/strand-instance-manager.ts, packages/cadre-core/test/delegate-admission.spec.ts, packages/cadre-core/test/control-stream-authorization.spec.ts, packages/cadre-core/test/strand-addr-protocol.spec.ts, packages/integration-tests/src/scenarios/control-stream-authz.integration.ts, packages/integration-tests/src/scenarios/push-wake-e2e.integration.ts, docs/strands.md, docs/architecture.md
difficulty: hard
----

# Review: delegate-peer admission — a party relay serves its own members' strand nodes

## What was broken

`push-wake-e2e.integration.ts > delivers a wake to a NAT'd receiver over a circuit-relay
(signaling-first) dial` failed deterministically. A strand node runs as its own libp2p
instance with a transport peerId derived from the cadre identity key + strandId
(`strand-transport-key.ts`). That peerId was unattested — nothing bound it to a party
member — so when the NAT'd strand node tried to reserve a relay slot on a party control
node running the relay server (the default for storage-profile nodes), the relay's
membership connection gater (`admitInboundControlConnection`) denied the connection, the
reservation stream died, and `libp2p.start()` threw: the strand never started.

## What was built

**Member-announced delegate grant.** Before a member's control node starts a strand node,
it announces the derived transport peerId over the existing, already-authenticated
`/sereus/strand-addr/1.0.0` RPC (new optional `StrandAddrRequest.delegatePeerId`). The
responder — after its existing `isAuthorizedMember` gate — records a short-lived,
in-memory admission grant for exactly that peerId. The connection gate consults it; the
per-stream gate does not.

- `delegate-admission.ts` (new): `DelegateAdmissionStore` — 30 min TTL
  (`DELEGATE_GRANT_TTL_MS`), replace-per-(announcer, strandId) so a restarted strand
  cannot leak grants, caps of 32 per member / 256 global with soonest-expiry-first
  eviction (replace never evicts), lazy pruning. Plus `extractCircuitRelayTargets` —
  parses relay peerId + direct-dial prefix out of `/p2p-circuit` multiaddrs.
- `cadre-node.ts`: grant store field + public `grantDelegateAdmission` /
  `hasDelegateAdmission`; the gate check sits between the enrollment-window check and the
  `listAuthorizedMembers()` DB read (in-memory, cheap). `launchStrand` and
  `resumeStrandRuntime` derive the transport key/peerId BEFORE seed resolution;
  `resolveCohortSeed(strandId, delegatePeerId?)` merges relay targets (configured
  `listenAddrs` circuits + live control-node circuit addrs; sibling entry wins on dedup,
  relay direct addr rides as dial fallback) and sets the field on the RPC it already
  sends. `refreshDelegateGrants` re-announces from the 15 s reconcile pass, throttled to
  TTL/2 per (relay, strand), relay targets only, pruning stopped-strand keys.
- `strand-addr-protocol.ts`: `onDelegateAnnounce` hook, called after the `isMember` gate;
  validates via `peerIdFromString`, drops malformed ids and self-announces.
- `authorizeInboundControlStream` is UNCHANGED by design (doc extended): a
  delegate-admitted connection is exactly a case the stream gate must still refuse.

Alternatives rejected (recorded in the ticket + `docs/strands.md`): admit-everyone on
relay-enabled nodes (widens layer-2 gate to all strangers), durable signed attestation
rows (replication-latency dependency on a hard-fail path; deferred to strand-mesh
admission work, noted in `docs/strands.md`), stop inheriting the `/p2p-circuit` listen
addr (non-fix — leaves NAT'd strands unreachable).

## Announce timing — reviewer must verify this holds

The announce lands on the responder BEFORE the strand's `libp2p.start()` dials the relay
reservation, on all three launch paths: `addStrand`, `resumeStrand` via wake, and via
check-in — **all funnel through `resolveCohortSeed` with the delegate peerId before
`startStrand`/`resumeStrand` starts libp2p**. The responder records the grant before
writing its RPC response and the client awaits responses, so the ordering is synchronous,
not racy. The failure mode if this ordering ever breaks is fatal (start throws), not
degraded.

## Residual exposure (verbatim from the design — judge the widening deliberately)

A delegate grant admits a **connection**, so the delegate reaches the always-on libp2p
services on the relay's control instance: `identify`/`identifyPush`, `ping`, `dcutr`,
`autoNAT`, `gossipsub`, the circuit-relay `hop`, and the fret/arachnode DHT services
(`../optimystic/packages/db-p2p/src/libp2p-node-base.ts:504-620`). The four Optimystic
control-DB protocols stay fail-closed, and wake/strand-addr/formation/seed keep their own
in-handler decisions. So the widening versus today is: **an authorized member can hand
connection-level access to a peerId of its choosing for up to `DELEGATE_GRANT_TTL_MS`.** The
relay cannot verify that the named peerId really is that member's strand node — the derivation
uses the member's *private* seed by design (`strand-transport-key.ts:30-34`), so it is not
recomputable by a third party. This is a delegation of trust to an already-trusted member, not
an opening to strangers; option A would have opened it to everyone.

## Validation run (all green, 2026-07-29)

- cadre-core: `yarn typecheck`, `yarn build` clean; `yarn vitest run` 997 passed /
  1 skipped (pre-existing skip). Root `yarn lint` clean. Re-verified after final doc
  edits: cadre-core typecheck + root lint clean.
- Gating scenario: `push-wake-e2e.integration.ts` green alone via `-t "circuit-relay"`
  AND whole-file 4/4. Entry removed from `tickets/.pre-existing-known.md` (moved to its
  resolved section).
- New integration case: `control-stream-authz.integration.ts > denies an un-announced
  stranger connection, admits an announced delegate, and still refuses that delegate the
  repo and strand-addr surfaces` — 2/2 in file, `yarn typecheck` in integration-tests
  clean. Covers: (a) stranger connection denied (deny lands receiver-side after noise, so
  the test polls receiver-side closure then asserts absence on the gater side), (b)
  announced delegate connection admitted, (c) that same delegate still refused the repo
  protocol and the strand-addr member gate.
- Unit specs: `delegate-admission.spec.ts` (expiry, refresh, replace semantics, both caps,
  eviction order, extractor edge cases), `control-stream-authorization.spec.ts` ("grant
  admits the CONNECTION but not the STREAM"), `strand-addr-protocol.spec.ts` (member
  announce records, non-member/malformed/self-announce ignored, absent field never calls
  hook, client carries `delegatePeerId` to every receiver).

## Known gaps / honest flags for the reviewer

- **Optimistic announce recording.** `collectStrandAddrs` folds per-peer failure to `[]`
  with no per-peer success signal, so the throttle records announce timestamps
  optimistically (documented at `recordDelegateAnnounces`). Tradeoff: a failed INITIAL
  announce is fatal-at-start anyway (relay denies, `libp2p.start()` throws, wake/check-in
  retries with a fresh announce); a failed REFRESH retries within TTL/2 = 15 min, inside
  the 30 min TTL. Worth a reviewer's eye on whether that window is acceptable.
- **Relay restart loses grants.** The store is in-memory; a relay restart drops all
  grants and the announcer doesn't learn of it. A strand's reservation re-dial can be
  denied for up to ~TTL/2 until the next refresh re-announces. Adjacent to the deferred
  durable-attestation work; not covered by a test.
- **Autorelay tripwire** (`NOTE:` at `circuitRelayTargets` in `cadre-node.ts`): a relay
  the STRAND node discovers on its own — in neither configured `listenAddrs` nor the
  control node's live addrs — gets no announcement and a membership-gated one will deny
  it. Fine now; every realistic topology feeds one of the two sources.
- **No revocation / audit.** Grants expire only by TTL or replacement; durable
  attestation (signed `MemberPeer` rows) is deliberately deferred to strand-mesh
  admission work (bullet in `docs/strands.md`).
- Docs updated: `docs/strands.md` relay-willingness question resolved,
  `docs/architecture.md` strand-addr section gained the delegate-announce direction,
  `strand-transport-key.ts` stale "unattested … breaks nothing" NOTE corrected,
  `strand-instance-manager.ts` listenAddrs-inheritance NOTE extended (`/p2p-circuit`
  inheritance now deliberate).

## Review findings

_(to be filled by review stage)_
