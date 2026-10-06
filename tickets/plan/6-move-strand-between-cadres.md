description: Move a strand an app created in its own one-node cadre into the cadre the user actually lives in, without the strand's other members noticing, so that a second app can join the user's existing cadre and bring its data along.
prereq: app-joins-existing-cadre-by-invitation
files: packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/control-schema.ts, schemas/control.qsql, schemas/strand.qsql, docs/architecture.md, docs/strands.md
difficulty: hard
----

# Move a strand from one cadre to another

## Use case

The user launches a second Sereus app. It founds a one-node cadre B and a strand S for itself. The user then joins B's node to their existing cadre A (`app-joins-existing-cadre-by-invitation`). S has to end up in cadre A, so that A's always-on machines host it and A's owners administer it.

## Why this is tractable

A party's identity on a strand is control-database state, not machine state:
- `Strand` carries the strand's read secret (`MemberPrivateKey`).
- `StrandPartyKey` is the party's membership identity, which seats its `Strand.Member` / `Strand.Manager` rows.
- `JoinedStrand` marks a strand the party joined.

If cadre A inserts the same rows under its own owner signature, the strand still sees the same member, and cadre A's machines bind themselves to that party key (`MemberPeer`), as an always-on replica already does.

## What to build

- `moveStrandToParty(strandId, targetParty)` on a node that is an owner in both cadres (B's node after joining A as an owner). In one A transaction it writes the rows, owner-signed in A (see the founder rule below for which key signs). What happens to B's copies is the last schema point below.
- **Schema constraints (schemas/control.qsql):**
  - Every copied row gets a **fresh `StampId`** and a fresh signature in A. Never reuse B's stamps (`NotRevoked` is per party, and identical stamps make cross-party replay possible until `control-approvals-bound-to-party` lands).
  - `Strand.AuthorizedInsert` (owner branch) requires `FounderOwnerKey = context.OwnerKey`. The insert in A must therefore be signed by the **same machine key** that founded the strand in B (B's node), or founder derivation in `launchStrand` moves to another machine and the one-time founder bootstrap may run again. If B's app uses a new node identity for party A, this needs a design.
  - A **consent-seated** strand in B (open, keyless, `FounderOwnerKey` null) can only be re-seated in A through the owner branch, which records a non-null founder. Check what that does to founder derivation for such strands.
  - Both kinds move: `Strand` (strands B founded) and `JoinedStrand` (strands B joined), each with its `StrandPartyKey`.
  - `FormationInvite` rows for the strand are owner-signed per party: re-mint in A or cancel. `FormationUsage` is append-only history and stays in B.
  - Deleting in B: `Strand` and `StrandPartyKey` have no reap branch and need B-owner signatures plus tombstones (`deleteStrandAndPartyKey`). Since B is dissolved next, skipping the B-side deletes and letting `dissolve-empty-cadre` drop B's storage is acceptable; decide and document.
- Research first, and record the answers in the ticket before implementing:
  - Does anything in the strand database record the party id or a party-scoped key other than `StrandPartyKey`? If so, the move needs a strand-side step.
  - Pending joins (`JoinRequest`) and outstanding invitations for S held in B: move them, or cancel them and tell the user.
  - Strand formation answered from B's machines: invitations already handed out name B's machines and will stop working after the move. Re-mint, or accept the loss and say so.
  - Party-private app state (`blocked/decide-party-private-labels-and-app-state`): if that lands as control rows, they move too.

## Edge cases & interactions

- Crash between the A insert and the B delete: both parties hold S, which is harmless (same party key) and must be retried to completion. (Inspection plus a resumable step.)
- S open on B's node during the move: the strand instance switches to party A's control context without losing unsynced writes. (Test.)
- B is not an owner in A (joined with `asOwner: false`): refuse.
- Strand sync after the move: A's basement node starts hosting S and serves the strand's other members. (Integration test with an external party on S.)

## TODO

- Research the questions above and update this ticket.
- Implement the move and document it in docs/architecture.md (control tables) and docs/strands.md.
- Integration test: external party P shares strand S with cadre B; S moves to A; P keeps syncing with S through A's basement node.
