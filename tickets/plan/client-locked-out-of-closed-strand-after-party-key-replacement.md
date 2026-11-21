description: After a party removes one of its machines, a phone that runs the party's closed shared workspaces without storing them is shut out of those workspaces for good, because nothing records its network identity where the key replacement that follows a removal can find it.
prereq: strand-node-that-holds-no-blocks
architecture: docs/strands/membership.md#binding-the-partys-machines
files: packages/cadre-core/src/strand-instance-manager.ts, packages/cadre-core/src/strand-party-key-rotation.ts, packages/cadre-core/src/strand-party-peers.ts, packages/cadre-core/src/strand-party-machines.ts, packages/cadre-core/src/strand-membership-reconciler.ts, packages/cadre-core/src/control-database.ts, schemas/control.qsql, docs/strands/membership.md, docs/strands/keys.md, docs/strands/writes.md, docs/cadre/control-schema.md, docs/cadre/node.md
repro: static
difficulty: hard
----

# A client is locked out of a closed strand after its party's key is replaced

A node whose `strandCohortMember` role is off runs each strand as a **client**: it stores none of the strand's blocks and reads and writes through the machines that do (`strand-node-that-holds-no-blocks`). That ticket made a client publish no `CadreControl.StrandPeer` row, for a reason that holds: the row set means "the machines that serve this strand", and a serving sibling's offline queue waits for every machine with a row that it is alone in a cluster without. A client is in no cluster, so its row would hold a sleeping phone's sibling's queue forever.

The row has a second reader the ticket misjudged. The party key replacement that follows every machine removal on a closed strand (`strand-party-key-rotation.ts`, `bindMachines`) binds under the new key exactly the peer ids it reads from the party's `StrandPeer` rows, plus its own. A client's peer id is in neither, so it is never bound under the new key. The ticket assumed the client's own membership loop would write that binding on its next pass. It cannot:

- The replacement runs its steps back to back on one owner machine: admit the new key, bind the machines, promote the new key, then the old key resigns and leaves. The control row that re-keys the client's loop is swapped last.
- As soon as the old key leaves, the client's self-binding under it is an orphan with no live binding beside it, which is exactly the revoked-peer deny set every serving machine derives from the strand's membership tables. Those machines refuse the client's connections and its storage-protocol streams.
- The client's loop, re-keyed only after the swap, then tries to write its binding under the new key through a serving coordinator, which refuses it. No sibling binds it in its place, because siblings bind the machines they find in `StrandPeer` rows.

So a party with one client phone and one closed strand loses that phone from the strand the first time it removes any machine. Removal is an ordinary operation and closed strands are the ordinary kind, so this is reachable in normal use. It is `static`: read from the rotation's step order and the deny-set derivation (`StrandRevocationEnforcer`, "peer ids with an orphaned binding and no live one"). What would confirm it: one party of an owner server, a second server and a client, a closed strand on all three; remove the second server; the client's next read or write on the strand is refused and never recovers.

## What must stay true

- A serving sibling's offline queue must not wait for a client. That is why the row is skipped today, and any fix has to keep it.
- A removed client must stay shut out. Today that works through the orphan: its self-binding under the old key is denied once the key leaves. A fix must not re-admit a removed client by re-binding every peer id the old key had bound, because a removed client's peer id is recorded nowhere either.
- A client must keep binding itself in a closed strand. Without a binding it would never be in any deny set, and its party's removal from the strand by a manager would not shut it out.

## Proposed resolution

Record the fact the readers need: a client publishes its `StrandPeer` row like every machine, and the row says whether the machine serves the strand. The offline queue's machine tracker (`strand-party-machines.ts`) waits for serving machines only; the key replacement and the membership loop bind and clear every live machine; the removed-machine partition (`strand-party-peers.ts`) works for clients as for servers; and a sibling can look up a client's strand address, which closes the other stated cost of the missing row.

The fact belongs on the `StrandPeer` row, not on `CadrePeer.Profile`: `node-class.ts` records why that column cannot grow a third value, and a machine can serve one strand and be a client of another only if the fact is per strand. `StrandPeer` is a replicated control table, so the column has to follow the control schema's compatibility rules (`docs/cadre/control-schema.md`): a party's machines update one release at a time, and a machine on the previous release reads the new column as absent. Absent must mean "serves", which is what every row written before the column meant.

## Alternatives considered

- **A client binds itself under the pending key as soon as that key is a member, before the old key leaves.** A race against a replacement that runs its steps back to back, and a client has no local storage change feed to wake its loop on a strand table change, so it would usually arrive after the old key had left.
- **The replacement re-binds every peer id bound under the old key, minus the removed machines' ids.** A removed client's id is not known, so it would be re-bound and stay admitted.
- **A client writes no binding at all.** It would never be denied, including after its party is removed from the strand.
- **Keep the row skipped and accept the lockout.** Rejected: it ties machine removal to "no client runs any closed strand of this party", which no operator will remember.

## If nothing is done

A client phone keeps working until its party removes a machine. From then on it is refused by every serving machine of the party's closed strands, and the only way back is a new strand. `docs/strands/keys.md` and `docs/strands/membership.md` state the limit and name this ticket; `.release-notes.pending.md` tells operators not to remove a machine from such a party until this lands.
