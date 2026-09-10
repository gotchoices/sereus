description: Review the new gate that makes shared-workspace network nodes refuse machines belonging to a removed party, so removal starts meaning "we stop talking to you" instead of only deleting a record.
files: packages/cadre-core/src/strand-revocation-enforcer.ts (new), packages/cadre-core/src/strand-instance-manager.ts, packages/cadre-core/src/membership-connection-gater.ts, packages/cadre-core/src/types.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/strand-membership-writer.ts, packages/cadre-core/src/index.ts, packages/cadre-core/test/strand-revocation-enforcer.spec.ts (new), packages/cadre-core/test/strand-instance-manager-revocation.spec.ts (new)
----

# Strand revoked-peer gate — implement handoff

First of three tickets under `plan/4-removal-must-cut-the-network-not-just-the-row`
(gotchoices/sereus#4; owner ruling 2026-09-09: enforcement at the connection and
stream layer). Siblings still in implement/: `strand-revocation-teardown` (active
teardown of already-open connections) and `strand-removal-e2e-and-docs` (real-network
proof + `docs/strands.md`). This ticket built the gate itself.

## What was built

**New module `strand-revocation-enforcer.ts`** — the settled design is recorded in its
module doc (deny-list keyed on REVOCATION evidence, never membership; fail-open in
every ambiguous state; what did and did not transfer from the control gater and why).
Three pieces:

1. `StrandRevocationEnforcer` — materializes `revokedPeerIds`: every
   `Strand.MemberPeer.PeerId` whose `MemberKey` has no live `Strand.Member` row,
   EXCEPT peer ids that also hold a live-membered binding (a machine serving a live
   member is never cut). Snapshot starts empty (admit everything), refreshes on an
   interval (default 30 s, `DEFAULT_REVOCATION_POLL_INTERVAL_MS`) plus a public
   `refresh()`. Refreshes are serialized by promise-chaining; an interval tick that
   finds one in flight is SKIPPED (no pileup) while an explicit `refresh()` call
   always gets a read that starts after the call (so a caller that just committed a
   revocation observes it). A failed read keeps the previous snapshot. Reads are
   injected (`readRows` dep) — production wires `readStrandRevocationRows`, which
   full-scans `Member` + `MemberPeer` and joins in JS (the scan-not-seek idiom from
   `scanMemberPeers`; cost tripwire NOTE at the function).
2. `authorizeStream(peerId, protocol)` — the synchronous fail-closed PRIMARY layer,
   wired as `createLibp2pNode({ authorizeInboundStream })`, gating all four
   `/optimystic/strand-<id>/*` protocols (upstream aborts a denied stream before
   decoding). This is also what catches a revoked peer arriving over a relayed or
   pre-revocation connection.
3. `createRevocationConnectionGater(enforcer, base?)` — composes deny-iff-revoked
   onto `denyDialPeer`, `denyInboundEncryptedConnection`, `denyInboundRelayReservation`
   over the caller's gater. Every base hook preserved (spread; class-instance caveat
   NOTE carried over); deny from either denies; errors and slow decisions fail open
   (`decideWithinDeadline` is now EXPORTED from `membership-connection-gater.ts` and
   reused). No relay budget, no admit-for-relay verdict, no quiet period — the module
   doc records why none of that transfers.

**Wiring** (`strand-instance-manager.ts`): `buildStrandRuntime` arms both layers for
`strandRow.Type === 'c'` only, with `PeerJoinBackfill`-style lifecycle (private map;
created before the libp2p node so its predicates can be embedded in the options;
`start()` — which kicks a non-blocking first refresh — after the strand DB
initializes; stopped and dropped in `releaseRuntime`, so quiesce → resume rebuilds
with a fresh empty snapshot). Open strands keep the exact pre-existing gater
passthrough. Config knob `revocationEnforcement?: { enabled?; pollIntervalMs? }` on
`StartStrandConfig`, threaded from new `CadreNodeConfig.strandRevocationEnforcement`
in `CadreNode.launchStrand` (the only `startStrand` caller).

**Doc/comment updates**: `types.ts` `NetworkConfig.connectionGater` no longer claims
strand nodes get the gater as-is (open: as-is; closed: composed);
`createMembershipConnectionGater`'s "control node only" note points here; NOTE at
`deleteMemberPeerByManager` in `strand-membership-writer.ts`: clearing an ORPHANED
binding forgets the network denial of that peer id (the orphan IS the deny record —
the `Revocation` tombstone keeps only the stamp). Exports added to `index.ts`.

## Use cases to validate against

- Manager revokes a two-machine party → both its peer ids denied on stream +
  connection + dial + relay-reservation; the remaining member's peers unaffected.
- Self-departure (`leaveStrand`) → identical enforcement (same orphan shape).
- Revoked-then-re-admitted → fresh `Member` row for the same key clears its peers
  from the set on the next refresh.
- Peer id bound to two member keys, one revoked one live → admitted.
- Joining party mid-admission → unknown, not revoked → admitted (deny-list rationale;
  the rejected-allowlist argument is in the module doc).
- Open strand → nothing armed, gater passthrough byte-identical to before.
- Unreadable DB / failed refresh → previous snapshot retained, never fail-closed.
- Quiesce → resume → fresh empty snapshot; revoked peer has a short admit window per
  resume until the first read (accepted fail-open posture, documented).

## Test coverage (all green: 114 files / 1919 tests in cadre-core; `yarn lint` clean; build + typecheck clean)

- `strand-revocation-enforcer.spec.ts` (33 tests incl. wiring spec): pure deny-set
  derivation (orphan/live/empty/two-key/multi-machine/re-admission), sync stream
  predicate, refresh contract (serialized, failure-keeps-snapshot, injected-scheduler
  interval + default cadence, tick-skip-while-in-flight), gater composition
  (base deny honored, enforcer deny honored, error-in-either fail-open, non-composed
  hooks preserved), PLUS a real-DB section driving the actual writer flows
  (`revokeMember`, `leaveStrand`, `addMemberByManager` re-admission) through
  `readStrandRevocationRows` on a real closed strand via the `openStrand` harness.
- `strand-instance-manager-revocation.spec.ts`: the arming gate (closed arms both
  layers, open arms neither and passes the raw gater, `enabled:false` disarms, knob
  threading, compose-not-replace, quiesce/resume/stop lifecycle) — same mock doubles
  as the backfill arming spec.

## Known gaps — honest notes for the reviewer

- **Inert on production strands today.** Formation hands every party the same
  `MemberPrivateKey`, so a real closed strand has ONE founding `Member` and no
  `MemberPeer` rows — empty deny set, exactly today's behavior. The gate is exercised
  by tests minting distinct member keys. `backlog/feat-strand-party-identity` owns
  the identity work; deliberately not absorbed here (per ticket).
- **No real-network end-to-end assertion here** (a revoked peer's actual stream being
  refused across two live libp2p nodes) — that is `strand-removal-e2e-and-docs`'s
  job. The stream-gate wiring is asserted at the options level only (predicate
  present, routed into the enforcer), trusting upstream's `authorizeInboundStream`
  contract, which `db-p2p` documents and tests.
- **Already-open connections are not torn down** on refresh — a revoked peer that was
  connected before the revocation replicated keeps its connection (mute on the four
  DB protocols via the stream gate) until `strand-revocation-teardown` lands.
- **Base-gater errors are swallowed fail-open** in the three composed hooks (per the
  ticket's test list). This DIFFERS from `createMembershipConnectionGater`, which
  lets a base hook's throw propagate; a reviewer may want the two harmonized.
- **`docs/strands.md` untouched** — the orphan-rows-are-load-bearing story lands with
  the docs ticket; the code-site NOTEs carry it meanwhile.
- Interval ticks skip (rather than queue) while a refresh is in flight; explicit
  `refresh()` calls chain unboundedly in principle — bounded in practice by callers
  (interval skips; on-demand calls are rare). No cap was added.
