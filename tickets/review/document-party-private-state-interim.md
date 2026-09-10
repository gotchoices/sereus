----
description: Documented where consumers should put per-user app state (read position, drafts, preferences) until the real party-private storage facility ships, and warned loudly that the interim spot is visible to every strand member.
files: docs/strand-contracts.md, docs/strands.md
prereq:
difficulty: easy
----

# Document the interim answer for party-private app state — implementation summary

Answers **gotchoices/sereus#6**. The real facility is deferred (`backlog/feat-party-private-app-state`);
this ticket is documentation only, no code/schema changes.

## What changed

- **`docs/strand-contracts.md`** — new section "Party-Private App State (Interim)", placed after
  "sApp Integration" and before "Self-Contained Storage: `Strand.Document`". States:
  - the interim answer: store the value in the strand database keyed by owning party;
  - the caveat, stated as a visibility fact rather than a physical-replication claim (see below):
    every member of the strand can read every row in the strand database regardless of key, so a
    per-user key partitions by owner but does not hide anything;
  - node-local storage (`packages/cadre-core/src/node-local-snapshot.ts`) ruled out explicitly:
    it never replicates, so state kept there does not follow the user to a second device;
  - one sentence flagging that data stored this way will need migrating once the real facility
    lands, with no migration plan implied;
  - deliberately says nothing about the future facility's shape (`backlog/feat-party-private-app-state`
    is undecided) beyond naming the ticket.
- **`docs/strands.md`** — the `strand` term definition (Terminology section) now cross-references
  the new subsection, so a reader arriving from either doc meets the caveat.

## Wording choice worth flagging to the reviewer

`docs/cadre-consistency.md` (line 22) states strand data replicates to a **subset** of nodes
(`DEFAULT_STRAND_CLUSTER_SIZE`, currently 4) as a storage-versus-availability tradeoff — not to
every node's physical block store. The new section avoids contradicting that by phrasing the
caveat in terms of **read visibility** ("every member can read every row", via query/read-repair)
rather than "replicates in full to every node." The two are consistent: a block not locally
stored on a given member's node is still readable by that member through the normal query path.
Checked `docs/architecture.md`, `docs/cadre-host.md`, `docs/reference-app-rn.md`,
`docs/strand-contracts-review.md` for any existing claim that a party-private store already
exists — none found, no conflicts.

## How to validate

This is a docs-only change — no build/test surface. Validation is a read-through:

1. `docs/strand-contracts.md` → "Party-Private App State (Interim)" section reads standalone and
   doesn't promise a shape for the future facility.
2. `docs/strands.md` Terminology → `strand` bullet links correctly to the anchor
   (`strand-contracts.md#party-private-app-state-interim` — GitHub-style slug from the heading).
3. Confirm the caveat still reads true independent of the current `DEFAULT_STRAND_CLUSTER_SIZE`
   value (it's phrased as a visibility property of strand-database membership, not a specific
   replication number), so it won't need editing if that constant changes.

## Known gaps / left for reviewer judgment

- No changes made to `schemas/chat-simple.qsql`: it currently has no per-user table, so no
  worked example was added per the ticket's explicit instruction not to add a speculative table
  just to illustrate the pattern.
- `docs/cadre-consistency.md` itself was not edited — investigated for contradiction, found none
  (see wording-choice note above). If the reviewer disagrees that the visibility framing is
  clearly reconciled, that doc is the place to add a note.
