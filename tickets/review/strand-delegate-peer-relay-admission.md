description: A machine's private data-sharing session can now start behind a home router: the party's storage machine accepts connection-forwarding for the extra network names its own members announce, and only those. A review pass ran out of budget partway; finish it.
files: packages/cadre-core/src/delegate-admission.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/strand-addr-protocol.ts, packages/cadre-core/src/membership-connection-gater.ts, packages/cadre-core/src/types.ts, packages/cadre-core/src/strand-transport-key.ts, packages/cadre-core/src/strand-instance-manager.ts, packages/cadre-core/test/delegate-admission.spec.ts, packages/cadre-core/test/control-stream-authorization.spec.ts, packages/cadre-core/test/strand-addr-protocol.spec.ts, packages/integration-tests/src/scenarios/control-stream-authz.integration.ts, packages/integration-tests/src/scenarios/push-wake-e2e.integration.ts, docs/strands.md, docs/architecture.md
difficulty: hard
----

<!-- resume-note -->
A prior review run read the whole implement diff (`1843ce8^..13e5238`, 6 commits) and
verified the design end to end, but hit the token budget before applying its inline fixes
or running lint/tests. **Nothing was changed in the working tree — the diff is exactly as
the implementer left it.** Everything already established is written up in
"## Review pass 1 — what was verified" and "## Review pass 1 — findings" below. Start from
those two sections; do NOT re-read the whole diff. The remaining work is the four inline
fixes and the validation run, listed in "## Remaining work".
<!-- /resume-note -->

## Review pass 1 — what was verified (do not redo)

Read in full: the six-commit implement diff, `delegate-admission.ts`,
`strand-addr-protocol.ts` (whole file), `membership-connection-gater.ts` (whole file),
`cadre-node.ts` regions (gate 860-1040, reconcile 1495-1575, launch/seed/refresh
2569-3035, `cleanup()` 2418-2489), `strand-instance-manager.ts` (`startStrand` /
`resumeStrand` / `buildStrandRuntime`), `seed-bootstrap.ts` seed handler, and every new
or changed test.

Confirmed correct:

- **The announce-before-`libp2p.start()` ordering claim holds** on all three launch paths.
  `launchStrand` derives `transportKey` → `delegatePeerId` → `resolveCohortSeed(...)` →
  `startStrand` (`cadre-node.ts:2863-2888`); `resumeStrandRuntime` re-derives and does the
  same (`cadre-node.ts:2573-2582`); wake and check-in both funnel through one of those
  two. The responder records the grant *before* writing its response
  (`processAddrRequest` → `recordDelegateAnnounce` → reply) and the client awaits the
  response, so it is synchronous, not racy.
- **The resumed peerId matches the announced one.** `resumeStrand` rebuilds from the
  retained `launchConfigs` entry, which carries the original derived `privateKey`
  (`strand-instance-manager.ts:396-418`), and `strandTransportKey` is deterministic — so
  `resumeStrandRuntime`'s re-derivation cannot name a different peerId than the node
  actually starts with. This was the most plausible way for the ordering fix to be
  silently wrong; it is not.
- **The connection/stream split is real, not just documented.** The gater composes only
  `denyInboundEncryptedConnection` (`membership-connection-gater.ts:148-163`); it does not
  touch `denyInboundRelayReservation`, so the connection is genuinely all a circuit-relay
  `hop` reservation needs, and `authorizeInboundControlStream` never consults the store.
- **Cap/eviction arithmetic in `DelegateAdmissionStore`** — traced per-member and global
  eviction at and below cap, including the replace-never-evicts path. Correct.
- **`extractCircuitRelayTargets`** — traced `components[circuitIdx - 1]`, the
  `circuitIdx < 1` guard, `decapsulate('/p2p-circuit')`, and the trailing-`/p2p/<dst>`
  case. Correct; unit tests cover all of them.
- **The residual widening is bounded as the implementer describes.** Checked what a
  connection-only admit actually reaches: the two stranger-open protocols
  (`STRANGER_OPEN_PROTOCOLS` = seed + formation) are newly reachable without an enrollment
  window, but both make their own in-handler trust decision — seed application is
  signature-checked against the trusted-owner anchor (`seed-bootstrap.ts:1039` →
  `applySeed`), formation is per-token. Wake and strand-addr refuse a non-member
  in-handler. The four Optimystic control-DB protocols stay fail-closed. Judgment: the
  widening is a delegation to an already-trusted member, correctly scoped, and the
  rejected alternative (admit-everyone on relay-enabled nodes) was strictly worse.
  **No ticket; accepted as designed.**

## Review pass 1 — findings

All four are **minor — fix inline in this pass**. No major findings; no new `fix/`,
`plan/`, or `backlog/` ticket is warranted by pass 1.

1. **`refreshDelegateGrants` serializes per strand and blocks the reconcile pass.**
   `cadre-node.ts:3019-3033` awaits `collectStrandAddrs` once per running strand in a
   `for` loop, and `runReconcileControlCohort` awaits the whole thing *before* the sibling
   enumeration (`cadre-node.ts:1539`). `dialOneSibling` tries two targets (peerId, then
   addr) at 10 s each, so one unreachable relay costs up to ~20 s per strand: 5 strands
   ≈ 100 s of delayed sibling reconcile, once per throttle window. Fix: `Promise.all` over
   the running strands (the relays inside one call are already concurrent).

2. **`recordDelegateAnnounces` records sibling keys that the throttle never reads.**
   `resolveCohortSeed` passes the *merged* target list (`cadre-node.ts:2945`), but
   `refreshDelegateGrants` only ever looks up `<relayPeerId>\n<strandId>` keys — so every
   sibling entry is dead weight in `delegateAnnounceAt`, kept alive until the strand stops.
   The docstring calls it "harmless", which it is, but it muddies the map's contract. Fix:
   capture the relay target list in `resolveCohortSeed` and record only those.

3. **Delegate state is not cleared on `stop()`.** `cleanup()` (`cadre-node.ts:2418-2489`)
   clears `turnRelayedPeers` and `sAppConfigs` but leaves `delegateAdmission` and
   `delegateAnnounceAt` populated, so a `stop()` → `start()` cycle on the same `CadreNode`
   object keeps admitting delegates announced under the previous session (bounded only by
   the 30 min TTL) and keeps stale throttle timestamps. Fix: clear both in `cleanup()`.
   (Note in passing: `authorizedControlPeers` is not cleared there either — pre-existing,
   out of scope, do not touch.)

4. **`membership-connection-gater.ts` was not updated and is now out of date.** Its module
   doc is explicitly "the ONE place [the stranger allowlist] is defined" and enumerates the
   carve-outs and the two-layer split (lines 15-57), yet says nothing about the delegate
   grant — a third connection-level carve-out. It is the file this change most clearly
   *should* have touched and did not. Fix: add the delegate grant to that enumeration,
   cross-referencing `delegate-admission.ts`, and note it is connection-only.

Test-coverage gap noted, to be closed as part of the fixes above rather than filed
separately: **`refreshDelegateGrants`'s throttle + prune logic has no test at all** — it
already takes an injectable `now`, so it was written to be testable, but nothing exercises
it. It is also the mechanism the "relay restart loses grants" gap depends on. Closing it
cleanly means extracting the due-relay decision as a pure helper in
`delegate-admission.ts` (e.g. `dueRelayAnnounces(announceAt, relays, strandId, now, ttlMs)`)
and unit-testing that — which also keeps new logic out of the already-oversized
`cadre-node.ts`. Prefer that over a `CadreNode`-level test with a faked strand manager.

## Remaining work

- Apply findings 1-4 inline (see each for the intended fix).
- Extract the due-relay throttle decision into `delegate-admission.ts` and add unit tests
  for it in `delegate-admission.spec.ts` (throttle boundary at exactly `TTL / 2`,
  not-yet-due skip, prune of stopped-strand keys).
- Re-check the implementer's own flagged gaps against the final code and either accept them
  as tripwires or record them: optimistic announce recording, relay-restart grant loss,
  the autorelay `NOTE:` at `circuitRelayTargets`, and no revocation/audit. Pass 1's read
  suggests all four are genuinely conditional (fine now, only bite if X) and belong as
  tripwires/`docs/strands.md` bullets, not tickets — confirm, don't re-derive.
- Validation, all must pass: `yarn typecheck` + `yarn vitest run` in
  `packages/cadre-core`, root `yarn lint`, and `yarn typecheck` in
  `packages/integration-tests`. Stream output through `tee`, never silent redirect.
  Re-run the two gating integration scenarios only if a fix touches their paths:
  `push-wake-e2e.integration.ts` and `control-stream-authz.integration.ts`.
- Write the `complete/` ticket with a `## Review findings` section that folds in pass 1's
  verified-list, the four findings and their disposition, the tripwires and where each was
  parked, and the validation results. Then delete this ticket.

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

Pass 1's results are above ("Review pass 1 — what was verified" / "— findings"). The
consolidated `## Review findings` section belongs in the `complete/` ticket, once the
remaining work lands.
