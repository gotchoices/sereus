description: A manager can currently only be shown to work when it acts from the computer that created the group; nobody has tested a manager doing its job from a second computer.
prereq:
files: packages/integration-tests/src/scenarios/strand-membership-closed-strand-e2e.integration.ts, schemas/strand.qsql, packages/cadre-core/src/strand/strand-membership-writer.ts
difficulty: medium
----

## The gap in plain terms

A private group ("closed strand") has **managers** — members allowed to invite people,
remove people, promote another member to manager, and clean up a departed member's
leftover device records.

Every automated test we have runs those manager actions on the *founder's* computer —
the machine that created the group and therefore already holds all the group's records
locally. We have never checked that the same actions work when a manager runs them from
a **second computer**, which has to read the group's records over the network instead.

There is now one test (`a joining node runs the join against its OWN database and both
nodes converge`) that proves the *joining* half works from a second computer. Manager
actions are the untested half.

## Why it might not "just work"

The rules that decide whether a manager action is allowed are checked at the moment the
change is saved, and they look up the manager's authorization in a **pre-transaction
snapshot** of the manager list (`committed.Manager` in `schemas/strand.qsql`). That is a
different kind of read from anything the joining test exercises:

- the joining path's only genuine over-the-network read is of the invite record
  (`ConsumedInvite`'s `InviteExists` / `ValidUsage` / `NotExpired` reading
  `Strand.Invite`);
- every other check on that path resolves against a record the joining computer just
  wrote itself, or against an empty table.

So "reads a snapshot of the manager list from a second computer" is a read shape with
zero coverage today. If it resolves differently — stale, empty, or unreliable — a
manager on a second machine would be told it has no authority, which reads as a
permissions bug rather than a networking one.

## What coverage should look like

A test in the same two-node closed-strand file, using the existing
`bringUpClosedStrand(label)` helper with its own label so its party ids, strand ids and
member keys stay disjoint from the other tests. The second node should hold a member
that has been promoted to manager, and then, **from that second node's own database**,
drive each manager-authorized writer at least once:

- `issueInvite` — the manager branch of `Invite.InviteValid`
- `addManager` — `Manager.Authorized`
- `revokeMember` — `Member.Authorized`'s manager-remove branch
- `removeMemberPeer` with `managerKeyPair` — `MemberPeer.Authorized`'s manager branch

Each accepted change should then be gated as visible from the founder, matching how the
existing tests wait for convergence. Follow the file's existing house rules: every
accepted write first, the single rejected write last, and absence assertions scanned in
JavaScript rather than looked up by primary key.

## Scope notes

- This is about *coverage*, not a known defect. Nothing is reported broken; the point is
  that we cannot currently say either way.
- Concurrent writes from both computers at once are a separate, still-open question and
  are **not** part of this.
- Proving records are physically copied to the second computer (rather than merely
  readable from it) is also separate — see `debt-strand-replication-vs-visibility-proof`.
