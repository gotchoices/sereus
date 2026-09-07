description: The control network now sizes its block-repair check from the number of machines in the group, by remembering that number on disk between runs instead of asking a database that does not exist yet.
files: packages/cadre-core/src/enrolled-machine-store.ts (new), packages/cadre-core/src/enrolled-machine-store-file.ts (new), packages/cadre-core/test/enrolled-machine-store.spec.ts (new), packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/types.ts, packages/cadre-core/src/index.ts, packages/cadre-core/package.json, packages/cadre-core/test/cadre-node-control-node-options.spec.ts, packages/cadre-cli/src/commands/start.ts, packages/reference-app-rn/src/cadre-phone.ts, packages/reference-app-rn/src/node-local-slots.ts, packages/reference-app-rn/test/node-local-slots.spec.ts, packages/integration-tests/src/harness/node-fixtures.ts, packages/integration-tests/src/scenarios/control-divergent-repair-yardstick.integration.ts (new), docs/architecture.md
difficulty: medium
----

# Review: control node declares its repair yardstick across a restart

## What landed

`CadreNode.buildControlNodeOptions` runs before `createControlNode()`, which runs before
the `ControlDatabase` holding the `CadrePeer` rows exists — so the enrolled-machine count
was unreadable at the one moment it was needed, and the control network declared no repair
yardstick. That deadlock is now broken by remembering the count across the restart.

- **`enrolled-machine-store.ts`** — `EnrolledMachineStore` (`count()` / `record()`),
  `MemoryEnrolledMachineStore`, `PersistentEnrolledMachineStore` over a `DurableSlot`.
  Envelope `{ version: 1, partyId, enrolledMachines }`.
- **`enrolled-machine-store-file.ts`** — `FileEnrolledMachineStore` behind the new
  `@serfab/cadre-core/enrolled-machine-store-file` subpath, keeping `node:fs` out of the
  RN/browser graph.
- **`CadreNodeConfig.enrolledMachines`** — injected store; omitted means an in-memory store
  (cold start every launch = pre-existing behaviour). No embedder is forced to change.
- **`CadreNode`** — `initializeEnrolledMachineStore()` runs in `start()` before
  `createControlNode()` and captures the count into `declaredEnrolledMachines`;
  `buildControlNodeOptions` passes `controlClusterPolicy(that)`;
  `refreshAuthorizedControlPeers` records `authorizedControlPeers.size + 1`.
- **Embedders** — `cadre-cli` (file-backed, node state dir), `reference-app-rn` (LevelDB,
  new `enrolledMachinesKvKey`). `cadre-host` needed nothing, as the ticket said.

## Deliberate divergence a reviewer should check on purpose

This record does **not** use `NodeLocalSnapshot`, unlike its two siblings, for two reasons
stated in the module comment: it is a scalar that must be able to go DOWN, and — the
important one — `NodeLocalSnapshot.open` **throws** on a present-but-unreadable slot. Here
every failure mode (unreadable, corrupt, foreign party, junk payload) **logs and
cold-starts** to `undefined`, because refusing to start a node over an unreadable *repair
hint* is worse than declaring today's default. Worth confirming you agree with that call —
it is the one place the three records differ, and the comment explicitly asks the next
reader not to "unify" them.

Related: `record()` **never rejects** (the sole caller `void`s it and is contractually
never-rejects), so a failed persist is logged and the in-memory count stands. That makes
the promise weaker than the sibling stores' — check the wording on the interface is honest
about it.

## Use cases to test / validate

- **Cold start is byte-for-byte the old behaviour.** Unknown count ⇒
  `controlClusterPolicy` returns the frozen `CONTROL_CLUSTER_POLICY` *object itself*.
  Asserted by identity (`toBe`) in `cadre-node-control-node-options.spec.ts`, deliberately.
- **Arithmetic:** recorded 5 ⇒ declares 5; recorded 1 ⇒ declares 2 (`MIN_CLUSTER_SIZE`
  floor); recorded 20 ⇒ declares 16 (`CONTROL_REPLICATION_BREADTH` cap). `assumedClusterSize`
  must stay pinned at 2 in every case — the yardstick moves alone.
- **Round-trip:** record, reopen, count survives; a *decrease* survives too.
- **Junk payloads** each cold-start rather than coercing: `'3'`, `0`, `-1`, `2.5`, `null`,
  `true`, an object, a missing key, an array envelope, an unknown version, a foreign
  `partyId`.
- **Unreadable slot resolves rather than throwing**, and the failure is *logged* (asserted
  via debug-sink capture, not just "did not throw").
- **Party isolation:** two parties in one directory keep separate counts.
- **Restart semantics:** the store instance survives `stop()`→`start()`, and the declared
  count is re-read on each start — a spec asserts a count recorded mid-run reaches the
  policy only at the next capture, never mid-process.
- **Write suppression:** an unchanged count skips the slot write (the refresh cadence runs
  on every membership write *and* every reconcile tick), but a write that FAILED is
  retried rather than suppressed as "unchanged". Both asserted.

## Validation actually run

| command | result |
| --- | --- |
| `yarn workspace @serfab/cadre-core test` | 108 files, 1774 passed, 1 skipped |
| `yarn workspace @serfab/cadre-cli test` | 16 files, 232 passed |
| `yarn workspace @serfab/reference-app-rn test` | 10 files, 190 passed |
| `yarn lint` (root) | clean |
| `yarn typecheck` (root) | clean |
| `control-divergent-repair-yardstick` integration | **5 green / 5 runs** |

New specs: 44 in `enrolled-machine-store.spec.ts`, 7 arms added to
`cadre-node-control-node-options.spec.ts`, 4 to the RN `node-local-slots.spec.ts`.

## Known gaps — read before trusting the above

**1. The integration scenario ships as TWO nodes, not the three the ticket specified.**
This is the one place the delivered work departs from the ticket, and not for the reason
the ticket anticipated (harness wiring was small — one `ControlNodeOpts.enrolledMachines`
field plus an `enrolledMachineStoreWith` helper). The three-node version was written and
measured:

- three-node divergent (A=2, B=C=3): **1 green / 4 runs**;
- three-node with the counts made to **AGREE** (3/3/3): **0 green / 4 runs**, same
  fingerprints — so the divergence is not what breaks it;
- existing untouched `control-cohort-three-node-isolation` at the same HEAD:
  **1 green / 3 runs**, identical fingerprint.

Fingerprints seen: boot gate timing out on "C self-publishes its CadrePeer record" (45 s),
boot gate on "B resolves C's signed address record" (45 s), and a commit rejected with
`content-digest-mismatch`. The first two are verbatim the family
`tickets/.pre-existing-known.md` records as red at HEAD on the human-blocked
`control-peer-row-refresh-invisible-to-third-node`. I did **not** file a
`.pre-existing-error.md` for these: they are already listed in `.pre-existing-known.md`
with an in-flight blocked slug, which that ledger says not to re-report.

The two-node scenario proves the same claim — the yardstick is per-node and no node refuses
another anything over it — on the stable `control-db-two-node-convergence` path
(independently verified 3/3 green at HEAD). The reasoning and all the numbers are in the
scenario's file header so the three-node variant can be restored when that family is green.
**A reviewer who disagrees with that downgrade should say so** — it is a judgement call, not
a blocked path.

`content-digest-mismatch` did not appear in `.pre-existing-known.md`'s listed fingerprints
for that family. It reproduced with agreeing yardsticks, so it is not this ticket's, but it
may be a fingerprint worth adding to that ledger.

**2. The RN wiring cannot work end-to-end yet.** `reference-app-rn` does not persist
`opts.partyId` (typed into Settings each launch), so every party-scoped slot loads empty
every launch — the phone will record counts and never read one back until the backlog
ticket `feat-rn-persist-node-start-options` lands. Noted at the code site. The wiring is
there so it starts working the moment the party id persists; it is currently untestable
beyond the slot-level specs.

**3. The live-yardstick assertion reads a private field.** The integration scenario reads
`CoordinatorRepo.repairCorroborationClusterSize` by name, because Optimystic exposes no
getter for it (it does for `effectiveSuperMajorityThreshold`). If upstream renames it the
helper returns `undefined` and the test fails loudly rather than passing vacuously — which
is the intended failure mode, but a reviewer may prefer an upstream getter instead.

**4. Not done, per the ticket's own "Deliberately not done":** no forced restart when the
party grows, no runtime mutation of a live node, no first-launch rebuild. A node picks up a
changed count on its next launch.

**5. Concurrency caveat carried over:** writes are serialised in-process only. Two
processes sharing one slot for one party would each write their own view. Same caveat
`NodeLocalSnapshot` already documents; no backend today shares a slot. Recorded as a
`NOTE:` in the module comment.

## Human action, not code

GitHub issue `gotchoices/sereus#2` is stale — it claims `CadreNode` hardcodes
`clusterSize: 3` and declares no `assumedClusterSize`; neither has been true for some time,
and this ticket closes the remaining gap it was pointing at. Someone should update or close
it and point it at this work.

## Review focus

- The cold-start-instead-of-throw divergence, and the never-rejects `record()` that follows
  from it.
- Whether `refreshAuthorizedControlPeers` recording `size + 1` at size 0 (⇒ 1, which
  declares 2) is right, given `enrolledMachineCount()` reports the same empty set as
  `undefined`. The two are arithmetically equivalent here and the asymmetry is commented at
  the record site, but it is the kind of thing worth a second opinion.
- The two-node-instead-of-three integration downgrade above.
- Whether the unchanged-write skip (keyed off what is believed to be in the slot) has a
  hole: it is what keeps the reconcile cadence from rewriting the same integer forever.
