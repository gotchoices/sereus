description: The browser reference app re-implements, by hand, the phone kit's steps for switching to another cadre, moving its strands and deleting the cadre it left, so the two copies can drift apart; move the platform-neutral part into one shared place both use.
architecture: docs/architecture.md#an-app-joins-an-existing-cadre
files: packages/cadre-rn/src/phone-node/node.ts, packages/cadre-rn/src/phone-node/strand-move.ts, packages/cadre-rn/src/phone-node/dissolve.ts, packages/reference-app-web/src/lib/cadre-web.ts, packages/reference-app-web/src/lib/web-strand-move.ts, packages/reference-app-web/src/lib/web-dissolve.ts
tradeoffs: The web reference app is a demonstration surface with known gaps (it does not reopen joined strands after a reload), and hoisting the sequence means designing a storage-neutral interface over secure store, LevelDB and IndexedDB that today has only two users; drift between them costs a bug in a sample app, not in a library.
----

# The web app repeats the phone kit's join, move and dissolve sequence

`reference-app-web-joins-existing-cadre` and `reference-app-web-dissolves-left-cadre` mirror, in `cadre-web.ts` and two new modules, what `@serfab/cadre-rn/phone-node` does for phones: the start record with `origin` and `formerPartyId`, the switch with rollback, the owner-key wiring after a grant, the move record (shape, retry and delete rules) and the dissolve marker and removal order. The phone kit is React Native only (secure store, rn-leveldb), so the web app could not reuse it.

The rules in these copies are load-bearing (a joined party must never run owner genesis; a stale move record must be removed on an empty export; adoption must precede `running`), and each copy has been corrected in review at least once. A fix landing in one copy and not the other is the expected failure.

## What a fix would look like

A platform-neutral module (in cadre-core, or a new small package) holding the sequencing over an injected storage interface: a key-value slot store for the start record, move records and marker, a "delete this party's control store" hook, and a node factory. The phone kit and the web app would each supply their storage and keep only their platform glue.

## When to do it

When a third embedder needs the same sequence, or the first time a review finds the two copies disagreeing on a rule.
