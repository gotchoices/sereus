description: The storage upgrade's release notes are written for the people on the other side of the published packages, and the queued work items the upgrade already did are rewritten or removed. Check that the notes say what actually shipped and that nothing still-unfinished was declared done.
architecture: docs/cadre/node.md#storage
files: .release-notes.pending.md, docs/schema-guide.md, tickets/backlog/feat-strand-blobs-persist.md, tickets/backlog/feat-strand-offline-mode-nativescript.md, tickets/backlog/later/5-quota-enforcement.md, tickets/backlog/later/3-mobile-resource-awareness.md, packages/reference-app-web/e2e/fixtures/cadre-member.ts, packages/reference-app-web/e2e/fixtures/formation-responder.ts
difficulty: easy
----

# Release notes for the Optimystic 1.30 storage upgrade, and the board it empties

Last of the five tickets adopting Optimystic 1.30.0 (tickets 1–4 were the code). This one is prose and board edits; it writes no tests and the ticket asked for none.

## What changed

**`.release-notes.pending.md`** gains the release's section — ten headed changes, each written for an app builder embedding `@serfab/cadre-core` or `@serfab/cadre-rn` or an operator running `cadre-cli`, `cadre-host` or `cadre-provider`: the version floor (1.30.0 / Quereus 5.7.1, every machine of a party and every partner of a strand together, nothing to migrate), `storage.open(scope)` replacing `storage.provider`, `quotaBytes` → `allotmentBytes` and the environment variable rename, what a filling node does, which platforms must declare an allotment because they cannot measure free space, the `EdgeNodeStorage` shape change, a strand client now getting a storage scope, blob pieces and records surviving a restart, NativeScript's offline journal, and one bullet saying Quereus 5.7's three behaviour changes reach nothing here so a reader does not go looking.

**`docs/schema-guide.md`** — the `blobref` limit line now says what is actually left (no app-facing way to put or read bytes; a phone holds its strand's blobs eagerly) rather than "kept in memory".

**Board:** `feat-strand-blobs-persist` and `feat-strand-offline-mode-nativescript` rewritten down to their remaining work, each saying in its body that the storage (resp. platform) half landed with this adoption so the next reader does not redo it; `backlog/later/5-quota-enforcement` rewritten to its three still-missing arms (per-strand usage accounting, usage reported for billing, a machine-wide rather than per-network budget) with the "blocked on Arachnode" framing dropped; `backlog/later/3-mobile-resource-awareness`'s one stale `storage.quotaBytes` line replaced; `debt-shared-store-provider-never-exercised-end-to-end` deleted (see below).

**Two web-app e2e fixtures** (`cadre-member.ts`, `formation-responder.ts`) were still on `MemoryRawStorage` / `storage.provider` — leftovers from an earlier ticket in the chain, now on `memoryNodeStorage()` and `storage.open`. They are what the typecheck would otherwise fail on.

## Why `debt-shared-store-provider-never-exercised-end-to-end` went

Its subject was the "one `IRawStorage` for every scope" form of `storage.provider`, which ticket 2 removed outright: `OpenNodeStorage` carries a `close()` a shared instance would have closed once per scope, `levelDbNodeStorage` refuses a second call over one handle, and an embedder that wants sharing now gets it from `fileNodeStorage`'s holder counting. The counting invariant the ticket existed to protect moved upstream into `withReadCache` and is tested there. There is no longer a code path for the ticket to exercise, so there was nothing to keep.

## The reply to gotchoices/sereus#67 — ready for a human to post, NOT posted

Posting was deliberately left to a human: the issue is outward-facing. The issue's own two gaps were the unregistered `blobref` type (already fixed in 1.24) and blobs lost on hibernate; the reporter's follow-up comment then asked for three things in priority order, and this release answers the first. Suggested text:

> This release (Optimystic 1.30.0, Quereus 5.7.1) answers the first of the three things your comment asked for, and we think it closes the hibernate repro.
>
> **1. A persistent piece store and `kvStore` on strand nodes — done, on every platform.** A node now takes all of its storage as one value (Optimystic's `NodeStorage`: blocks, the node-local key-value store and blob pieces together), and that value has no part a platform can leave out, so there is no longer a way for a node to be built with a file block store and a memory piece store. `CadreNodeConfig.storage.provider` is replaced by `storage.open(scope)`, which returns that whole value; each platform calls its own storage package's factory — files on Node (cadre-cli, cadre-host, cadre-provider), LevelDB on React Native, SQLite on NativeScript, IndexedDB in the browser. A strand node a machine runs as a *client* — holding none of the strand's blocks — now gets a storage scope too, precisely because the pieces it holds may be its own host's only copy. `blob-survives-hibernate.mjs` should pass as written; please re-run it, since the repro lives in your tree and not ours.
>
> **2. `hold: 'on-demand'` for the `device` class — not done.** Tracked in `feat-strand-blobs-persist`, along with the open question of whether that choice follows the node class or becomes a per-machine role. Until it lands, a phone that is a cohort member holds its strand's blobs eagerly, which is the wrong default for a photo library.
>
> **3. Access to the strand node's blob service from the app — not done.** Also in `feat-strand-blobs-persist`. `instance.libp2pNode.blobs` is still the only way in and is still not a supported surface; the decision to make is whether it hangs off the strand handle an app already holds or comes through the SQL plugin keyed on the table. Because of 2 and 3, `docs/schema-guide.md` still says not to declare a `blobref` column yet.
>
> Two things to know about the upgrade itself. Every machine of a party, and every partner of a strand, has to move together: a coordinator on 1.29.1 counts an out-of-space vote as neither an approval nor a rejection, so a writer gets a promise shortfall instead of being told the cohort is full. And a node now measures what it stores against an allotment the operator sets, shrinking its blob read cache as it fills and refusing new data above 95%; on a phone the kit declares that figure for you (2 GiB by default, overridable), because LevelDB and SQLite report no free space of their own.
>
> One limit worth stating plainly, since it bears on a strand whose history is mostly blocks: a node cannot yet free old revisions of blocks it is still responsible for, so a node whose disk is mostly block history reaches its refusing stage and stays there until its allotment is raised. Optimystic's three automatic responses to pressure — ring move-in, ring move-out and the released-block sweep — are all driven by its rebalance reaction, which every Sereus node turns off because it runs its own peer-join block catch-up instead; so peers do not take a full node's ranges here either. Upstream tracks the reclaim work as `feat-cold-range-transform-offload`.
>
> We would take you up on the Galaxy S7 / S21 offer for part 1 whenever it suits.

## Figures this chain moved

- **A phone's storage allotment: 2 GiB** — `DEFAULT_DEVICE_STORAGE_ALLOTMENT_BYTES` in `packages/cadre-core/src/edge-node/platform.ts`, overridable per app through `PhoneNodePlatform.storageAllotmentBytes` on React Native. Declared because LevelDB and SQLite report no free space; the browser deliberately declares none, since IndexedDB reports the origin's own estimate.
- **The refusal threshold: 0.95** of the smaller of the allotment and the backend's free space — upstream's `refuseAbove` default, with `reclaimBelow` 0.40 and `shedAbove` 0.85 beside it (the latter two inert here).
- **Restart timings the suite reported**, for anyone wondering what "survives a restart" costs: the offline-queue restart scenario 52 s; the joiner's first commit over a slow relay, restarting over its kept storage, 277 s, and 313 s for the variant that stays on the slow link.

## Validation

Run from the repository root on this tree:

- `yarn build` — green (1 m 33 s).
- `yarn typecheck` — green, plus the three coverage checks (every `vitest.config.ts` and all 475 collected test files inside their package's type-check program; stale-build guard wiring OK).
- `yarn lint` — green, including `yarn check:docs`: 67 Markdown files OK, so `docs/cadre/node.md` is inside its 6,000-word budget after ticket 2's rewrite, every list item inside 120, and every link and heading anchor in the new release notes resolves.
- **Per-package tests, all green:** quereus-plugin-sereus 148 passed, cadre-rn 178, reference-app-ns 72, cadre-cli 298, cadre-provider 234, reference-app-rn 180, cadre-host 444, reference-app-web 11, cadre-core 2713 (199 files, 430 s).
- **Root script tests, all green:** dep-ranges, check-docs, vitest-typecheck-coverage, test-file-typecheck-coverage, stale-build-guard-wiring, published-smoke-support (24), published-check-support (12), publish-package (20), release-support (13), release-preflight (15), release-guard (11), release-finish (16), await-published (16).
- **Integration tests** were run as six shards (`vitest run --shard=N/6`) so each call fit the agent's 10-minute tool ceiling. Shards 1, 2, 3, 5, 6 green. **Shard 4: one failure, load-related and not caused by this ticket** — `strand-moves-between-cadres` → "the other member keeps syncing and the new cadre's always-on machine hosts them" timed out after 60 s in `expectReplicaOnM`'s block-coverage wait, with the gap two blocks one revision behind (replication in progress, not stalled). Run alone it passes in 23.5 s. `tickets/.pre-existing-known.md` already carries a `one-off` entry for this same test from the 2026-10-15 release gate with a different fingerprint (`rowArrives`, 90 s), whose confirm protocol asks for a measurement under load if it recurs — so this recurrence is reported in `tickets/.pre-existing-error.md` with both numbers, for the runner's triage pass. Nothing was skipped or loosened.

`yarn test` as a single command was never run end-to-end: the shard split and the per-package split were forced by the tool timeout. The set of packages and root scripts above is the whole of what that script runs.

## What a reviewer should look at

The risk here is a sentence, not a crash. Worth checking in order:

- **Does each release-note bullet match the code?** The claims spot-verified against the tree while writing this handoff: `DEFAULT_DEVICE_STORAGE_ALLOTMENT_BYTES` = 2 GiB, `cohortOutOfSpaceOf` exported from both `@serfab/cadre-core` and `@serfab/quereus-plugin-sereus`, `CADRE_STORAGE_ALLOTMENT` mapping to `storage.allotmentBytes` in cadre-cli and emitted by cadre-provider, `refuseAbove` 0.95 upstream. The rest of the section was written against tickets 1–4 rather than re-read from the code, so the bullets about the offline queue keeping a refused entry, the `EdgeNodeStorage` journal-prefix reasoning, and the NativeScript "builds an offline queue even in online mode" claim are the ones most worth confirming.
- **The sereus#67 reply says the hibernate repro "should pass", not that it does.** We cannot run a script that lives in the reporter's tree. If a reviewer thinks that hedge is too weak or too strong, the wording is theirs to set — but it should not become a flat claim without something that actually exercises a hibernate-and-wake over a persistent piece store.
- **Three bullets describe behaviour that is inert here** (ring move-in, ring move-out, the released-block sweep). They are in the notes because an operator reading Optimystic's own release notes will expect them. Check the claim that every Sereus node turns off the rebalance reaction, since the whole paragraph rests on it.
- **The rewritten backlog tickets' `files:` and `tradeoffs:`** should name where the *remaining* work is and why a maintainer might still decline it. `feat-strand-blobs-persist` kept its `architecture:` anchor (`docs/schema-guide.md#limits-and-accepted-tradeoffs`) while its subject narrowed to an API surface — judge whether that anchor still fits or should move to `docs/strands/app-schema.md`.
- **Nothing in the release notes was checked against a reader who has not followed this chain.** It is the one deliverable here whose audience is outside the repository.
