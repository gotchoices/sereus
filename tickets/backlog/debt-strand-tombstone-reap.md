----
description: When a party stops using a shared network, machines that were offline at the time keep the old entry for it forever and may keep running that network. Decide whether a machine should be allowed to delete such an entry on its own, given that deleting it destroys a secret key that exists nowhere else.
prereq:
files: schemas/control.qsql + packages/cadre-core/src/control-schema.ts (Strand.AuthorizedDelete), packages/cadre-core/src/control-database.ts (REAPABLE_TABLES, reapRevokedRow, reapRevokedRows), packages/cadre-core/src/cadre-node.ts (unpublishStrand ~3231, strandWatcher)
----

## What this is about

`control-revocation-reap-authorization` + `control-revocation-reap-sweep` give three of the
four guarded control tables (`CadrePeer`, `DeviceToken`, `ValidationKey`) a rule that says:
if this machine already holds the party owner's signed record that a row was removed, this
machine may delete its own leftover copy of that row without needing the owner's private
key. A background pass then does exactly that, on a timer, while connected.

`Strand` — the table listing the shared networks the party participates in — was
**deliberately left out**, and its delete rule carries a comment saying so. This ticket is
the decision about whether to bring it in.

## Why it was excluded

A `Strand` row carries `MemberPrivateKey`: the party's own membership key for that network.
It is stored nowhere else. Every other guarded row holds public or re-creatable data, so a
mistaken automatic delete costs a re-registration; a mistaken `Strand` delete costs the
party its ability to ever act as a member of that network again.

There was also no pressure to include it. The stale-row problem the reap solves is
"different machines disagree about which rows exist", which matters most for the membership
table. A leftover `Strand` row is already dead for the purpose the tombstone exists to
serve: the rule that decides whether a network id may be re-joined without an owner
signature refuses any id that has ever been tombstoned, whether or not the row is still
sitting there.

## What is actually still broken without it

Two things, both real:

1. **A leftover `Strand` row is never removed.** Same permanent garbage as the other tables
   had, and the same permanent divergence in "what rows exist" between machines.
2. **A machine that was offline when the party unpublished a network keeps running that
   network.** `unpublishStrand` (`cadre-node.ts:3231`) removes the row locally and stops the
   local instance; siblings stop theirs when their watcher notices the row is gone. If the
   removal never physically reached them — the delete-while-alone case — their row never
   goes away and they keep running the network indefinitely. Reaping the row is what would
   make their watcher fire.

So the reap is not merely tidiness here; it is the missing half of "unpublish means
everyone stops".

## What whoever picks this up has to settle

- **Is an automatic delete of a secret-bearing row acceptable at all**, or should a `Strand`
  reap require an explicit operator action (a CLI/admin command, "this network was removed
  by the owner — drop my copy?") rather than a background timer?
- **Does the strand runtime tear down cleanly** when the row disappears underneath a running
  instance? The watcher path exists and fires `onStrandRemoved`, but it has only ever been
  driven by a local `unpublishStrand`, never by a row vanishing on its own.
- **Is local strand storage affected?** `unpublishStrand`'s own note says removal is
  control-plane only and the strand's durable blocks stay on disk. A reap should behave
  identically — and that should be stated, not assumed.
- **Rollback story.** Every other reapable table can be re-seated by the owner. A reaped
  `Strand` cannot, because the member key is gone. If that is acceptable, say so explicitly;
  if it is not, the answer may be "reap the row but archive the key first", which is a
  different feature.

The mechanism itself is cheap once the decision is made: one `or exists (select 1 from
committed.Revocation ...)` branch on `Strand.AuthorizedDelete` matching the three already
shipped, plus `'Strand'` added to `REAPABLE_TABLES`. The cost is entirely in the judgement
above, which is why this is filed rather than done.
