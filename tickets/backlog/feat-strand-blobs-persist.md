description: Apps can attach a large file (a photo, a document) to a row, and those files now survive a restart, but an app still has no supported way to hand us the bytes or read them back — and a phone keeps every file its group shares rather than only the ones it sent or opened.
architecture: docs/schema-guide.md#limits-and-accepted-tradeoffs
files: packages/cadre-core/src/strand-instance-manager.ts (the strand node's options), packages/cadre-core/src/node-roles.ts, packages/cadre-core/src/types.ts, packages/quereus-plugin-sereus/src/compose-strand.ts, docs/strands/app-schema.md, docs/schema-guide.md, ../optimystic/docs/blobs.md
tradeoffs: No Sereus app asks for attachments yet, and the remaining work still needs a per-node-class decision about how much of other people's files a phone keeps, so it can wait until an app needs it.
----

# Strand blobs an app can actually use

## Where this stands

Optimystic calls a large value stored outside a row a **blob**: it is cut into content-addressed pieces, kept outside transactions, copied to the machines responsible for it, and referenced from a SQL row by a `blobref` column (`../optimystic/docs/blobs.md`).

**The storage half landed with the Optimystic 1.30 adoption — do not redo it.** A node now takes one `NodeStorage` carrying its blocks, its node-local records and its blob pieces together, and that value has no part a platform can leave out, so every platform in this repository passes all three. Blob pieces and blob records survive a restart on the CLI, both phone kits and the browser; a strand client gets a storage scope too, since the pieces it holds may be its host's only copy; and the `NOTE:` in `peer-join-backfill.ts` that asked for a key-value store on strand nodes is answered. That was the first of the three things [gotchoices/sereus#67](https://github.com/gotchoices/sereus/issues/67) asked for. The limit line in `docs/schema-guide.md` now says what is actually left.

## What remains

**The hold choice.** Optimystic's `NodeOptions.blobs.hold` decides whether a node keeps every blob its cohort is responsible for (`'eager'`) or only what it put, pinned or read (`'on-demand'`). A phone should not store the group's photo library because it is a cohort member. `'on-demand'` for a device and `'eager'` for a server is the wanted behaviour; the open question is whether that follows the node class or becomes a fifth entry in the `roles` block, which is where every other per-machine behaviour decision now lives.

**The app-facing API.** An app needs a way to hand bytes to its strand and get back the reference it writes into a row, and a way to read the bytes behind a reference it read. Both exist on the strand node's blob service today and are reachable only by reaching inside the instance (`instance.libp2pNode.blobs`), which is not a supported surface. Decide where this belongs: on the strand handle an app already holds, or through the SQL plugin keyed on the table.

**The two-commit pattern, in `docs/strands/app-schema.md`.** No member may see a reference before the bytes have moved, which means the bytes are put and copied first and the row carrying the reference is committed second (`../optimystic/docs/blobs.md` → "Committing a reference"). An app that writes the row in one transaction with the put publishes a reference its partners cannot resolve.

**A `network` connection over a client node builds its blob service over memory.** `composeStrand` passes the storage to the Optimystic plugin's `storageFactory` on the `local` transactor only, so a connection made over a client node — which holds no blocks and carries no blob service of its own — leaves the plugin to build one over memory piece and key-value stores even though the connection was handed real ones. Unreachable while no schema declares a `blobref` column, and a `NOTE:` sits at the site; it becomes a real defect the moment one does.

**Then remove the limit.** `docs/schema-guide.md` → "Limits and accepted tradeoffs" tells an app not to declare a `blobref` column. That line goes when the three above are done, not before.
