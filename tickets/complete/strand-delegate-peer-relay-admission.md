description: A machine's private data-sharing session can now start behind a home router — the party's storage machine forwards connections for the extra network names its own members announce, and only those. Built, reviewed, and shipped.
files: packages/cadre-core/src/delegate-admission.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/strand-addr-protocol.ts, packages/cadre-core/src/membership-connection-gater.ts, packages/cadre-core/src/types.ts, packages/cadre-core/src/strand-transport-key.ts, packages/cadre-core/src/strand-instance-manager.ts, packages/cadre-core/test/delegate-admission.spec.ts, packages/cadre-core/test/control-stream-authorization.spec.ts, packages/cadre-core/test/strand-addr-protocol.spec.ts, packages/integration-tests/src/scenarios/control-stream-authz.integration.ts, packages/integration-tests/src/scenarios/push-wake-e2e.integration.ts, docs/strands.md, docs/architecture.md
----

## What was broken

A strand node runs as its own libp2p instance whose transport peerId is derived from the
cadre identity key + strandId (`strand-transport-key.ts`) — a name no sibling can
recompute, because the derivation uses the member's *private* seed by design. Nothing bound
that peerId to a party member, so when a NAT'd member's strand node tried to reserve a
circuit-relay slot on a sibling control node running the relay server (the default for
storage-profile nodes), the relay's membership connection gater denied the connection, the
reservation stream died, and the strand's `libp2p.start()` threw. Deterministic failure of
`push-wake-e2e.integration.ts > delivers a wake to a NAT'd receiver over a circuit-relay
(signaling-first) dial`.

## What shipped

**Member-announced delegate grant.** Before a member's control node starts a strand node it
announces the derived transport peerId over the existing, already-authenticated
`/sereus/strand-addr/1.0.0` RPC (new optional `StrandAddrRequest.delegatePeerId`). The
responder — after its existing `isAuthorizedMember` gate — records a short-lived in-memory
grant for exactly that peerId. The **connection** gate consults it; the fail-closed
**per-stream** gate never does, so a delegate gets the connection a circuit-relay
reservation needs and nothing more.

- `delegate-admission.ts` (new): `DelegateAdmissionStore` — 30 min TTL, replace-per-
  (announcer, strandId), caps of 32/member and 256 global with soonest-expiry-first
  eviction, lazy pruning, `clear()` on node stop. Plus the pure announcer-side helpers:
  `extractCircuitRelayTargets`, `dueRelayAnnounces`, `pruneStoppedStrandAnnounces`,
  `peerStrandKey`.
- `cadre-node.ts`: grant store + `grantDelegateAdmission` / `hasDelegateAdmission`; gate
  check between the enrollment-window check and the `listAuthorizedMembers()` DB read.
  `launchStrand` and `resumeStrandRuntime` derive the transport key/peerId BEFORE seed
  resolution; `resolveCohortSeed(strandId, delegatePeerId?)` merges the node's circuit
  relays into the RPC targets and carries the delegate peerId; `refreshDelegateGrants`
  re-announces from the 15 s reconcile pass, throttled to half the TTL per (relay, strand),
  relay targets only, pruning stopped-strand keys.
- `strand-addr-protocol.ts`: `onDelegateAnnounce` hook after the `isMember` gate; validates
  via `peerIdFromString`, drops malformed ids and self-announces.

Rejected alternatives (recorded in `docs/strands.md`): admit-everyone on relay-enabled
nodes (widens the connection gate to all strangers); durable signed attestation rows
(replication-latency dependency on a hard-fail path — deferred to strand-mesh admission
work); stop inheriting the `/p2p-circuit` listen addr (leaves NAT'd strands unreachable).

## Review findings

Reviewed across two passes. Pass 1 read the full six-commit implement diff
(`1843ce8^..13e5238`) and every file it touched; pass 2 applied the fixes and validated.

### Verified correct (checked, no change needed)

- **Announce-before-`libp2p.start()` ordering holds on all three launch paths**
  (`addStrand`, wake resume, check-in resume) — all funnel through `resolveCohortSeed` with
  the delegate peerId before `startStrand`/`resumeStrand`. The responder records the grant
  before writing its reply and the client awaits it, so the ordering is synchronous, not
  racy.
- **The resumed peerId matches the announced one.** `resumeStrand` rebuilds from the
  retained `launchConfigs` entry carrying the original derived private key, and
  `strandTransportKey` is deterministic — the re-derivation cannot name a peerId different
  from the one the node starts with. This was the most plausible way for the ordering fix
  to be silently wrong; it is not.
- **The connection/stream split is real, not merely documented.** The gater composes only
  `denyInboundEncryptedConnection` and never touches `denyInboundRelayReservation`, so a
  connection is genuinely all a `hop` reservation needs;
  `authorizeInboundControlStream` never consults the grant store.
- **Cap and eviction arithmetic** in `DelegateAdmissionStore` — traced per-member and
  global eviction at and below cap, including replace-never-evicts. Correct.
- **`extractCircuitRelayTargets`** — traced the relay-component index, the `circuitIdx < 1`
  guard, `decapsulate`, and the trailing-`/p2p/<dst>` case. Correct; unit-tested.
- **The residual widening is bounded as designed.** A connection-only admit newly reaches
  the two stranger-open protocols (seed, formation) without an enrollment window, but both
  make their own in-handler trust decision (signature-checked against the trusted-owner
  anchor; per-token respectively). Wake and strand-addr refuse a non-member in-handler; the
  four Optimystic control-DB protocols stay fail-closed. This is a delegation to an
  already-trusted member, correctly scoped. Accepted as designed — no ticket.

### Found and fixed in this pass (minor)

1. **`refreshDelegateGrants` serialized per strand and blocked the reconcile pass.** It ran
   ahead of the sibling enumeration and awaited each strand's relay announce in turn; one
   unreachable relay costs up to ~20 s of dial timeout, so 5 strands could delay sibling
   reconcile by ~100 s per throttle window. Now the strands announce concurrently
   (`Promise.all` over a new `announceDelegateToDueRelays`); `collectStrandAddrs` never
   rejects, so the pass stays best-effort.
2. **Sibling keys were recorded in a throttle map that only reads relay keys.**
   `resolveCohortSeed` recorded the merged target list; the refresh only ever looks up
   `<relayPeerId>` keys, so every sibling entry was dead weight living until the strand
   stopped. Now only the relay targets are recorded, and `recordDelegateAnnounces` takes
   peerIds rather than RPC targets.
3. **Delegate state survived `stop()`.** `cleanup()` left `delegateAdmission` and the
   throttle map populated, so a `stop()`/`start()` cycle on the same `CadreNode` kept
   admitting delegates announced under the previous session (bounded only by the 30 min
   TTL) and carried stale timestamps that would suppress the new session's first refresh.
   Both are cleared now; `DelegateAdmissionStore.clear()` added and unit-tested.
   (`authorizedControlPeers` is likewise not cleared there — pre-existing, out of scope,
   deliberately untouched.)
4. **`membership-connection-gater.ts` was stale.** Its module doc claims to be the ONE
   place the connection-level allowlist is defined and enumerates every carve-out, yet said
   nothing about the delegate grant — the file the change most clearly should have touched
   and did not. The grant is now enumerated there, cross-referencing
   `delegate-admission.ts` and stating that it is connection-only.

**Test gap closed with the fixes**: the throttle + prune logic had no test at all despite
taking an injectable `now`. The decision is now a pure pair of functions in
`delegate-admission.ts` (`dueRelayAnnounces`, `pruneStoppedStrandAnnounces`) — which also
keeps new logic out of the already-oversized `cadre-node.ts` — with unit coverage for the
boundary at exactly half the TTL, the not-yet-due skip, per-(relay, strand) independence,
and the prune. 7 new unit tests.

### Major findings

None. No new `fix/`, `plan/`, or `backlog/` ticket was warranted — every concern found was
either fixable inline or genuinely conditional (below).

### Tripwires (conditional — parked, not ticketed)

- **Relay restart drops all grants.** The store is in-memory and the announcer is not told,
  so a strand whose reservation re-dials in that window is denied until the next refresh
  (≤15 min). Fine while restarts are rare and recovery is automatic. Parked as a bullet in
  `docs/strands.md` → "Relay willingness", next to the deferred durable-attestation entry
  that is its fix.
- **Announce timestamps are recorded optimistically.** `collectStrandAddrs` folds per-peer
  failure to `[]` and reports no per-peer success, so a failed announce still stamps the
  throttle. A failed INITIAL announce is fatal-at-start anyway and retries on the next
  wake/check-in; a failed REFRESH retries within 15 min, inside the 30 min TTL. Parked in
  the `recordDelegateAnnounces` docstring at the site.
- **Autorelay-discovered relays get no announcement.** A relay the strand node finds on its
  own — in neither the configured `listenAddrs` nor the control node's live addrs — is
  never announced to and a membership-gated one will deny it. Every realistic topology
  feeds one of the two sources. Parked as the existing `NOTE:` at
  `CadreNode.circuitRelayTargets`.
- **No revocation or audit.** Grants expire only by TTL or replacement. Durable signed
  `MemberPeer` attestation is deliberately deferred to strand-mesh admission work — already
  a bullet in `docs/strands.md`.

### Docs

Read every file the change touched plus the ones it should have. `docs/strands.md` (relay
willingness resolved + the new restart bullet), `docs/architecture.md` (strand-addr section
carries the delegate-announce direction), `strand-transport-key.ts` (stale "unattested …
breaks nothing" note corrected), `strand-instance-manager.ts` (`/p2p-circuit` inheritance
now deliberate), and `membership-connection-gater.ts` (finding 4) all reflect the new
reality.

## Validation

All green.

- `packages/cadre-core`: `yarn typecheck` clean, `yarn build` clean, `yarn vitest run`
  **1004 passed / 1 skipped** (the skip is pre-existing; 997 before this review's 7 new
  tests).
- Root `yarn lint`: clean.
- `packages/integration-tests`: `yarn typecheck` clean; the two gating scenarios re-run
  after the fixes (they exercise `resolveCohortSeed`, `cleanup()`, and the gate) —
  `push-wake-e2e.integration.ts` 4/4 and `control-stream-authz.integration.ts` 2/2,
  including the NAT'd circuit-relay wake this ticket set out to fix and the
  stranger-denied / delegate-admitted / delegate-still-stream-refused case.
- No pre-existing failures surfaced; nothing skipped or loosened.
