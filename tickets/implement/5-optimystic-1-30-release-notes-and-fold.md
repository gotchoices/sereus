description: Finish the storage upgrade: write the notes that tell app builders and operators what changed for them, and update the queued work items that this upgrade has already done part or all of.
prereq: 3-optimystic-1-30-hosts-and-apps, 4-optimystic-1-30-integration-harness
architecture: docs/cadre/node.md#storage
files: .release-notes.pending.md, tickets/backlog/feat-strand-blobs-persist.md, tickets/backlog/feat-strand-offline-mode-nativescript.md, tickets/backlog/debt-shared-store-provider-never-exercised-end-to-end.md, tickets/backlog/later/5-quota-enforcement.md, tickets/backlog/later/3-mobile-resource-awareness.md, docs/cadre/node.md
difficulty: easy
----
<!-- resume-note -->
RESUME: A prior agent run on this ticket did not complete.
  Prior run: 2026-11-26T12:23:38.580Z (agent: claude)
  Log file: C:\Projects\sereus\tickets\.logs\5-optimystic-1-30-release-notes-and-fold.implement.2026-11-26T12-23-38-580Z.log
Read the log to see what was done. Resume where it left off.
If the prior run hit a timeout or repeated error, be cautious not to rush into the same situation.
<!-- /resume-note -->

# Release notes for the storage upgrade, and the queue it empties

Last of five tickets adopting Optimystic 1.30.0. Tickets 1–4 are the code; this one is the notes and the queued work the upgrade has already done. It is also the first point in the chain where `yarn typecheck`, `yarn build`, `yarn test` and `yarn lint` should all be green across the workspace — run them and say so, or name what is left.

## Release notes

`.release-notes.pending.md` is empty but for its header. Add a section for this release, written for the people on the other side of the published packages: an app builder embedding `@serfab/cadre-core` or `@serfab/cadre-rn`, and an operator running `cadre-cli`, `cadre-host` or `cadre-provider`. Follow the house shape — a heading per change, a bolded lead sentence per bullet, each bullet one claim plus its reason, and link into `docs/` rather than restating a mechanism.

What has to be in it, because each is a change someone outside this repository has to act on:

- **Requires Optimystic 1.30.0 and Quereus 5.7.1.** Every machine of a party, and every partner of a strand, upgrades together. A 1.29.1 coordinator counts an out-of-space vote as neither an approval nor a rejection, so its writer gets a promise shortfall instead of being told the cohort is full. Nothing stored by the previous release needs migrating.
- **`CadreNodeConfig.storage` takes one asynchronous opener per scope.** `provider` is gone, `open(scope)` replaces it, it returns all three of a scope's stores as one value, and it is asynchronous — so a platform calls its own one storage-package factory and `lazyRawStorage` is gone with it. The single-store-for-every-scope form is gone: an embedder that wants sharing calls its platform factory over one location. cadre-core still closes nothing it was handed.
- **`storage.quotaBytes` is now `storage.allotmentBytes`, and it is read.** It was accepted and ignored before. `CADRE_STORAGE_QUOTA` is `CADRE_STORAGE_ALLOTMENT`. What the number bounds, and what it does not — one network's share of the machine, so a machine with several strands can hold more than it in total — belongs in one sentence here and in full in `docs/cadre/node.md`.
- **A node acts as it fills.** It shrinks its read cache and, above `refuseAbove`, refuses new data; a write whose cohort refused for space ends at once with no retries, and an app tells that failure apart with `cohortOutOfSpaceOf`. An entry already in an offline queue stays queued waiting for its cohort. Ring shedding and the released-block sweep stay inert on a Sereus node, because every Sereus node runs its own peer-join block catch-up instead of Optimystic's rebalance reaction.
- **A platform with no free-space reading must declare an allotment.** The file store and a browser's IndexedDB report free space; LevelDB, SQLite and memory do not. The phone kit and the NativeScript app declare one (`DEFAULT_DEVICE_STORAGE_ALLOTMENT_BYTES`, overridable); a node with neither an allotment nor a measuring backend cannot tell how full it is and acts on none of the above.
- **`EdgeNodeStorage` changes shape**: `nodeStorage(scope)` replaces `rawStorage(scope)`, `offlineJournal(scope)` returns that scope's own key-value store rather than a second one over the same handle, and `allotmentBytes` is new. Every platform in this repository is updated; an app with its own platform has to follow.
- **A strand node that stores no blocks now gets storage too.** A client uses the key-value store and the pieces — its clock high-water mark, its blob records, and blob pieces that may be its own host's only copy — so the storage opener is now entered for a client's strand scope, where it was skipped before. A client still stores none of the strand's blocks.
- **Blob pieces and blob records now survive a restart on every platform**, because a node storage has nowhere to leave them out. See the fold of `feat-strand-blobs-persist` below for what that does and does not make usable.
- **NativeScript now has an offline journal**, so `setStrandOfflineMode` no longer refuses there.
- **Nothing changed for a Quereus host's SQL.** Quereus 5.7's three behaviour changes were each checked against this repository and reach nothing (no views or assertions in any Sereus schema, no use of the `StampId()` function, no deferred foreign key or cross-table CHECK). Say so in one bullet so a reader does not go looking.

## sereus#67

Optimystic's 1.30.0 notes say the release answers sereus#67, with one part still missing: a node cannot yet free old revisions of blocks it is still responsible for, so a node whose disk is mostly block history reaches `refusing` and stays there until its allotment is raised or peers take its ranges (their backlog `feat-cold-range-transform-offload`).

Read the issue first — `gh issue view 67` — so the answer addresses what was actually asked rather than what the upstream notes summarise. Then record the answer in the release-notes section above, in the terms the issue used, including the part that is still missing and the three responses to pressure that stay inert here.

**Do not comment on or close the issue.** It is a public, outward-facing action on a repository other people read. Put the reply text in the `complete/` ticket you write, say it is ready to post, and leave the posting to a human.

## The queued work this upgrade changes

Five backlog tickets. Each is rewritten in place or deleted; none is moved between folders (there is no `tickets/releases.md`, so `backlog/later/` is the human's to curate).

**`feat-strand-blobs-persist` — rewrite down to what is left.** Its first bullet asked for a persistent piece store beside every platform's block store, and a persistent key-value store on strand nodes, naming `FilePieceStore`, `LevelDBPieceStore`, `IndexedDBPieceStore` and `SqlitePieceStore`. That is delivered: a `NodeStorage` has no part a platform can leave out, so every platform in this repository now passes all three, and the `NOTE:` in `peer-join-backfill.ts` that asked for the key-value store is answered. What remains, and is the whole of the rewritten ticket:

- the `blobs.hold` choice (`'on-demand'` on a device, `'eager'` on a server) and whether it follows the node class or a role;
- the app-facing API — how an app puts bytes and gets a reference to write, and how it reads them back;
- the two-commit pattern for "no one sees the reference before the bytes moved", in `docs/strands/app-schema.md`;
- removing the limit line from `docs/schema-guide.md`.

Keep its `architecture:` and `tradeoffs:` fields; rewrite `description:` and `files:` to the remaining work, and say in the body that the storage half landed with this adoption so the next reader does not redo it.

**`feat-strand-offline-mode-nativescript` — rewrite down to the app.** Ticket 3 implements `offlineJournal(scope)` on the NativeScript edge platform, and both of this ticket's "check before building" questions are answered by using upstream's own store through upstream's factory. What remains is the reference chat's own surface: the toggle, the queue line, per-message progress and discard, matching the other two reference apps. Rewrite `description:` and `files:` to that; the `architecture:` anchor stands.

**`debt-shared-store-provider-never-exercised-end-to-end` — delete.** Its subject is the single-`IRawStorage`-for-every-scope form of `storage.provider`, which ticket 2 removes: `OpenNodeStorage` carries a `close()` a shared instance would have closed once per scope, `levelDbNodeStorage` refuses a second call over one handle, and an embedder that wants sharing gets it from `fileNodeStorage`'s holder counting instead. The counting invariant the ticket was protecting now lives in upstream's `withReadCache` and is tested there. Delete the file; record in the `complete/` ticket that it went and why, so the reasoning is not lost with it.

**`backlog/later/5-quota-enforcement` — rewrite to what is still missing.** Its premise ("storage-profile nodes should enforce capacity limits from `CadreNodeConfig.storage.quotaBytes`", blocked on Arachnode) is half answered: the allotment is wired and a full node refuses new data. Three of its four asks are not: per-strand usage accounting, reporting usage to the provider for billing, and a machine-wide rather than per-network budget. Rewrite it to those three, drop the "blocked on Arachnode" framing, and point at `docs/cadre/node.md`'s limits for what the allotment bounds today.

**`backlog/later/3-mobile-resource-awareness` — one stale line, added by ticket 3's review.** Its scope note says "Storage quota on mobile is already covered by `storage.quotaBytes` in `CadreNodeConfig`", a field that no longer exists. Nothing else in that ticket is affected: the name is now `storage.allotmentBytes`, and on a phone it is the platform that declares it (`EdgeNodeStorage.allotmentBytes`, `DEFAULT_DEVICE_STORAGE_ALLOTMENT_BYTES`), not the app's config — so the line should say that the figure exists and where it comes from, and keep its point that mobile defaults should be conservative. Do not otherwise rewrite the ticket.

## Edge cases and interactions

- **A note that restates a mechanism.** The release notes are for someone acting on a change, not a second copy of `docs/cadre/node.md`. If a bullet needs a paragraph, it needs a link instead.
- **The doc gate.** `yarn check:docs` bounds a document at 6,000 words and a list item at 120. `docs/cadre/node.md` is already near its budget — `tickets/backlog/debt-cadre-node-doc-at-its-word-budget.md` says so — and ticket 2 rewrites its Storage section. If ticket 2 left it over budget, that is ticket 2's regression, not a reason to raise the limit; report it and move detail into the source comment that owns it.
- **A backlog rewrite that keeps a stale `files:` list.** Each rewritten ticket's `files:` should name where the remaining work is, not where the landed work was.
- **A rewritten ticket still needs a decline argument.** `tradeoffs:` is required on a backlog ticket. A rewrite that narrows the work usually narrows the decline argument too; rewrite it rather than keeping the old sentence.

## Tests

None. This ticket writes prose and edits the board.

## TODO

- `gh issue view 67`; draft the answer.
- Write the release-notes section, including the sereus#67 answer and the Quereus-5.7-reaches-nothing bullet.
- Rewrite `feat-strand-blobs-persist` and `feat-strand-offline-mode-nativescript` down to their remaining work.
- Delete `debt-shared-store-provider-never-exercised-end-to-end`.
- Rewrite `backlog/later/5-quota-enforcement` to per-strand accounting, billing usage and a machine-wide budget.
- Fix the one `storage.quotaBytes` line in `backlog/later/3-mobile-resource-awareness`.
- Run `yarn typecheck`, `yarn build`, `yarn test` and `yarn lint` across the workspace; report what is green and what is not.
- In the `complete/` ticket: the sereus#67 reply text ready for a human to post, the deleted ticket and why, and any figure the chain moved (the two storage budgets, and any timing a restart scenario reported).
