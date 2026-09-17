description: A machine that is cut off from every other machine in its party cannot look up any member or peer while the party has never recorded a revocation, because "nobody has written that list yet" and "I can't reach anyone to ask" produce the same error. Treat that specific case as "no revocations known" so an isolated machine keeps working from what it holds.
prereq:
files: packages/cadre-core/src/control-database.ts, packages/cadre-core/src/control-read-retry.ts, packages/cadre-core/test/control-read-retry.spec.ts, packages/cadre-core/src/cadre-node.ts, packages/integration-tests/src/scenarios/control-cohort-edge-carries-data.integration.ts, tickets/blocked/control-read-over-fresh-edge-stream-resets.md, tickets/.pre-existing-known.md
difficulty: medium
repro: verified
----

# An isolated node reads the never-written Revocation table as "no revocations"

## What happens

Every membership and peer-record read in cadre-core first reads the revoked stamps for that table (`ControlDatabase.queryRevokedStamps`, `control-database.ts:1054`: `select StampId from CadreControl.Revocation where TableName = ?`). Callers: `queryCadrePeers` (`:902`), `queryPeerRecord` (`:1113`), and the `DeviceToken` path in `cadre-node.ts:3869`.

The `Revocation` table is empty in practice. Until someone writes a row to it, its storage block does not exist on any machine. The ledger marker (`openRevocationLedger`, `control-database.ts` ~2110; filed by `CadreNode.openRevocationLedgerIfDue` in `runReconcileControlCohort`) exists to make the block exist, but it is filed only by an owner, only on a reconcile pass that holds a control connection (15 s cadence by default). There is an accepted-tradeoff `NOTE:` there declining to file it while solo, for fork safety.

When a node reads a block it does not hold, optimystic asks the block's cohort. If no other cohort member can be reached, the answer is `BlockUnavailableError { reason: 'cohort-unreachable' }` ("could not determine whether it exists"), which Quereus surfaces as `Error during query on table 'Revocation': Query failed: Block default/cadrecontrol/Revocation is unavailable (cohort-unreachable)…`. The typed error is now preserved on the `cause` chain (the run below shows `Caused by: BlockUnavailableError`), though `control-read-retry.ts` still classifies by message text and its module comment claims the cause is destroyed. Check which is true before choosing a matcher.

Result: **an isolated node that never received the Revocation block cannot answer any membership or peer lookup at all**, even though it holds the `CadrePeer` rows locally. The live-read `Tree.update()` refresh in `OptimysticVirtualTable.runQuery` is where it raises. This is a product defect, not just a test artifact: a phone that joins a young party and loses its network before the owner's first connected reconcile pass hits it on every lookup.

Upstream (`../optimystic`, `db-core/src/transactor/network-transactor.ts` ~255) documents `cohort-unreachable` as "the one reason a caller may treat permissively (the answering node reached nobody, so its own view is all it has)". Sereus never adopted that treatment.

## Reproduction (2026-09-16, optimystic at `3a4e7f7d`)

From `packages/integration-tests`: `yarn vitest run src/scenarios/control-cohort-edge-carries-data.integration.ts`

- Run 1: failed at 13 s with the fingerprint above. It fails in step 4, the negative window. B is severed about 2 s after the trio boots, before A's first connected reconcile pass, so the marker was never filed. `DEBUG=sereus:cadre:node` shows no `revocation ledger marker` line in the whole run. The window's `B.resolvePeerAddrs(cPeerId)` read → `queryPeerRecord` → `queryRevokedStamps` throws. The scenario tolerates only `Self-coordination blocked`, the pre-`cohort-unreachable` shape of the same condition, and rethrows everything else.
- The same fingerprint is recorded as deterministic in `tickets/.pre-existing-known.md` and `tickets/blocked/control-read-over-fresh-edge-stream-resets.md` going back to 2026-08-20.

**Experiment (reverted):** I wrapped the `readRows` call in `queryRevokedStamps` so that a message matching `is unavailable (cohort-unreachable)` returned an empty set, rebuilt cadre-core, and ran the scenario three times. **2 passed (14.7 s, 19.2 s), including the carry step (R1 observed on B across the B→C edge).** The third run failed at an unrelated earlier assertion (B already connected to C before the sever, `:217`), which is now `fix/control-trio-b-connects-to-c-before-sever`. So the carry step this scenario exists for works once this read stops throwing.

**Committed-read experiment (the one the fix ticket suggested): not run, and not recommended as the fix.** A committed read never refreshes from the network (`optimystic-module.ts` ~1206). Falling back to it for the whole query hides fresh `CadrePeer` rows as well as the missing Revocation block. `readRowsOnce`'s own doc records that routing every read committed broke `control-write-degraded-cohort-member` 2 of 2. The permissive treatment above is narrower: it answers only the question nobody can answer, and only for the one table where an empty answer is the known-empty case.

## Why "no revocations known" is safe enough here, and where it must not spread

- A revocation authored elsewhere that has not replicated to this node is invisible to it whether or not the node holds the block. A present but stale Revocation block on an isolated node is served silently: the consult reaches nobody (`no-evidence`), so no doubt flag is raised. The missing-block case therefore adds no new fail-open. It removes a hard failure that the stale-present case never had.
- `cohort-unreachable` specifically means no other cohort member could be asked, so no better answer exists until connectivity returns. `peers-unreachable` (some of the cohort answered), `claimed-elsewhere` (a peer says the block exists) and `unmaterializable` must **still throw**. Those say a revocation list exists somewhere, and treating it as empty would admit revoked members.
- **Do not add this to the `readRows` funnel generally.** Scope it to `queryRevokedStamps`. Other tables' reads keep their current behaviour. If another never-written table is found failing the same way on an isolated node, decide it per table in its own code, with its own reasoning.
- Leave a `NOTE:` at the site covering: what is treated permissively (cohort-unreachable on the Revocation read only), why (it is equivalent to a stale held block, and upstream designates the reason as permissive), and the revisit condition (if optimystic ever reports a held-but-stale block distinctly, or if revocation enforcement must fail closed under partition).

## Related, not in scope

- Filing the ledger marker inside the founding (genesis) write would make the block exist before any machine can be isolated. The accepted-tradeoff `NOTE:` in `runReconcileControlCohort` names this as its revisit condition. It would not help a joiner that is partitioned before it first pulls the block, so the read-side treatment is needed regardless. Do not change the marker timing in this ticket.
- `every-membership-lookup-reads-an-empty-revocation-table` (landed as the ledger marker) covered the cost side of the same read.
- Retry interaction: `retryControlRead` already retries `cohort-unreachable` within its 1.5 s budget (`CONTROL_READ_RETRY_BUDGET_MS`). The permissive treatment applies after that retry gives up, so an isolated node pays up to about one budget per Revocation read before answering. Fine for now; add a `NOTE:` tripwire if the admission gate's 2 s fail-open deadline looks threatened (`queryPeerRecord` does two reads).

## TODO

- Add a classifier next to `isRetriableControlReadFailure` in `control-read-retry.ts`, e.g. `isCohortUnreachableRead(error)`. Walk the `cause` chain. Prefer `instanceof BlockUnavailableError` / `reason === 'cohort-unreachable'` if the typed error reaches sereus, otherwise the message template. Fail closed. Correct the module comment if the cause is in fact preserved now.
- In `ControlDatabase.queryRevokedStamps`, catch only that classification: log it (debug) and return an empty set. Rethrow everything else. Add the `NOTE:` described above.
- Unit tests in cadre-core: `queryRevokedStamps` returns empty on a rigged `cohort-unreachable` read failure, and still throws on `peers-unreachable`, `claimed-elsewhere` and an unrelated error. Follow the interposition style in `control-read-retry.spec.ts` / `control-revocation-ledger-marker.spec.ts`. Add classifier tests alongside the existing ones.
- Scenario `control-cohort-edge-carries-data.integration.ts` step 4: with the fix, the window's `resolvePeerAddrs` should succeed. Keep the `isSelfCoordinationBlocked` tolerance only if that shape can still occur. Update the step-4 comment to name the Revocation cause.
- `yarn workspace @serfab/cadre-core build`, then run the scenario at least 3 times. Expect `cohort-unreachable` never to appear. The `:217` pre-sever connection failure is tracked separately and is not a reason to hold this ticket.
- Run `yarn typecheck`, `yarn lint`, and the cadre-core test suite.
- Update `tickets/.pre-existing-known.md` entries that attribute `control-cohort-edge-carries-data` to `cohort-unreachable`. Append a note to `tickets/blocked/control-read-over-fresh-edge-stream-resets.md` saying the masking failure is resolved and its own re-run can now proceed.
- Update the membership/revocation section of `docs/cadre-consistency.md` (or wherever revocation reads are documented) with the isolated-read behaviour.
