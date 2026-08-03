----
description: Two machines that accept the same invitation at the same moment are BOTH told they succeeded, but only one of them is actually recorded — the other person silently disappears from the group with no error anywhere. The cause is in the shared database library kept in the sibling `optimystic` checkout, so it cannot be fixed in this repository.
prereq:
files: ../optimystic/packages/db-core/src/collection/collection.ts, ../optimystic/packages/quereus-plugin-optimystic/src/optimystic-module.ts, packages/cadre-core/src/control-database.ts (recordFormationUsage / withUseNumberRetry / isLostUseNumberRace ~lines 1920-2100), packages/integration-tests/src/harness/node-fixtures.ts, packages/integration-tests/src/harness/control-cohort.ts
difficulty: hard
repro: verified
----

# Blocked (b): a concurrent insert of the same primary key is silently last-writer-wins

**Category (b) — a dependency outside this repo.** Measured 2026-08-02. Nothing in
`sereus` can fix it: the defect is the *absence* of an error, and every recovery this
repo has for this situation is triggered by an error.

## What happens, in plain terms

An invitation to join a group can allow several people in. Each acceptance is stamped with
a sequence number — first acceptance, second acceptance, and so on. The number is worked
out by looking at what has already been recorded.

When two machines work out that number at the same instant, they both pick the same one.
Both of them then store their acceptance. Both are told the storage succeeded. Afterwards
only ONE acceptance exists. The other person's acceptance — their key, their signature,
their consent record — is gone, and nothing anywhere reported a problem.

This is worse than the failure it replaces. The code was built to handle a *reported*
collision: the loser is supposed to be told "that number is taken", pick the next free one,
and re-use the approval it already holds. That recovery is correct and well tested. It is
simply never reached, because no collision is ever reported.

## The measurement

Run 2026-08-02, sereus at `53e54bd`, `../optimystic` clean at `092f33f` (freshly built),
`../quereus` freshly built. Three throwaway experiments, since deleted.

**Experiment 2 — two real machines.** Two `CadreNode`s on one party, connected, with the
replication cohort confirmed to hold both of them (`readCohort` returned 2 members on each
side). Node A owns the party; node B is a plain second node. A publishes a strand and a
strand-bound invitation allowing 2 acceptances; B is polled until it can see both rows.
Then both nodes call `recordFormationUsage` in the same tick with their own freshly minted
consent, and the two promises are settled together:

```
cohort A=2 [12D3KooWAk4jqFHY…, 12D3KooWRvCUncNQ…]
cohort B=2 [12D3KooWRvCUncNQ…, 12D3KooWAk4jqFHY…]
A FULFILLED {"useNumber":1,"usageStampId":"e6l3EtxYUSnqHxBOJExEHh3ulysmG0dVtVlfH9CW39M"}
B FULFILLED {"useNumber":1,"usageStampId":"xmP_dwNmL-qldqSK7fH-INrGAH_3QH-e315cXs4dBfI"}
A view rows = [{"UseNumber":1,"UsageStampId":"xmP_dwNmL…","PeerKey":"ZuC-W7x7tFZ…"}]
B view rows = [{"UseNumber":1,"UsageStampId":"xmP_dwNmL…","PeerKey":"ZuC-W7x7tFZ…"}]
```

Both writers fulfilled, both reporting sequence number 1. Exactly one row survives, and
BOTH machines agree on which — **B's**. A's joiner is silently dropped. It reproduced on
the first attempt, with no artificial timing help.

**Experiment 1 — two database handles over one local store**, on a single node, produced
the identical shape: both fulfilled at number 1, one surviving row, the second writer's.
So this does not need two machines; it needs two writers the local write queue cannot see.

**Experiment 3 — the discriminator.** Same two-machine setup, but each machine inserts a
DIFFERENT strand (different primary key) at the same instant:

```
A insert fulfilled
B insert fulfilled
A view strands = ["…-X-…", "…-Y-…", "…-seed-…"]
B view strands = ["…-Y-…", "…-seed-…"]
```

Both rows survive; A holds both immediately and B is merely behind (ordinary
eventual convergence). **So concurrent writes are not generally lossy.** The loss is
specific to two writers inserting the SAME primary key: instead of one of them being
refused, the second one silently replaces the first.

## Where the defect is

The SQL layer does make the right decision — it just makes it too early. Before the write,
the storage layer probes for an existing `(Token, UseNumber)` row and a deferred
`Monotonic` CHECK reads the committed table. Both run against a snapshot taken before the
other machine's row existed, so both pass. When the two commits then merge, that decision
is not re-made: the surviving row is simply whichever landed second.

That merge is `@optimystic/db-core`'s `Collection` commit/sync path, reached through
`quereus-plugin-optimystic`'s virtual table. Both live in `../optimystic`, which sereus
consumes as built `dist`.

**A concurrent insert whose primary key another writer has already committed must be
refused, not silently replace it.** Today it replaces it.

## Why sereus cannot work around it

- `isLostUseNumberRace` classifies error TEXT. There is no error.
- `withUseNumberRetry` retries on that classification. It never fires.
- A read-back-after-write check in `ControlDatabase` would only narrow the window, not
  close it, and would report a failure to a joiner whose approval was already spent — the
  exact cost the retry exists to avoid.

## Unblock condition

An optimystic change that makes a commit whose primary key was taken concurrently fail
rather than overwrite — surfacing as `UNIQUE constraint failed: FormationUsage.Token,
FormationUsage.UseNumber` or `CHECK constraint failed: Monotonic`, the two messages
`isLostUseNumberRace` already recognises. Land it, rebuild
(`cd ../optimystic && yarn build`), then promote
`28.5-formation-concurrent-redemption-e2e` out of `implement/`; that scenario is the
acceptance test for this fix and is `prereq:`-chained to this slug.

If optimystic instead surfaces a THIRD message, `isLostUseNumberRace`'s pattern list in
`packages/cadre-core/src/control-database.ts` needs a matching arm — file that here as a
follow-up rather than assuming the two existing patterns cover it.

## Recipe to re-measure

1. Two `CadreNode`s on one party via `controlNodeConfig` (A: `storage` profile + relay,
   B: `transaction`).
2. **Connect them BEFORE the first write.** A row committed while A is alone cannot be read
   back once the cohort grows — the separate, already-tracked write-while-alone problem in
   `control-db-cross-node-convergence-halted`. Ordering the owner-key insert after
   `connectControlNodes(B, A)` sidesteps it entirely.
3. `insertOwnerKey` on A, `initializeSeedBootstrap`, `A.authorizePeer(B)`.
4. Confirm `readCohort(node.getControlNode()!)` returns 2 on both sides. A one-member
   cohort commits on the writer's own vote and would prove nothing.
5. A writes a strand + a strand-bound `FormationInvite` with `totalUses: 2`; poll B until
   `queryFormationInvite` / `queryStrandStampId` see them.
6. Both nodes call `recordFormationUsage` in the same tick; `Promise.allSettled`.
7. Read `FormationUsage` from BOTH nodes. Two fulfilled promises with one surviving row is
   the defect.

Vitest in this repo does not surface `console.log` from these files — write the trace to a
file with `appendFileSync` or the run is lost.

## Side observation, not part of this ticket

Cross-node control-DB convergence, recorded as broken in
`tickets/blocked/control-db-cross-node-convergence-halted` against optimystic `bf7e3d2`,
**passes** against `092f33f`: `control-db-two-node-convergence.integration.ts` was green on
2026-08-02 after `cd ../optimystic && yarn build`. The write-while-alone read-back failure
(`collection default/OwnerKey holds committed revision 1, but its header block read as
absent`) still reproduces. Re-measuring that ticket's full scenario list is its own job,
not this one's — recorded here only so the next reader does not assume the whole class is
still red.
