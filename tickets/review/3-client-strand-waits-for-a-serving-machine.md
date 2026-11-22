description: A machine that stores none of a shared workspace's data can now open that workspace with no other machine reachable — it stays up and keeps trying instead of failing outright, the way a machine joining a workspace already waits for the members it needs.
architecture: docs/strands/lifecycle.md#retries
files: packages/cadre-core/src/control-read-retry.ts, packages/cadre-core/src/strand-instance-manager.ts, packages/integration-tests/src/scenarios/strand-client-node-holds-no-blocks.integration.ts, packages/cadre-core/test/strand-first-sync-gate.spec.ts, packages/cadre-core/test/strand-instance-manager-cluster-size.spec.ts, packages/cadre-core/test/strand-instance-manager-hibernation.spec.ts, packages/cadre-core/test/strand-instance-manager-network-addrs.spec.ts, packages/cadre-core/test/strand-instance-manager-relay.spec.ts, packages/cadre-core/test/strand-instance-manager-storage-ownership.spec.ts, docs/strands/lifecycle.md, docs/strands/formation.md, docs/strands/writes.md, docs/contributing/topology-coverage.md
difficulty: medium
----

# A client strand launch waits for a serving machine instead of failing

A node whose `roles.strandCohortMember` is off (a *client*: it runs a strand through the machines that store it and stores none of its blocks) could not bring a strand's database up with no serving machine reachable. Its own cohort is empty by construction, so `StrandDatabase.initialize()`'s schema-catalog write — and a client founder's membership writes — fell through to `findCoordinator`, which resolved nobody and threw `FindCoordinatorError`. That is a plain `Error` from `@optimystic/db-p2p`, not the `BlockUnavailableError` the existing wait-and-retry arm matched, so the whole launch failed and `StrandWatcher` rebuilt the strand from scratch on a doubling delay capped at five minutes.

Now that failure routes to the arm a joining replica with a silent seed already got: the runtime stays up `'syncing'` with no database, and the database phase alone is retried every 5 s on the same libp2p node.

## What changed

**One predicate.** `isNoCoordinatorResolved` in `packages/cadre-core/src/control-read-retry.ts`, beside `isCohortUnreachableRead`: `FindCoordinatorError` anywhere on the `cause` chain, matched by class over the shared `causeChain`, failing closed on a non-`Error`, a text-only copy, and a second loaded copy of the module. `isCohortUnreachableRead` was NOT widened — its other reader, `ControlDatabase.queryRevokedStamps`, reads an unmatched block as "no revocations known", and the comment there says so.

**One catch arm.** `buildStrandDatabase` now returns the wait outcome when EITHER predicate matches. Everything downstream — `discardDatabaseAttempt`, the runtime staying up, `deferUnreachableJoin`'s timer, `retryUnreachableJoin` building a fresh `StrandDatabase` per attempt — is untouched; the client path simply reaches it for the first time.

**One rename.** The private build outcome `'awaiting-seed'` → `'awaiting-peer'` (5 sites, all inside `strand-instance-manager.ts`), because the peer a client waits for is any serving machine, not a seed. `deferUnreachableJoin` / `retryUnreachableJoin` / `UNREACHABLE_JOIN_RETRY_MS` kept their names and were re-commented to cover all three launches that reach them (joining replica, founder, client); renaming the exported constant would have touched the suite for no gain.

**Six unit specs.** `vi.mock(import('@optimystic/db-p2p'), …)` in six cadre-core specs returned a two-key object, so the new value import broke four of them with `No "FindCoordinatorError" export is defined on the mock`. All six now use the `{ ...actual, createLibp2pNode }` form the backfill / membership / revocation specs in the same suite already use — the class fix, not four instance fixes. `strand-scope-key-validation.spec.ts` keeps its full-replacement mock (no `importOriginal`); it does not reach the predicate, and converting it would load the real module for no present benefit. That is the one landmine still on the board — see Known gaps.

## Tests

| Test | What it verifies |
|---|---|
| `strand-client-node-holds-no-blocks.integration.ts` → "keeps a client up and retries its database until a serving machine is reachable" | The reproduction of this ticket's defect at the lowest layer that reproduces it. A client opens the strand with no machine running it: the launch stays up `'syncing'` with no database and a started strand node; the two serving machines then come up and are dialed; the deferred build publishes the database; the SAME `StrandInstance` and SAME `libp2pNode` prove the watcher did not rebuild; a write then commits and a serving machine reads it. |

No unit test for the predicate, deliberately: a hand-built `FindCoordinatorError` would pin `instanceof` rather than the launch behaviour the predicate exists to produce, and the branch is one `||` over an error class.

**Verified, not inferred:** with `DEBUG='sereus:cadre:strand-manager'` the new test's launch logs `No coordinator available for key (this node is not among the responsible peers and none of them is connected)` — a `FindCoordinatorError` with code `NO_COORDINATOR_AVAILABLE`, which only the NEW predicate matches. The test is not passing through the pre-existing `cohort-unreachable` arm.

## How to exercise it by hand

- `yarn workspace @serfab/integration-tests run test strand-client-node-holds-no-blocks` — both tests, about 60 s.
- Add `DEBUG='sereus:cadre:strand-manager'` to see the wait line and the retry cadence.

## Known gaps — read these before signing off

- **A client that FOUNDS with no serving machine reachable is argued but not tested.** The ticket's reasoning (a client founder's membership writes fail the same way, founding is safe to repeat, each attempt skips the rows already written) is sound by inspection, and `docs/strands/lifecycle.md` now states it, but the scenario covers the JOINING client only. Recorded as a gap in `docs/contributing/topology-coverage.md`, not filed as a ticket. Worth a reviewer's judgment on whether the claim deserves coverage.
- **The predicate matches all four `FIND_COORDINATOR_ERROR_CODES`, not the two the ticket named.** Upstream also defines `SELF_COORDINATION_BLOCKED` and `SELF_COORDINATION_EXHAUSTED`. Matching the class is what the ticket asked for and all four mean "no coordinator was resolved", none means "the block does not exist" — but `SELF_COORDINATION_BLOCKED`'s own upstream comment says "retrying is unlikely to help". Sereus never switches self-coordination off by config (grepped: no such key is ever passed), so it can only arise from a detected partition or suspicious cohort shrinkage, which heals. The behaviour change for a serving node that hits it: a `'syncing'` runtime retrying every 5 s instead of a watcher rebuild on a doubling delay. The reasoning is written at the predicate; a reviewer who disagrees would narrow it to the two codes by `.code`.
- **`strand-scope-key-validation.spec.ts` still has the narrow db-p2p mock.** The next value import from `@optimystic/db-p2p` that its code path reaches will break it with a message naming the mock rather than the cause. Left alone as out of this ticket's scope; converting it means loading the real module there.
- **No test pins the retry cadence.** The integration test waits up to 60 s for the build to land and does not assert how many attempts it took. `UNREACHABLE_JOIN_RETRY_MS` is not exported from `@serfab/cadre-core`'s index, so the scenario cannot name it; the cadre-core unit suite is where that number is pinned.
- **`docs/strands/formation.md`'s first-sync bullet** still says a write on a machine that holds no strand blocks "resolves no coordinator and fails instead of creating a collection". That remains true of an app's write once the database is up — only the LAUNCH's own write now waits. Checked and left as is; a reviewer may read it as stale.

## Validation run

- `yarn build` — clean.
- `yarn typecheck` — clean (475 test files across 10 packages inside their type-check programs).
- `yarn lint` (ESLint + `check-docs`) — clean, 66 Markdown files OK.
- `@serfab/cadre-core` unit suite — 200 files, 2703 passed, 1 skipped. The 4 failures this change caused were fixed by the mock convergence above; nothing pre-existing failed, so `tickets/.pre-existing-error.md` was not written.
- `strand-client-node-holds-no-blocks.integration.ts` — 2 passed, run twice.
