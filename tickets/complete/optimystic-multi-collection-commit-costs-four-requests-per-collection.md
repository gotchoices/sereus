description: An Optimystic transaction that touched several collections (a table plus its index or UNIQUE trees, or several tables) used to cost about 4 requests per collection against the other cohort member. Optimystic 1.19.0 sends all of a transaction's collections in one request per member per phase, and Sereus's two membership commits on a strand join now cost 6 requests between them instead of 20.
architecture: docs/cadre-consistency.md#deadlines-below-cadre
files: packages/integration-tests/src/scenarios/message-cost-accounting.integration.ts (2026-10-25 block), packages/cadre-core/src/strand-membership-reconciler.ts (the two-commit NOTE in `attempt`)
repro: verified
----
# A transaction over several collections cost about 4 requests per collection

**Resolved by Optimystic 1.19.0** (gotchoices/Optimystic#42, upstream `a-transaction-pends-and-commits-its-collections-together`), adopted by `adopt-optimystic-1-19-0`. The receiving half (`IRepo.pendMany` / `IRepo.commitMany`) shipped in 1.17.0. 1.19.0 adds the sending half: the writer's transactor sends a transaction's pends for every collection one coordinator covers as one request, and the same for its commits. Upstream measured a one-row insert into a table with five indexes, on a two-machine group, at 3 cluster requests instead of 24.

## Measured in Sereus

`MESSAGE_COST_MEASURE=1 yarn workspace @serfab/integration-tests exec vitest run message-cost-accounting`, all three cases, one run on 2026-10-25 (log `tickets/.logs/adopt-optimystic-1-19-0.cost.log` until pruned; the table is in the scenario's doc comment):

| strand case | 2026-10-20 (Optimystic 1.17.0) | 2026-10-25 (1.19.0) |
|---|---|---|
| settle 15 s, `cluster` B->A | 20 | 6 |
| B first insert, `cluster` B->A | 4 | 4 |
| one steady write, `cluster` | 4 | 4 |

The settle window's `cluster` streams are the joiner's two membership commits: the invitation redemption (`consumeInvite`: `Member`, `ConsumedInvite` and their unique trees) and the `MemberPeer` binding (`registerMemberPeer`), both named as top callers in the log. The first insert and the steady writes touch one collection with no index, which 1.19.0 does not change.

## What changed on the Sereus side

- `strand-membership-reconciler.ts`: the NOTE that keeps the redemption and the binding as two commits said one transaction would save no `/cluster` requests. It now says merging them would save one commit's requests and latency, and keeps the other reasons for two commits (a torn commit, or the cohort applying the collections in either order, can show a binding with no member, which the revocation enforcer treats as a removed member). Its revisit condition no longer names batching.
- No schema change: the UNIQUE constraints stay. They are the membership invariants, and each now adds no request of its own to a commit.

## Not changed

- Upstream sends batches with no mixed-version handling (`296e195a`). A 1.17.0 or 1.18.x member already accepts a batched pend or commit, since the receiving half shipped in 1.17.0. The release notes say what a party with machines on different versions sees.
- Writes on a lone node (`createEmptyCollections` at cadre genesis and strand founding) still commit one collection at a time. Their cost is local storage operations, not requests, and the tripwires on `commitEmptyControlCollections` and `createDeclaredCollections` still apply.
