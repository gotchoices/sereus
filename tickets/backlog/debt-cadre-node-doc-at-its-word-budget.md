----
description: One of the reference documents about a machine has grown to the size limit the documentation check enforces, so the next person who adds a sentence to it has their build fail on a rule that has nothing to do with what they were writing.
architecture: docs/cadre/node.md
files: docs/cadre/node.md, scripts/check-docs.mjs
difficulty: medium
tradeoffs: Splitting a document people already know the shape of costs every inbound link and heading anchor a rewrite, and a maintainer may prefer to keep one place to read about a machine and trim prose instead — which buys headroom once and leaves the same wall a few edits later.
----

# `docs/cadre/node.md` is at its word budget

`yarn lint` runs `scripts/check-docs.mjs`, which limits a document to 6,000 words. `docs/cadre/node.md` is now within a dozen words of that limit: measured during the review of `client-strand-waits-for-a-serving-machine`, a 19-word correction to one paragraph took it to 6,015 words and failed the gate, and the correction only landed because it was rewritten shorter than the sentence it replaced.

Measure it with `node scripts/check-docs.mjs` (the count it reports is not `wc -w`: it excludes code fences and link targets).

The effect is on whoever edits next, not on anyone reading today. The document is correct and the gate is doing its job. But the next person to add a sentence anywhere in it — documenting a new role, a new platform contract, a new storage option — gets a failure naming a size rule instead of their own change, and has to choose between trimming someone else's prose and doing an unplanned split under time pressure. Doing the split deliberately, once, is cheaper than making every future editor decide.

## What the document covers

It is the reference for one party's machine: node classes and what each turns on, the four roles and their presets, what `alwaysOn` changes, the machine that stores no workspace blocks, workspace filtering, storage and what the platform supplies, and the machine's own address record. Those are separable topics with separable readers — an app author choosing a node class, a platform author implementing the storage contract, and an operator reading the address record are three different people.

## What the split should preserve

- **Every inbound link and heading anchor.** The gate resolves links and anchors across the whole documentation set, and source comments cite headings by title (`docs/<path>.md → "Heading"`). Grep for each heading's title and update citations in the same change; the gate catches the links but not the source comments.
- **One home per fact.** A split that leaves the same mechanism described in two documents is worse than the long document. Each topic moves whole, with a one-sentence item linking to it from wherever it was.
- **The glossary's terms.** The split must not coin new names for things `docs/concepts.md` already names.
