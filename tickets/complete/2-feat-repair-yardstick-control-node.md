description: The control network now sizes its block-repair check from the number of machines in the group, by remembering that number on disk between runs instead of asking a database that does not exist yet.
files: packages/cadre-core/src/enrolled-machine-store.ts, packages/cadre-core/src/enrolled-machine-store-file.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/types.ts, packages/cadre-core/src/index.ts, packages/cadre-core/src/node-local-snapshot.ts, packages/cadre-core/src/file-durable-slot.ts, packages/cadre-core/test/enrolled-machine-store.spec.ts, packages/cadre-core/test/cadre-node-control-node-options.spec.ts, packages/cadre-cli/src/commands/start.ts, packages/reference-app-rn/src/cadre-phone.ts, packages/reference-app-rn/src/node-local-slots.ts, packages/reference-app-web/src/lib/cadre-web.ts, packages/reference-app-web/src/lib/node-local-slots.ts, packages/reference-app-ns/src/cadre-phone.ts, packages/reference-app-ns/src/node-local-slots.ts, packages/integration-tests/src/harness/node-fixtures.ts, packages/integration-tests/src/scenarios/control-divergent-repair-yardstick.integration.ts, docs/architecture.md
----

# Complete: control node declares its repair yardstick across a restart

## What landed

`CadreNode.buildControlNodeOptions` runs before `createControlNode()`, which runs before the
`ControlDatabase` holding the `CadrePeer` membership rows exists — so at the one moment the
enrolled-machine count is needed, nothing can answer it, and the control network declared no
block-repair yardstick at all. That deadlock is broken by remembering the number across the
restart.

- **`enrolled-machine-store.ts`** — `EnrolledMachineStore` (`count()` / `record()`),
  `MemoryEnrolledMachineStore`, `PersistentEnrolledMachineStore` over a `DurableSlot`, envelope
  `{ version: 1, partyId, enrolledMachines }`.
- **`enrolled-machine-store-file.ts`** — `FileEnrolledMachineStore` behind the
  `@serfab/cadre-core/enrolled-machine-store-file` subpath, keeping `node:fs` out of the
  browser/React Native graph.
- **`CadreNodeConfig.enrolledMachines`** — injected store; omitted means an in-memory store, so a
  node that wires nothing behaves exactly as it did before this record existed.
- **`CadreNode`** — `initializeEnrolledMachineStore()` runs inside `start()` before
  `createControlNode()` and captures the count; `buildControlNodeOptions` passes it through
  `controlClusterPolicy`; `refreshAuthorizedControlPeers` records `authorizedControlPeers.size + 1`
  for the next launch.
- **Embedders** — all four that open the sibling node-local records now wire this one:
  `cadre-cli` (file-backed, node state directory), `reference-app-rn` (LevelDB),
  `reference-app-web` (the control IndexedDB `kv` store), `reference-app-ns` (the identity SQLite
  `kv` table). `cadre-host` opens none of these records and needed nothing.

A node therefore declares what it last knew and applies a changed number on its next launch, never
mid-process. Raising the number is the safe direction, so the next natural restart is soon enough
and there is no forced rebuild.

## Review findings

### Checked and found nothing to change

- **The cold-start-instead-of-throw divergence.** The implement handoff flagged this for a second
  opinion: unlike the trusted-owner anchor and the bootstrap-peer store, an unreadable slot here
  logs and cold-starts rather than throwing. Agreed with the call and left alone. Nothing in this
  record is trust-bearing, it is recomputed the moment the control database is up, and refusing to
  start a node over an unreadable repair *hint* is worse than declaring today's default. The
  never-rejecting `record()` follows from the same reasoning and its sole caller leaves the promise
  un-awaited, so a rejection would surface as an unhandled rejection in the embedder's process.
- **The unchanged-write skip.** Walked the write chain's state machine for a hole, as the handoff
  asked. There is none: `persisted` only advances after a successful save (so a failed write is
  retried, not suppressed), and `persistCurrent` re-reads the settled count when its link of the
  chain runs rather than capturing the value it was queued for (so a burst collapses and a
  reverted value cannot leave the belief lying). The one interleaving no test reached is now
  covered — see below.
- **The two-node-instead-of-three integration scenario.** Agreed with the downgrade. The three-node
  control-write family is red at HEAD on a tracked, human-blocked ticket
  (`control-peer-row-refresh-invisible-to-third-node`), recorded in
  `tickets/.pre-existing-known.md` with the same fingerprints the handoff measured; a fourth flaky
  file there would bury this scenario's signal. The two-node version proves the claim under test —
  that per-node yardsticks do not interfere — and ran green on every run here.
- **The private-field read in the integration scenario.** `repairCorroborationClusterSize` has no
  upstream getter, and reading it by name fails loudly rather than vacuously if upstream renames
  it. Left as is; an upstream getter would be an improvement but is not this repo's to add.
- **Not filed as a `.pre-existing-error.md`.** The three-node failures the handoff measured are
  already listed in `tickets/.pre-existing-known.md` against an in-flight blocked slug, which that
  ledger says not to re-report. The `content-digest-mismatch` fingerprint the handoff saw is not
  listed there, but it reproduced with agreeing yardsticks and was not reproduced in this pass, so
  no unverified fingerprint was added to a shared ledger on hearsay.

### Fixed in this pass

- **The write half of the feature had no test at all.** Every spec covered reading the count back;
  nothing proved a running node *records* one. The `record()` call in `refreshAuthorizedControlPeers`
  could have been deleted and the whole repo would still have gone green, with the yardstick simply
  never advancing in the field. The existing two-node integration scenario now asserts both nodes'
  records end to end after a real membership write — the only place this is reachable, since it
  needs a real control database with real vouched rows.
- **One uncovered write-chain interleaving**: recording a value back to what the slot already holds
  while a write for a different value is still chained. Added to
  `enrolled-machine-store.spec.ts`; it passes, and it now pins the behaviour that makes the skip
  safe.
- **Two of the four embedders that open the sibling node-local records were never wired** —
  `reference-app-web` and `reference-app-ns`. The ticket enumerated only `cadre-cli` and
  `reference-app-rn` and asserted `cadre-host` needed nothing, which read as a complete list but
  was not one. No regression (an unwired embedder just declares nothing), but the feature silently
  did not apply to half the apps that could carry it. Both are now wired with their own slot keys,
  plus key-shape and composition specs; the web app is the one embedder where this works end to
  end today, since it persists its party id.
- **`packages/reference-app-ns/test/cadre-phone.spec.ts` pins the exact set of node-local keys read
  during start** — a good assertion, and it caught the NS wiring immediately. Updated to three keys.
- **Stale comments at the files this change gave a new consumer**, none of which the implement pass
  touched: `file-durable-slot.ts` listed two importers; `node-local-snapshot.ts` described itself as
  the machinery every node-local record uses and its `DurableSlot` contract read as though every
  reader must rethrow; `docs/architecture.md` enumerated "both node-local records" in three places.
  All corrected, and `DurableSlot`'s contract now says explicitly that reporting the fault is the
  slot's job while what a reader does with it is the reader's policy — otherwise the next reader
  meets this record and thinks the seam's contract was violated.
- **The justification comment at the record site was incomplete.** It defended recording an empty
  membership snapshot as 1 on the grounds that 1 and "unknown" are equivalent — true, but not the
  reason. The real reason is that a party which genuinely shrinks must be able to bring the number
  back DOWN, because over-declaring is the unsafe direction (at a yardstick of 3 or more a cohort
  that can field one peer can never repair). Rewritten to say that, with the cost stated (see the
  tripwire below).

### Tripwires recorded, not filed

- **A transient empty membership read overwrites a good remembered count with 1.** A snapshot is
  legitimately empty early in a run — rows not replicated yet, or a trusted-owner anchor not yet
  seeded — and recording an empty set as 1 is deliberate (above). The cost is bounded and safe: the
  next refresh re-records the real count, and the only node that loses anything is one stopped
  inside that window, which then declares 2 on its next launch — today's behaviour. Parked as a
  `NOTE:` at the record site in `cadre-node.ts`, naming the fix if a node ever needs the right
  number on its first post-restart launch (distinguish "no rows yet" from "no members" there;
  do not skip empty). The integration scenario now exhibits this concretely and says so.
- **Two same-origin browser tabs share one slot.** The module's concurrency `NOTE:` claimed no
  backend shares a slot — true until the web app was wired here, where both tabs use one IndexedDB
  key. Updated in place rather than filed: unlike the sibling records, this value is one integer
  both tabs re-derive from the same rows on their next refresh, so the views reconverge instead of
  losing an entry nobody rewrites.

### Filed

- `tickets/blocked/close-stale-github-issue-2-cluster-size.md` — carried forward from the implement
  handoff. GitHub issue `gotchoices/sereus#2` describes a hard-coded replication number and a
  missing group-size declaration; neither has been true for some time, and this work closed the last
  gap it pointed at. Editing a public issue needs tracker access, so it is a human's, not a stage's.

No `fix/`, `plan/` or `backlog/` tickets were filed. Nothing found in this pass was a defect in the
delivered code: the two real gaps (untested write half, two unwired embedders) were small, bounded
and mechanical, so they were closed here rather than queued.

### Known gaps carried forward unchanged

- **React Native cannot work end to end yet.** The app does not persist `opts.partyId`, so every
  party-scoped slot loads empty each launch. Gated on the backlog ticket
  `feat-rn-persist-node-start-options`. The same is true of the NativeScript app now wired here, and
  both are noted at their code sites and in `docs/architecture.md`.
- **Deliberately not done, per the original ticket**: no forced restart when the party grows, no
  runtime mutation of a live node, no first-launch rebuild. Optimystic freezes the policy at node
  construction and offers no setter.
- **Writes are serialised in-process only** — the same caveat `NodeLocalSnapshot` documents.

## Validation

Everything below run in this review pass, after the fixes above.

| command | result |
| --- | --- |
| `yarn lint` (root) | clean |
| `yarn typecheck` (root) | clean |
| `yarn workspace @serfab/cadre-core test` | 108 files, 1775 passed, 1 skipped |
| `yarn workspace @serfab/cadre-cli test` | 16 files, 232 passed |
| `yarn workspace @serfab/reference-app-rn test` | 10 files, 190 passed |
| `yarn workspace @serfab/reference-app-web test` | 3 files, 66 passed |
| `yarn workspace @serfab/reference-app-ns test` | 5 files, 103 passed |
| `control-divergent-repair-yardstick` integration | 6 green / 6 runs (3 before the added assertions, 3 after) |

The full `@serfab/integration-tests` suite was not run: its three-node control-write family is
red at HEAD on tracked blocked tickets, so a full run measures that family rather than this work.
