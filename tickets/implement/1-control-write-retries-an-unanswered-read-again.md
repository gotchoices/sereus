description: Under Optimystic 1.20.0, a read inside a control write that no peer answers throws a typed `BlockUnavailableError` instead of the `Some peers did not complete` aggregate, and the control-write retry classifier no longer recognises it, so a write that used to be retried (for example `registerSelf()` while a connection is still forming) now fails on its first attempt. Classify the typed error by type so the write path retries exactly what it retried on 1.19.
architecture: docs/cadre-consistency.md
repro: static
files: packages/cadre-core/src/control-write-retry.ts (`RETRIABLE_CONTROL_WRITE_MATCHERS` ~415, `isUncommittedTransactorAggregate` ~258, `TRANSACTOR_AGGREGATE`/`SINGLE_BLOCK_BATCH_TOKEN` ~147-153, the promise-phase rejection paragraph ~225-247, the `instanceof` veto and its NOTE ~290-313), packages/cadre-core/src/control-read-retry.ts (`RETRIABLE_BLOCK_UNAVAILABLE`, `isRetriableBlockUnavailable` ~117-123), packages/cadre-core/src/control-retry.ts (`causeChain`), packages/cadre-core/test/ (the existing control-write-retry spec), ../optimystic/packages/db-core/src/transactor/network-transactor.ts (read only: `get` ~428-455, `getStatus` ~484-510), ../optimystic/packages/db-core/src/network/struct.ts (read only: `BlockUnavailableError` ~694), ../optimystic/tickets/complete/6.3-network-get-names-unreachable-blocks.md (read only)
----
## The change upstream

Optimystic `6.3-network-get-names-unreachable-blocks` (in 1.20.0): `NetworkTransactor.get` now sorts a block with no entry into one of two cases.

- **Unanswered:** no batch carrying it got any response. The block is returned flagged `unavailable: 'peers-unreachable'`, and whoever reads it (`TransactorSource.tryGet`, `getStatus`, the collection's log-tail readers) throws `BlockUnavailableError(blockId, 'peers-unreachable')` (db-core `network/struct.ts`). Its message is `Block <id> is unavailable (peers-unreachable): the repo could not determine whether it exists`.
- **Omitted:** some coordinator responded but left the block out. This still throws the `Some peers did not complete: …[block:…]` aggregate, as before.

On 1.19, both cases threw the aggregate.

## The gap in Sereus

- **Reads** already handle it: `control-read-retry.ts` retries `RETRIABLE_BLOCK_UNAVAILABLE` (`peers-unreachable | cohort-unreachable`) next to `isUncommittedTransactorAggregate`.
- **Writes** do not. `RETRIABLE_CONTROL_WRITE_MATCHERS` is `[isUncommittedTransactorAggregate, isUnansweredSuperMajorityShortfall]`. A control write re-runs its whole body on each attempt, reads included (`ControlDatabase.withWriteLock`), so the unanswered read is the failure the aggregate matcher was written for: the header names `registerSelf()` racing a connection still forming. On 1.20 that failure arrives as `BlockUnavailableError` and is not retried.

This was found by reading the code (`repro: static`). The spec below confirms the classifier half. Whether the full-network failure actually reaches the write funnel as this error can be confirmed by injecting a cohort-wide read stall in a two-node test. Don't build that test for this ticket; the gate in `adopt-optimystic-1-20-0` runs the degraded-cohort scenarios.

## Design (settled)

**Parity with 1.19, by type.** The write classifier retries a failure whose `causeChain` contains a link `instanceof BlockUnavailableError` with `reason` `'peers-unreachable'` or `'cohort-unreachable'`. That is every case 1.19 retried as a `[block:` aggregate. The existing vetoes run first and are unchanged (`reportsIndeterminateCommit` on `[blocks:`, the possibly-stored `instanceof` veto). Keep the shortfall and aggregate matchers: the omitted case still throws the aggregate.

- **Import the class from `@optimystic/db-core`**, not a deep path, as the existing `instanceof` veto does. Its NOTE (~305) explains why: a second loaded copy makes `instanceof` silently stop matching. If the error ever crosses the network and is rebuilt as a plain `Error`, `instanceof` misses it, and the result is no retry. That fails safe, but say so in a `NOTE:`.
- **One reason list.** The read classifier's `RETRIABLE_BLOCK_UNAVAILABLE` regex and the new write check must not drift apart. Make one exported predicate (by type, with the reason set as one `readonly` constant). Use it in both classifiers, so the read path also moves off text matching. Keep text matching on reads only if a read failure can arrive rebuilt as a plain `Error` (check `retryControlRead` callers). If you keep it, say why in a `NOTE:`.
- **Correct the promise-phase paragraph (~237).** It lists "block-unavailable" among the rejections a cohort member can still return. At 1.20.0, `ClusterMember.judgeStaleRevisions` (`db-p2p/src/cluster/cluster-repo.ts` ~2034) logs `validation-block-unavailable` and continues; it does not reject. Confirm this, and confirm no other member path rejects on it. Then fix the paragraph to describe 1.20.0. A peer's refusal never reaches Sereus as a local `BlockUnavailableError` anyway: it arrives as rejection text inside the shortfall, which `isUnansweredSuperMajorityShortfall` declines whenever rejections are non-zero.

## Edge cases & interactions

- **Own-entry completion reads.** `Collection.completeOwnEntry` calls `transactor.getStatus` to learn whether this node's own earlier attempt landed. If no one answers, it throws `BlockUnavailableError`, and that write may already be stored. On 1.19 the same read threw the `[block:` aggregate, and Sereus retried it, so parity keeps the existing exposure; it does not widen it. Check whether that error reaches the control-write funnel. If it does, is a re-run of the write body safe? Control write bodies re-read and either diff or hit `UNIQUE` (see the `[blocks:` veto's rationale). Record what you found as a `NOTE:` at the new check. File a ticket only if a re-run can double-apply a control write that 1.19 did not already double-apply.
- **`BlockPossiblyStaleError`** (`unconfirmedAheadRev`) is a sibling class thrown by the same reads. It is out of scope: 1.19 did not retry it either (it is not an aggregate). Don't add it.
- **Schema init** (`SCHEMA_INIT_RETRY_POLICY`) builds on `RETRIABLE_CONTROL_WRITE_MATCHERS`, so it gets the new check automatically. That is correct: an unanswered read during `apply schema` is a proven non-commit for the same reason.
- **Budget.** The retry budget and delays are unchanged, so a cohort that stays unreachable still fails after the same bounded time.

## Tests

- One spec in the existing control-write-retry spec: a failure whose cause chain holds `new BlockUnavailableError(id, 'peers-unreachable')` is classed retryable, and the same chain carrying a `[blocks:` aggregate is still vetoed. This pins the branching. Construct the real class from `@optimystic/db-core`, not a mock.
- If the read classifier moves to the shared predicate, its existing specs cover it. Rewrite any spec that builds the error from message text so it builds the class instead.

## TODO

- Add the shared by-type predicate and reason constant; wire it into `RETRIABLE_CONTROL_WRITE_MATCHERS` and the read classifier.
- Verify and correct the promise-phase paragraph against 1.20.0 `cluster-repo.ts`.
- Trace `completeOwnEntry`'s `getStatus` to the control-write funnel; leave a `NOTE:` with the finding.
- Add the spec; run `yarn workspace @serfab/cadre-core test`, `yarn lint`, `yarn typecheck`.
