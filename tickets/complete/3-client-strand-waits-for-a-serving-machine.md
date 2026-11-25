----
description: A machine that stores none of a shared workspace's data can now open that workspace with no other machine reachable — it stays up and keeps trying instead of failing outright, the way a machine joining a workspace already waits for the members it needs.
architecture: docs/strands/lifecycle.md#retries
files: packages/cadre-core/src/control-read-retry.ts, packages/cadre-core/src/strand-instance-manager.ts, packages/cadre-core/test/strand-instance-manager.spec.ts, packages/integration-tests/src/scenarios/strand-client-node-holds-no-blocks.integration.ts, docs/strands/lifecycle.md, docs/cadre/node.md, docs/strands/formation.md, docs/strands/writes.md, docs/contributing/topology-coverage.md
----

# A client strand launch waits for a serving machine instead of failing

A node whose `roles.strandCohortMember` is off — a *client*, which runs a strand through the machines that store it and stores none of its blocks — could not bring a strand's database up with no serving machine reachable. Its own cohort is empty by construction, so every block its launch touches falls through to `findCoordinator`, which resolved nobody and threw `FindCoordinatorError`. That is a plain `Error` from `@optimystic/db-p2p`, not the `BlockUnavailableError` the existing wait-and-retry arm matched, so the whole launch failed and `StrandWatcher` rebuilt the strand from scratch on a doubling delay capped at five minutes.

That failure now routes to the arm a joining replica with a silent seed already got: the runtime stays up `'syncing'` with no database, and the database phase alone is retried every 5 s on the same libp2p node.

## What it does now

**One predicate, one catch arm.** `isNoCoordinatorResolved` in `control-read-retry.ts` matches `FindCoordinatorError` anywhere on the `cause` chain, by class, failing closed on a non-`Error`, a text-only copy, and a second loaded copy of the module. `buildStrandDatabase` returns the wait outcome when either that or the pre-existing `isCohortUnreachableRead` matches. `isCohortUnreachableRead` was deliberately NOT widened: its other reader, `ControlDatabase.queryRevokedStamps`, reads an unmatched block as "no revocations known", and widening it there would widen a security-relevant default.

Everything downstream — `discardDatabaseAttempt`, the runtime staying up, `deferUnreachableJoin`'s timer, `retryUnreachableJoin` building a fresh `StrandDatabase` per attempt — is unchanged; the client path simply reaches it for the first time. The private build outcome `'awaiting-seed'` became `'awaiting-peer'`, because the peer a client waits for is any serving machine rather than a seed.

**Three launches now reach the deferred build**, and `docs/strands/lifecycle.md` → "A launch with nobody to answer waits" is where that is written down: a joining storage replica whose seed is silent, a founder whose cohort is unreachable, and a client with no serving machine reachable. A client cannot found a strand alone at all, because upstream never lets a node that serves no storage coordinate a key however isolated it is — so a party whose only machine is a client has no way to found a strand, and waits for a serving one.

## Tests

| Test | What it verifies |
|---|---|
| `strand-instance-manager.spec.ts` → "keeps a founding client with no serving machine syncing on its running node, retrying only the database" | The reproduction, at the lowest layer that reproduces it: one real node, no peers, `strandCohortMember: false`, founding. The launch stays up `'syncing'` with no database on a started node and reports awaiting-first-sync. Also the only coverage of the FOUNDING client, which the implement pass argued from inspection and left untested. |
| `strand-client-node-holds-no-blocks.integration.ts` → "keeps a client up and retries its database until a serving machine is reachable" | The same contract end to end over a real network: a client opens the strand with no machine running it, two serving machines then come up and are dialed, the deferred build publishes the database, and the SAME `StrandInstance` and `libp2pNode` prove the watcher did not rebuild. A write then commits and a serving machine reads it. |

No unit test for the predicate itself: a hand-built `FindCoordinatorError` would pin `instanceof` rather than the launch behaviour, and the branch is one `||` over an error class.

## Review findings

**Read first, handoff second.** The implement diff (`ticket(implement): client-strand-waits-for-a-serving-machine`) was read before the handoff summary, then the surrounding mechanism (`buildStrandDatabase`, `deferUnreachableJoin`, `retryUnreachableJoin`, `publishDatabase`, `discardDatabaseAttempt`, `isAwaitingFirstSync`) and upstream's `libp2p-key-network.ts` were read to check the claims rather than accept them.

### Fixed in this pass

- **A doc limit that the change itself made false, in the same file it edited.** `docs/strands/lifecycle.md` → "Limits and accepted tradeoffs" still read "A client that can reach no serving machine cannot open a strand, found one included … the launch fails with Optimystic's coordinator error and `addStrand` rejects", and closed by naming `client-strand-waits-for-a-serving-machine` as the ticket that would change it. The implement pass added the new "A launch with nobody to answer waits" section eight lines above and left the entry contradicting it. Rewritten to the behaviour that now exists.
- **`docs/cadre/node.md` described the pre-fix behaviour** and pointed readers at that limits entry for "what a launch does then". Repointed at the new section and told that such a launch waits.
- **"The schema-catalog write" is the wrong operation.** The new unit test's stack shows the first failure is a READ: `Tree.open` → `Collection.open` → `probeHeader` → `NetworkTransactor.get` → `findCoordinator`. The catalog is opened before anything is written to it. Corrected in `lifecycle.md`, the `deferUnreachableJoin` docstring, and the integration scenario's header comment, which also cited a stale heading (→ "Retries") for the section it means.
- **A publish log line that is false on the new path.** `publishDatabase` logged "Strand %s is now writable: Strand.Header held". A client holds no blocks and no Header; a deferred build publishes because the database opened. The suffix was also a duplicate — the first-sync gate logs what its probe found immediately before calling into this. Reason dropped, with a comment saying why.
- **Six copies of one five-line comment, where the suite already had one home for it.** The mock-widening comment was pasted into all six converted specs. The same suite's convention is the backfill spec carrying the explanation and the others saying "see the backfill spec for why the rest of db-p2p stays real" (which is what `strand-instance-manager-revocation.spec.ts` does). Condensed to that form, with the new reason (cadre-core value-imports `FindCoordinatorError`) added once, in the backfill spec.
- **The last narrow db-p2p mock, flagged as a known landmine and left.** `strand-scope-key-validation.spec.ts` kept a full-replacement mock exposing only `createLibp2pNode`, so the next value import its code path reaches breaks it with a message naming the mock rather than the cause. It survives today only because Vite resolves an unused named import lazily. Converted to the partial-mock form the other eight specs use; the stated cost (loading the real module) is already paid by every one of them.
- **`RETRY_LADDER_BUDGET_MS`** named a fixed 5 s cadence a ladder. Renamed `DEFERRED_BUILD_BUDGET_MS`.

### Recorded, not filed

- **Matching `FindCoordinatorError` by class admits `SELF_COORDINATION_BLOCKED`, whose upstream comment says retrying is unlikely to help.** The implement pass argued this at the predicate and flagged it for a reviewer. The argument holds and is now stated as a greppable `NOTE:` there with what it costs and when to narrow it: only a SERVING node can hit that code at all (a client is never a candidate coordinator, so it gets `NO_COORDINATOR_AVAILABLE`), Sereus passes no config switch for self-coordination, and the remaining causes — a detected partition, suspicious cohort shrinkage — heal. Narrow to `.code` if either of those stops being true.
- **`docs/cadre/node.md` is at its 6,000-word budget.** The 19-word correction above took it to 6,015 and failed `yarn lint`; it only landed because it was rewritten shorter than the sentence it replaced. Filed as `debt-cadre-node-doc-at-its-word-budget` — not conditional (it blocked an edit in this pass), and it blocks whoever edits that document next, with a failure naming a size rule instead of their change.
- **`strand-instance-manager.ts` is 2,805 lines** (`wc -l`), up from the 1,978 recorded at the last review of this mechanism. Appended as an arm to the existing `debt-cadre-node-single-file-size`, per one-ticket-per-class: the growth here was one predicate call plus about 60 lines of comment re-stating a mechanism that spans six non-adjacent methods, which is the cost the size imposes.

### Checked and found sound

- **The behaviour change beyond the ticket's stated scope.** The new arm also catches `FindCoordinatorError` on a serving joiner or founder, which previously failed the launch. Traced upstream: a serving node is a candidate coordinator for keys it is responsible for, so it can only reach this through the two self-coordination codes, whose causes heal. The "keep the node, retry the database" tradeoff is the one already accepted for the seed case, not a new one.
- **Resource cleanup across unbounded retries.** Each attempt builds a fresh `StrandDatabase` and `StrandFirstSyncGate`; `discardDatabaseAttempt` stops the gate, drops it only if still registered, and closes the database. The timer is `unref()`ed and cleared by `releaseRuntime`, so a stop or quiesce cancels it, and `retryUnreachableJoin` re-checks current-runtime, database-present, gate-present and quiescing before doing anything.
- **The `addStrand` contract the docs now promise.** `isAwaitingFirstSync` is "node up, no database", which a deferred client satisfies, so `whenWritable` waits and rejects with the retryable `StrandAwaitingFirstSyncError` as claimed — not merely asserted in the docs.
- **The new value import crosses no boundary.** `@optimystic/db-p2p` is already value-imported by `cadre-node.ts`, `link-budget.ts`, `peer-join-backfill.ts` and `strand-instance-manager.ts`, so no bundle or platform reach changes; the vite static/dynamic warning gains a filename in a list it was already on.
- **No upstream helper was duplicated.** Nothing in db-p2p or db-core classifies `FindCoordinatorError` for a caller; `.code` exists for `NetworkTransactor`'s own batch retry.

### Declined

- **Renaming `UNREACHABLE_JOIN_RETRY_MS` / `deferUnreachableJoin` / `retryUnreachableJoin` / `unreachableJoinRetries`**, now that a founder and a client reach them too. The implement pass weighed this and kept the names. Agreed: "join" reads as attaching to the strand, which all three launches are doing, and the rename touches about 20 sites across source, specs and docs for no behaviour change. The comments at each site now name all three launches.
- **`docs/strands/formation.md`'s first-sync bullet**, flagged in the handoff as possibly stale. It says a machine holding no strand blocks is not gated because a write with no serving machine reachable resolves no coordinator rather than creating a collection. That is an argument about why the gate is unnecessary, and it is still true of an app's write once the database is up. Left as is.
- **A second unit test for the joining client**, alongside the founding one added above. The integration scenario already covers the joining client end to end, including the parts a unit test cannot reach (the dial, the real build on a running node, the write committing through a serving machine). One test per behaviour.

### Not found

- No defect in the predicate, the catch arm, or the retry loop. No leak, no unhandled rejection, no swallowed exception: a failure matching neither predicate still throws and still fails the launch, which is what matching two error classes by type buys over reading a message.

## Validation

- `yarn build`, `yarn typecheck` (475 test files across 10 packages inside their type-check programs) and `yarn lint` (ESLint + `check-docs`, 66 Markdown files) — all clean.
- `@serfab/cadre-core` unit suite — 200 files, 2,704 passed, 1 skipped.
- `strand-client-node-holds-no-blocks.integration.ts` — 2 passed (6.4 s and 8.8 s).
- **The new unit test was verified to reproduce**, not just to pass: with the `isNoCoordinatorResolved` arm removed it fails in 191 ms with `FindCoordinatorError: No coordinator available for key (this node is not among the responsible peers and none of them is connected)`, which is the defect this ticket fixes.
- Nothing pre-existing failed, so `tickets/.pre-existing-error.md` was not written.
