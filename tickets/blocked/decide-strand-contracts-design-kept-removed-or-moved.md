description: The repository carries a long design for attaching signed human agreements to a shared database, while the sister document library's own documentation says the two maintainers agreed that this project will not implement agreements and that each app handles them itself. Decide whether the design stays, is removed, or moves, so the two projects stop saying opposite things.
files: docs/design/strand-contracts.md, docs/README.md, AGENTS.md, docs/concepts.md, ../stroc/docs/Sereus.md (read-only), packages/cadre-core/src/types.ts (`OpenInvitation`, `StrandFormationDisclosure`), schemas/strand.qsql
----

# Strand contracts: keep the design, remove it, or move it

**Blocked category:** the specification contradicts a statement of position held in a sibling repository, and nothing in this repository records that position. **Unblocks with:** a maintainer choosing A, B or C below (A is recommended). A and C become one small documentation ticket each; B needs no work beyond a sentence in the design.

## The two statements

`docs/design/strand-contracts.md` (about 5,250 words, headed "Design, not built") designs human agreements on strands as a Sereus feature. A strand is a database shared between parties. The design would add two columns to `Strand.Header` and three tables to `schemas/strand.qsql`, one table to `schemas/control.qsql`, a document-fetch protocol (`/sereus/doc/1.0.0`), and a field in the formation disclosure. Its "Code Placement" section puts the signing and registry writers and the effective-agreement computation in `@serfab/cadre-core`.

Stroc is the document library that design builds on (`../stroc`, a separate repository). Its `docs/Sereus.md` opens with a section called "Position":

> Sereus does not implement contracts (agreed by Kyle and Nate, October 2026). An app that wants documents or agreements manages them itself: storing documents, collecting signatures, deciding what is in force. Sereus strand invitations are planned to carry app-defined parameters, which an app may use to refer to a document; Sereus carries the reference and does not interpret it.

Its "Division of responsibility" table assigns "who signed what", "offers, acceptance, expiry, amendment, termination, what is in force" and "what a party has already reviewed and approved" to the app, and gives Sereus one row: "carrying a document reference in a strand invitation". Its "Source material" section calls the Sereus design "the design work this file grew out of, written when Sereus was expected to own contracts. Historical for Stroc; Nate owns them."

## What this repository records

- `AGENTS.md` and `docs/README.md` list the design among the designs not built, with no sign that it has been set aside.
- The design's own "Open Questions", item 1, says the two documents disagree on which layer owns the tables and that "the placement must be settled before any schema change". It treats as open what Stroc's document records as agreed.
- No ticket on the board or in the pruned ledger mentions contracts or Stroc.
- The one thing the Stroc position says Sereus will do is not built and not ticketed: `OpenInvitation` in `packages/cadre-core/src/types.ts` carries a token, an sApp id, an expiration and bootstrap addresses, and no app-defined field.

The evidence for the agreement is Stroc's document alone. This ticket's author could not check it against anything else. If that document misstates what was agreed, option B is the right answer and the recommendation below does not apply.

## Options

**A. Record the position here and remove the design (recommended).**

Delete `docs/design/strand-contracts.md` and its entries in `docs/README.md` and `AGENTS.md`. State the position where a reader deciding what an app must build will find it. Proposed text, for `docs/concepts.md` → "sApps":

> Sereus does not implement agreements between people. A strand pins the rules its members' nodes enforce: the sApp's identity, schema and signature. An app that needs documents, signatures over them, or a record of what is in force declares its own tables for them in its sApp schema and decides what they mean. Stroc (`gotchoices/stroc`) is a document library such an app can use; `docs/Sereus.md` there describes the division.

File one `feat-` ticket for the part Sereus keeps: a strand invitation carries app-defined parameters that Sereus passes through without interpreting. The design's "Pre-join availability" section is the only part that bears on it, and what it says about the consent signature should move into that ticket: the joiner's consent signature covers only the joiner's own disclosure text, so an invitation parameter is covered by nothing unless the joiner copies it into its disclosure.

Why recommended: `docs/README.md` describes `docs/design/` as "designs that are not built" and lists this one beside two others with nothing to tell them apart. A design the maintainers have agreed not to build then reads as pending work, which is the opposite of the decision. The text stays in git history and Stroc's document already points to it as its source.

What it costs: the design's analysis (signing and key class, supersession, the breakdown of reviewed sections, eight open questions) leaves the tree. An app team such as Taleus that wants it reads it from history or from wherever option C would put it.

**B. Keep it as a Sereus design.**

Appropriate only if the agreement Stroc records is not the maintainers' position, or has changed. Then Stroc's `docs/Sereus.md` is the document that is wrong, which is a ticket on Stroc's side, and the design's open question 1 should be replaced by a sentence saying Sereus owns the tables. Changes nothing in this repository otherwise. Rejected as the default because the only written statement of the decision says the opposite.

**C. Move it.**

Keep the content, out of Sereus's design set. Two places it could go:

- Stroc, as historical source material beside `docs/Sereus.md`, which already cites it by its old Sereus path. That path (`docs/strand-contracts.md`, and `docs/strand-contracts-review.md`, which the documentation rewrite deleted) no longer exists here, so Stroc's citation is already dead.
- The first app that implements agreements (Stroc's document names Taleus), as the starting point for that app's own design, since under the position the tables are the app's.

In either case this repository still needs the position paragraph and the invitation-parameter ticket from A. Rejected as the default because it needs a write in another repository and a decision by that repository's owner, and because A loses nothing that history does not keep.

## If nothing is decided

The design stays listed as intended work. Its open question 1 keeps blocking any schema change it describes, so nothing gets built from it by accident. The cost is confusion: an agent asked to plan agreement support in Sereus would start from this design, and a reader comparing the two repositories finds them contradicting each other with no way to tell which is current.

## Reversibility

A and C are documentation moves and fully reversible from git history. B is the status quo. None of the three changes code or a schema.
