----
description: Docs and code comments now say plainly that Sereus's "4 copies" / "16 copies" replication numbers count machines, not independent people holding a copy — and today, for strand data, those machines all belong to one person's party.
files: packages/quereus-plugin-sereus/src/cluster-size.ts, docs/architecture.md, docs/strands.md
difficulty: easy
----

# What changed

Prose-only change across three files, per the ticket. No behaviour touched — no constant,
no function, no test.

**`packages/quereus-plugin-sereus/src/cluster-size.ts`**
- `DEFAULT_STRAND_CLUSTER_SIZE` doc comment: new paragraph "Four machines, not four parties."
  States cohort selection is owner-blind upstream (names `findCluster`, cites
  `optimystic/tickets/backlog/feat-cohort-selection-owner-aware-placement`) and that in
  production a strand mesh is seeded from one party's own control-DB peer rows
  (`CadreNode.resolveCohortSeed`), so four copies are four machines of one party today.
  Points at `docs/architecture.md` → "Replication cluster size" for full reasoning and
  `backlog/feat-strand-party-identity` for the fix.
- `CONTROL_REPLICATION_BREADTH` doc comment: one added paragraph — a cadre is one party by
  construction, so the owner-blind-selection question doesn't arise on the control network.

**`docs/architecture.md`**
- "Replication cluster size" → "What matters operationally" list: new first bullet stating
  both reasons the strand machine count isn't a party count (owner-blind cohort selection;
  single-party strand mesh in production), naming `findCluster` and
  `CadreNode.resolveCohortSeed`, with the upstream + Sereus backlog tickets. Also states the
  control network is exempt (party is one cadre by construction).
- "Strand Networks" → "Peer cohort" bullet corrected: was "(union of all member cadres)",
  now says that's the intended shape and today it's this party's cadre only, pointing at the
  open cross-party-discovery question in `docs/strands.md`.

**`docs/strands.md`**
- "Some Questions" → the existing "Within-party answer (implemented)" paragraph's
  cross-party-discovery sentence gets one appended sentence: until cross-party strand
  discovery lands, every strand cohort is one party's machines, so strand replication breadth
  buys machine redundancy within that party and zero party redundancy.

# Verified during implement

- Checked the three `docs/cadre-consistency.md` cross-references (lines ~20-30, "What Ships
  Today") and the one in `docs/STATUS.md` (~line 957) named in the ticket's edge-cases list.
  None needed a fix: they're all about the **control** network (where "whole party" is
  already the correct and intended cohort), or are bare pointers to the architecture.md
  section rather than restatements of "copies" as a party count. No edits made there —
  nothing to review on that front, but worth the reviewer spot-checking the same four spots
  since "reads correctly to me" is a judgment call.
- `yarn lint` — clean, exit 0.
- `yarn build` — exit 0. Only pre-existing warnings (large-chunk / dynamic-vs-static-import
  notices from `optimystic`'s `db-p2p` and `Fret` deps) — unrelated to this change, present
  before it, no source line in this diff is anywhere near them.

# What a reviewer should check

- This is a claims-in-prose ticket — there's no test to run that would catch a wrong claim.
  The check is a close read: does each new sentence match what the cited code actually does?
  Specifically worth re-verifying independently (I read but did not re-derive):
  - `Libp2pKeyPeerNetwork.findCluster` in `../optimystic/packages/db-p2p/src/libp2p-key-network.ts`
    really is hash-proximity + protocol-serving filter only, no owner/party concept.
  - `CadreNode.resolveCohortSeed` (`packages/cadre-core/src/cadre-node.ts`, ~line 3547 per the
    ticket) really does build `bootstrapNodes` solely from this party's own `CadrePeer` rows,
    with no caller-supplied cross-party override anywhere in `StrandConfig`.
- Confirm the new `docs/architecture.md` bullet and the `cluster-size.ts` paragraphs don't
  duplicate each other's paragraphs verbatim — ticket required "canonical in the doc, pointer
  in the code comment" and I aimed for that (code comment is ~5 sentences, doc bullet is the
  fuller version with the "one failure domain, one witness" framing only in the doc bullet).
  Worth a second look since the wording overlaps by design (same two facts, two audiences).
- I did not touch `docs/cadre-consistency.md` or `docs/STATUS.md` — confirmed clean per above,
  but a second read of those four spots (cheap, ~5 sentences total) closes out the ticket's
  edge-case checklist definitively rather than on my say-so.
- Ticket's two adjacent-but-not-merged notes hold: `backlog/debt-replication-proof-above-cohort-size`
  and `backlog/feat-strand-party-identity` both exist already (verified via `ls`), untouched.

# Known gaps / non-gaps

- No behavioural change was in scope and none was made.
- No new tests — ticket explicitly says "nothing asserts prose."
- `schemas/strand.qsql` / `strand-schema.ts` byte-equivalence: not touched, per ticket scope.
