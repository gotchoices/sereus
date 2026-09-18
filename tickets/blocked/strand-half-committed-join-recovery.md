description: Decide whether a device whose join was only half saved (its invitation is recorded as used but it was never added as a member) should be able to finish joining on its own, or should keep needing a manager to add it by hand.
files: schemas/strand.qsql (ConsumedInvite ~79, Member.Authorized invite branch ~255-270), packages/quereus-plugin-sereus/src/strand-schema.ts (mirrored schema), packages/cadre-core/src/strand-membership-writer.ts (`consumeInvite`), packages/cadre-core/src/strand-membership-reconciler.ts, tickets/backlog/feat-strand-invitee-bound-invites.md
----
# Should sereus recover a half-committed strand join itself?

## The situation

To join a closed strand, a device redeems its invitation by writing two rows in one SQL transaction: `Strand.Member` (the party becomes a member) and `Strand.ConsumedInvite` (the invitation is spent, naming the new member key). The schema lets the `Member` row in only through a `ConsumedInvite` row written in **the same transaction**, which is what makes an invitation single-use.

On a networked strand, optimystic commits those two tables separately. It can report that one landed and the other did not (`CoordinatorPartialCommitError`). Optimystic documents this as a permanent property of its distributed commits, not a bug it will remove (`../optimystic/packages/db-core/src/transaction/errors.ts`: "reported visibility, NOT all-or-nothing"; a true all-or-nothing mode is only a future upstream backlog item). It happens often right now because of an upstream regression, and rarely in principle after that is fixed.

When `ConsumedInvite` lands and `Member` does not, the party can never join with that invitation: it is spent, and the schema needs a fresh consumption in the same transaction. Today the only way out is for a manager to notice and admit the party's key directly. `implement/strand-reconciler-reports-half-committed-join` makes this visible with a warning. This ticket asks whether sereus should also repair it automatically.

## Options

**A. No automatic recovery (status quo plus the warning).** A manager admits the party by hand (`addMemberByManager`). Simple, and it adds no new admission path to the schema. The cost: every half-commit strands a joiner until a human acts, and on a phone-to-phone strand the manager may not know anything is wrong.

**B. A recovery branch in `Member.Authorized` (recommended if recovery is wanted).** Let a `Member` row in without a same-transaction consumption when a committed `ConsumedInvite` already names that key and binds that exact membership incarnation. To keep this from becoming a way to rejoin after removal, `ConsumedInvite` would record the `StampId` that `consumeInvite` minted for the `Member` row (a new column covered by the invite signature). The branch would then require `new.StampId` to equal that recorded stamp, and require the stamp to be absent from `Strand.Revocation`. A removed member's stamp is retired into `Revocation` on removal, so the recorded stamp can never seat anyone again. The reconciler would then re-drive the `Member` insert on its next pass. Cost: a new admission branch in the security-critical schema, a column added to `ConsumedInvite`, and a schema change that interacts with `backlog/feat-strand-invitee-bound-invites` (which also reshapes `ConsumedInvite`).

**C. Wait for optimystic to offer an all-or-nothing commit mode** and use it for the join. No schema change in sereus, but there is no timeline, and optimystic has said its default will stay non-atomic.

## What is needed from a human

Choose A, B or C. If B, say whether it should be designed together with `feat-strand-invitee-bound-invites`, since both change `ConsumedInvite`. After the choice, this becomes a `plan/` ticket, or is closed if A.
