description: When a phone joins another person's shared app workspace using a directly handed-over invitation, the owner's always-on machine never learns about that workspace, so it keeps no backup copy of it. Losing the phone then leaves the phone owner's data in that workspace only on the other people's machines.
prereq: always-on-node-hosts-unclaimed-strands
architecture: docs/architecture.md#strand-filtering
files: packages/cadre-core/src/cadre-node.ts (addStrand → rememberForeignStrand, StrandWatcher queryable), packages/cadre-core/src/joined-strand-store.ts, schemas/control.qsql, docs/strands.md
tradeoffs: The workspace still has copies on the other party's machines, so nothing is lost unless that party also disappears; closing the gap means recording another party's strand (and its read secret) in this party's shared control database, which widens what that database carries and needs its own authorization rule.
----
# Always-on nodes do not host strands their party joined from elsewhere

## Behaviour today (read, not run)

`always-on-node-hosts-unclaimed-strands` makes a storage-profile node run a storage replica of every strand in its party's **control database** that its filter admits. A strand a phone joins by `addStrand` with a row from another party — one the party's control database does not hold — is remembered only in that phone's local joined-strand store (`joined-strand-store.ts`, per machine, not replicated). The always-on node's strand watcher reads the control database, so it never sees the strand and never hosts it.

Strands joined through formation are not affected: formation seats a row in the joiner's control database, which the watcher does see.

## Wanted

A strand any machine of the party has joined is visible to the party's other machines, so a replica host backs it up too — without handing the strand's read secret to anyone outside the party.

## Open questions for the plan

- Where the shared record lives: a new owner-signed control table for "strands this party joined from elsewhere", or seating the foreign row in the control `Strand` table with a distinct provenance.
- What leaving the strand on one machine means for the others.
