description: Founding a strand makes about 19 separate commits and re-reads the same rows many times (Member 11 times in one foundStrand), all local on a solo founder but each a two-member commit once the party has a second machine; group the control writes into one transaction, the founder's membership rows into one strand transaction, skip empty collections the founding writes itself, and drop the redundant reads.
architecture: docs/strands.md#strand-creation
files: packages/cadre-core/src/cadre-node.ts (`foundStrand`, `publishStrand` / `insertStrandRow` ~5994, `queryStrand` ~5963/~6120, `queryStrandPartyKey` ~6020-6023/~6612), packages/cadre-core/src/control-database.ts (Strand insert ~2455, StrandPartyKey insert ~2585, `deleteStrandAndPartyKey` ~2534-2567 as the model), packages/cadre-core/src/strand-membership-writer.ts (`bootstrapFounderMembership` ~576-606, `foundIfHeaderAbsent` ~380-444, `insertFounderMemberIfAbsent` / `insertFounderManagerIfAbsent` ~458-516, pre-split check ~531-535/~589-591, the batching NOTE ~408), packages/quereus-plugin-sereus/src/empty-collections.ts (~40-89), schemas/strand.qsql (Header/Member/Manager/MemberPeer CHECKs), packages/cadre-core/test/strand-membership-network-transactor-parity.spec.ts, packages/cadre-core/test/strand-solo-write-budget.spec.ts, packages/cadre-core/test/control-founding-consult-budget.spec.ts
----
# Strand founding writes in as few transactions as its constraints allow

## Traced and measured

`message-cost-accounting` baseline: `foundStrand` 456 ms, 90 block reads (`strand/Member` 11×). Traced this planning pass:

- **Control side, 2 transactions under 1 owner approval:** `Strand`, then `StrandPartyKey`, separate autocommits. The delete path already does both in one (`deleteStrandAndPartyKey`). `createOpenInvitation` + `publishFormationInvite` then adds a third transaction and a second owner approval.
- **Reads that repeat:** `queryStrand` twice; `queryStrandPartyKey` re-read at launch right after publish minted the key and discarded it; the joiner does the same.
- **Strand side, about 19 local commits:** 13 empty collections synced one at a time (chat schema; ~23 ms and ~25 storage operations each), then `Header`, `Member`, `Manager` as three autocommits each preceded by a count read, then the reconciler's `MemberPeer`, plus two catalog commits (`apply schema Strand`, then `apply schema App`).
- **7 of the 13 empty collections are superseded within a second** by the founding's own writes (Header, Member, Manager, MemberPeer and their 3 StampId unique trees).
- **The pre-split key check** scans `Member` and `Manager` on a first founding, where it cannot match.

On a solo founder all of this is local (no messages). It becomes messages when the founding party has a second machine: control writes are then two-member commits (3 `cluster` requests for a one-collection commit, about 4 per collection for more), and strand founding writes are too if the strand's cohort already includes the sibling.

## Design

1. **One control transaction for the strand row and its party key** (and, through an option on `foundStrand`, the formation invitation, so a found-and-invite flow takes one owner approval). Model it on `deleteStrandAndPartyKey`.
2. **Keep the minted party key** from publish instead of re-reading it at launch (both founder and joiner).
3. **One strand transaction for the founder's Header, Member, Manager and MemberPeer.** The CHECKs read the live tables and `committed.Member` is empty either way, so this looks constraint-compatible; confirm with `strand-membership-network-transactor-parity.spec.ts` before relying on it. If MemberPeer cannot join (it is written by the reconciler, on a separate path), batch the other three and say why.
4. **Commit empty collections only for tables the founding does not write.** With 3, the founding transaction creates the collections it writes. For chat that is 6 empty commits instead of 13.
5. **Skip the pre-split check on a first founding** (no Header existed before this call).

## Settled choices

- **No private batching of the empty commits.** Committing several empty collections in one coordinator round needs an Optimystic plugin API. Sereus could reach into db-core's `TransactionCoordinator`, but that copies upstream internals. If the remaining 6 commits still matter after this ticket (measure), file `blocked/optimystic-empty-collections-commit-in-one-batch` with the measurement.
- **The two `apply schema` passes stay.** One catalog commit per apply is upstream's batching; a batch spanning two applies is an upstream change, worth filing only if measured to matter.

## Edge cases & interactions

- **A founding that fails partway** (crash between the control transaction and the strand transaction). Today's per-row `IfAbsent` guards make re-founding idempotent; the batched version must keep that: a re-run sees the Header and does nothing, or sees none and writes all. Verify with the existing founding specs plus inspection.
- **Torn commit reporting.** A batched strand commit that reports torn must not leave a half-founded strand that `IfAbsent` cannot heal. Read how the reconciler heals today and keep the same property.
- **Open strands** (no Member/Manager): only Header is written; keep that branch.
- **A founding party with a second machine** whose control cohort includes it: the merged control transaction is one two-member commit instead of two. That is the measurable saving; check it in `message-cost-accounting`.
- **Budget specs** (`strand-solo-write-budget`, `control-founding-consult-budget`) will drop; re-pin with new `MEASURED_ON` dates.

## Tests

Re-pin the budget specs. The parity spec is the gate for item 3. No new test unless item 3 needs a new constraint arm covered.

## TODO

- Items 1–5.
- Re-pin budgets; re-run `message-cost-accounting`'s strand case; record before/after.
- Update docs/strands.md "Strand Creation" where it lists what founding writes.
