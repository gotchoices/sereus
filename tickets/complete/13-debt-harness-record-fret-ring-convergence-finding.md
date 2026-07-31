description: Fixed a wrong comment in the test setup code that claimed test machines never discover each other — measurement showed they do, within about five seconds — and recorded a real permanent limit in the star-shaped test topology.
prereq:
files: packages/integration-tests/src/harness/test-party.ts, tickets/plan/13.5-debt-harness-control-cohort-observable-and-forced.md, tickets/plan/20-debt-control-write-unanimity-at-three-nodes.md
difficulty: easy
----

# Recorded the measured peer-ring convergence finding; fixed the stale harness comment

Comment/ticket-text only. No behaviour change, no test change.

## The finding this ticket preserves

- **Refuted**: peers that only ever get dialled *into* a node do join that node's
  peer-routing ring — measured within ~5 s of `createTestParty` resolving, over real
  libp2p/TCP. What earlier looked like "the group never grows" was a start-up race:
  writes issued before the ring warms see a one-member group and commit on the writer's
  own vote (cluster downsize is allowed by default).
- **Real, permanent limit**: in the star topology `createTestParty` builds, drones only
  dial the owner, never each other, so each drone's group caps at 2 (self + owner)
  forever. Only the owner ever sees all party members.

## What landed

`packages/integration-tests/src/harness/test-party.ts`
- Replaced the stale `NOTE:` in `createTestNode`'s `clusterPolicy` comment (~56-61); the
  old text asserted no non-self candidates ever appear and cited a deleted ticket.
- Added a short `NOTE:` at the drone-creation loop (~124-127) for the permanent 2-member
  cap.

Review pass (this stage) additionally corrected ticket text that the finding invalidated:
- `tickets/plan/13.5-debt-harness-control-cohort-observable-and-forced.md` — repointed its
  `prereq:` and Related entry from the deleted `debt-harness-control-cohort-diagnose-empty-fret-ring`
  to this ticket's slug; answered its one deferred decision inline (forcing is a **stopgap**,
  not a permanent fixture); added the measured cause to its problem statement so it no
  longer reads as a structural defect; removed its Housekeeping section (already done);
  added an instruction to replace the code comment's forward ticket-slug pointer with the
  helper's name once the helper exists.
- `tickets/plan/20-debt-control-write-unanimity-at-three-nodes.md` — its Related section
  claimed "the harness cannot currently form a three-machine cohort at all" and cited the
  deleted slug. Replaced with what was measured.

## Review findings

**Correctness of the recorded claims — checked, all hold.**
- "Commits on the writer's own vote under `allowClusterDownsize`" — verified: the option
  defaults to `true` in `../optimystic/packages/db-p2p/src/libp2p-node-base.ts:629,721`
  and `coordinator-repo.ts:181`, and `libp2p-key-network.ts:584,615` documents the same
  self-only-completes behaviour.
- "Drones cap at 2 members **permanently**" — this was the one claim worth attacking,
  since it was measured only to t=30 s and stated as forever. Checked whether any live
  mechanism could hand drone A an address for drone B: FRET's own discovery dispatches
  `peer:discovery` with an **empty** multiaddr list (`fret-service.ts:1176`) and gates
  classification on `isConnected || hasAddresses` (`:542,564,945`); libp2p `identify` /
  `identifyPush` carry only the connected peer's own addresses; there is no kad-DHT in the
  node config; gossipsub is configured without peer exchange
  (`libp2p-node-base.ts:540-543`). No third-party address path exists, so the claim is
  sound as written, not an over-read of a 30 s window.
- Comment placement and wording read correctly in context; the surrounding rationale for
  sharing `clusterPolicy`/`clusterSize` with production is intact.

**Stale cross-references — found and fixed.** The handoff flagged this as not exhaustively
grepped. A repo-wide grep for the two deleted slugs found live references in two `plan/`
tickets; both are corrected above. References in `tickets/complete/` were **left alone
deliberately** — those are archived records of what was believed at the time, and
rewriting history there would be worse than the stale pointer.

**Structural / hygiene review — nothing to fix.** Comment-only diff; no new functions,
types, resources, or error paths. File size and comment density unchanged in character.

**Tests — no new tests, and correctly so.** There is no observable behaviour to assert;
the finding's own measurement is not reproducible as a suite test without the wait helper
`debt-harness-control-cohort-observable-and-forced` builds, which is where that coverage
belongs.

**Tripwires — none recorded.** Nothing here is conditional; the one forward-looking
concern (the comment names a ticket slug, and ticket slugs go stale — exactly the failure
this ticket repaired) is not conditional but scheduled work, so it was written into
`debt-harness-control-cohort-observable-and-forced` as an explicit step rather than left
as a note.

**New tickets filed — none.** No major finding surfaced.

## Validation

- `yarn workspace @serfab/integration-tests typecheck` — exit 0.
- `yarn eslint packages/integration-tests/src/harness/test-party.ts` — exit 0.
- `yarn workspace @serfab/integration-tests test` — 34 files, 150 passed, 1 expected fail,
  **4 failed** across 3 files, 492 s. None are attributable to this diff (comments only);
  all three files already have their root cause tracked, so per the pre-existing-failure
  rule no new report was filed:
  - `control-cohort-three-node-isolation.integration.ts` (2 failures, "B resolves C's
    signed CadrePeer address record" timeout) — `blocked/transactor-key-network-ignores-network-scoping`,
    which names this exact scenario file.
  - `control-write-degraded-cohort-member.integration.ts` ("commits with a member delayed
    under the response deadline" timeout) — `blocked/control-reads-blocked-by-stalled-write`,
    which names this exact scenario file.
  - `zz-scratch-delete-alone.integration.ts` (`SyncRetryExhaustedError`, stale revision) —
    a scratch scenario committed by an interrupted run of
    `plan/10-control-delete-while-alone-tombstone`, which still carries a resume note.
    That ticket owns both the failure and the file's eventual deletion.
