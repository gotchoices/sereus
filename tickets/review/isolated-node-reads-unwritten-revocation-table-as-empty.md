description: A machine cut off from every other machine in its party could not look up any member or peer while the party had never recorded a revocation. The revocation lookup now treats "nobody reachable to ask about a list nobody here holds" as "no revocations known", so an isolated machine keeps answering from what it holds. Ready for review.
prereq:
files: packages/cadre-core/src/control-read-retry.ts, packages/cadre-core/src/control-database.ts, packages/cadre-core/test/control-read-retry.spec.ts, packages/cadre-core/src/control-retry.ts, packages/cadre-core/src/control-write-retry.ts, packages/cadre-core/test/control-write-retry.spec.ts, packages/cadre-core/src/strand-watcher.ts, packages/integration-tests/src/scenarios/control-cohort-edge-carries-data.integration.ts, docs/architecture.md, tickets/.pre-existing-known.md, tickets/blocked/control-read-over-fresh-edge-stream-resets.md, tickets/fix/control-trio-b-connects-to-c-before-sever.md
difficulty: medium
----

# Isolated node reads the never-written Revocation table as "no revocations"

## The defect

Every membership, peer-record and device-token lookup first reads the retired stamps for its table from `CadreControl.Revocation` (`ControlDatabase.queryRevokedStamps`). That table has no storage block anywhere until someone writes to it, and the owner's ledger marker (`openRevocationLedger`) is filed only on a connected reconcile pass. A machine isolated before it ever received the block asked the storage layer about a block it does not hold, reached no other cohort member, and got `BlockUnavailableError { reason: 'cohort-unreachable' }`. So every lookup threw, even though the machine held the `CadrePeer` rows locally.

## What changed

- **`isCohortUnreachableRead(error)`** (`control-read-retry.ts`): true only when the `cause` chain holds a `BlockUnavailableError` whose `reason === 'cohort-unreachable'`. It matches by type (`instanceof`) and walks the chain itself, guarding against a cyclic chain. Text alone, a non-Error, and any other reason all answer false. It is not a retry classifier.
- **`ControlDatabase.readRevokedStampRows`** (private, behind `queryRevokedStamps`): runs the normal read with the normal retry (or none, when `retry: false`). If the read still fails and the classifier matches, it logs at debug and returns no rows. Anything else is rethrown. It carries two `NOTE:`s: the accepted tradeoff (what, why, revisit condition) and a timing tripwire about the admission gate's 2 s deadline.
- Scope is deliberately this one read. `queryRevocations` (the full enumeration used by the reap and re-issue sweeps) and every other table's reads are unchanged. A unit test pins that `queryRevocations` still throws.
- **Verified: the typed error does reach sereus.** Upstream now rethrows through `rewrapAsQueryError` (keeps `cause`), and Quereus' scan wrapper keeps `cause` too. The `instanceof` match fired in the real integration runs (debug line `revoked-stamps(CadrePeer): no cohort member reachable…`). The comments that said the typed error is destroyed (`control-read-retry.ts` module comment, `chainMessages` in `control-retry.ts`, `SELF_COORDINATION_GRACE_REFUSAL` in `control-write-retry.ts`, and two spec comments) are corrected. The text-based retry classifiers themselves were left as they are.
- Scenario `control-cohort-edge-carries-data` step 4: comment rewritten to name the Revocation cause. The `isSelfCoordinationBlocked` tolerance is kept because upstream `findCoordinator` still raises that refusal as a hard denial for some intents, though it was not seen in any run (`selfCoordBlocked=0` in both runs that got through the window).
- `strand-watcher.ts` poll catch: a `NOTE:` recording that the never-written `Strand` table fails the same way on an isolated node (seen in the scenario logs), why that is harmless there, and why it must not be answered as empty (the removed-strand loop would stop strands).
- Docs: `docs/architecture.md`, `Revocation` row of the control-table list, gains the isolated-read behaviour.
- Tickets: `.pre-existing-known.md` gets a dated delta and a re-attributed list entry. `blocked/control-read-over-fresh-edge-stream-resets` gets a note that the masking failure is gone. `fix/control-trio-b-connects-to-c-before-sever` gets an arm (below).

## Validation done

- `yarn workspace @serfab/cadre-core build`, `yarn typecheck` (repo-wide) and `yarn lint`: all clean.
- New unit tests in `control-read-retry.spec.ts`, all passing:
  - classifier: a typed `cohort-unreachable` matches, whether nested or bare; `peers-unreachable`, `claimed-elsewhere`, `unmaterializable`, `BlockPossiblyStaleError` and cohort-unreachable text with no typed error do not; non-Errors and a cyclic chain answer false.
  - `ControlDatabase` with `eval` rigged to fail during iteration: `queryRevokedStamps` returns an empty set after exactly `CONTROL_READ_ATTEMPTS` attempts. `queryCadrePeers()`, `queryCadrePeers(false)` and `queryPeerRecord` return a freshly inserted row. The other three reasons and an unrelated error still reject with the original error object. `queryRevocations` still rejects on `cohort-unreachable`.
- Full cadre-core suite: 2167 passed, 5 failed. All 5 are listed in `.pre-existing-known.md` under the blocked `warm-restart-into-declared-schema-diverges-from-declaration` (`context.OwnerKey isn't a column` on warm restart), so they are not re-reported.
- Integration scenario, 9 isolated runs (`packages/integration-tests`: `npx vitest run src/scenarios/control-cohort-edge-carries-data.integration.ts`):
  - **2 passed, carry step included.** No run failed on `cohort-unreachable`.
  - 6 failed because B held a connection the test forbids: 2 before the sever (`:217`), 3 at the first window checkpoint where a temporary diagnostic showed B **outbound to C**, and 1 where B never reached zero connections after the sever.
  - 1 failed on the known boot gate (`control-peer-row-refresh-invisible-to-third-node`).
  - In the debug runs that failed at the window, no permissive Revocation read had happened yet and no B-side reconcile pass logged a dial, so these connections are not caused by this change. They are appended as an arm on `fix/control-trio-b-connects-to-c-before-sever`. Logs: `tickets/.logs/isolated-revocation-run{1..9}.log` (pruned by the runner eventually).

## For the reviewer: known gaps and things to challenge

- **A new side effect worth checking.** Before this change, any reconcile pass on an isolated node aborted at the membership read. It now gets past that read and can reach the dial step, dialling siblings from their signed records. That is the intended production behaviour, since it is how an isolated node reconnects. But it is also the step-4 `NOTE:` suspect for the scenario (a `self:peer:update`-triggered reconcile on B during the window). It was not the cause in the runs measured, and the note is recorded on the fix ticket.
- **Timing.** On the isolated node, the time from the first failed attempt to the permissive answer ranged from about 0.5 s to 1.4 s in run 1 (read from debug timestamps; the first attempt's own duration was not captured). `queryPeerRecord` then runs its `CadrePeer` scan on top. This has not been measured against the admission gate's 2 s fail-open deadline; the tripwire `NOTE:` sits on `readRevokedStampRows`. Before this change the gate got a throw on this path, which also fails open, so the gate is no worse off.
- **`instanceof` across package copies.** If a bundler ever loads two copies of `@optimystic/db-core`, the typed match stops firing and isolated lookups throw again. That is fail-closed, the same as before this change. The doc comment on `isCohortUnreachableRead` says so. No test covers a bundled (Metro, React Native) build.
- **No end-to-end test of the product case outside this scenario.** A phone that joins a young party and loses its network before the owner's first connected reconcile pass is covered only by the unit rig and by this scenario's step-4 window.
- **`Strand` is also never written on an isolated node** and its read fails the same way. That was judged harmless and left throwing (NOTE at the site), not filed. Challenge that if another reader of `Strand` treats a throw badly.
- The `NOTE: accepted tradeoff` wording on `readRevokedStampRows` records the decision this ticket specified. Confirm it states what you would want the next reviewer to respect.
