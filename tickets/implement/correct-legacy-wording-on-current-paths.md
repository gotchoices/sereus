----
description: Several comments call a current, working code path "legacy", which makes live design look like leftover cruft someone should delete. Fix the wording, and record next to the one path a maintainer already decided to keep that the decision was deliberate.
files: packages/cadre-core/src/control-schema.ts, schemas/control.qsql, packages/cadre-core/src/strand-formation-manager.ts, packages/cadre-core/src/control-database.ts, packages/cadre-core/src/types.ts, docs/architecture.md
difficulty: easy
----

# Say "legacy" only where something is actually legacy

## Why this is a ticket and not a deletion

The compatibility sweep that produced this ticket looked at four places the code says "legacy" and
asked whether each was an accommodation for an older version of ourselves. **None of them is.** Each
is a current, live path wearing a misleading word — and the cost of leaving it is that the next
reviewer reads "legacy", reaches for the delete key, and either files a ticket to remove working
behaviour or removes it. The verification below is the substance of this ticket; the edits are
small on purpose.

### 1. `FormationInvite.StrandId` nullable — current design, keep

`control-schema.ts:490` (and its mirror `schemas/control.qsql:479`) documents the nullable column as
`null => legacy responder-provisions path`. It is not legacy. `docs/architecture.md:518` describes
it as live design: an **unbound** invite (`StrandId` null) takes the responder-provisions path,
where a database-backed recorder mints a fresh *open* strand and writes its single `FormationUsage`
consent row atomically (`provisionAndRecord` → `ControlDatabase.redeemInvitation`), so an unbound
redemption is single-use exactly like a bound one. Bound and unbound are two supported invite
shapes, and the schema pins each to its own constraints.

So: **no schema change.** Making `StrandId` non-null would delete the open-invite feature, not a
compatibility affordance. (`control-database.ts:1919` repeats the same wrong word for the same
column and gets the same fix.)

### 2. The `strandProvisioner` arm of `provisionUnbound` — already declined, record it

`strand-formation-manager.ts:397` calls arm 2 of the responder-provisions precedence "the
legacy/mock contract". It is the mock/transport-test contract: a `StrandProvisioner` with no real
recorder provisions a bare strand and writes no usage row, which is what the transport-level tests
need. The doc comment right below it already records a plan-stage decision that **kept** this arm
over removing it — removal would churn roughly six unit and six integration sites for no production
benefit, since production (`cadre-web.ts`, `cadre-phone.ts`) always publishes strand-bound invites
and treats the responder-provisions placeholder as failure.

That is an accepted tradeoff, but it is not written in the greppable form the project uses, so the
next reviewer re-derives it from scratch. Add a `NOTE: accepted tradeoff — …` line at that site
stating what was declined, why, and the revisit condition (production starts publishing unbound
invites, or the mock-transport tests go away). Do **not** remove the arm.

That comment also points at a backlog ticket `formation-initiatorcreates-cover-or-remove` which
does not exist in `tickets/` — a dangling reference. Drop the pointer; the `NOTE:` replaces what it
was for.

### 3. `keyStore` absent ⇒ "legacy behavior" — naming only

`types.ts:411` says an absent `keyStore` means "legacy behavior (use `privateKey`, else libp2p
generates an ephemeral key)". Both of those are current, supported ways to supply a node identity —
`privateKey` is direct injection, and the ephemeral case is what an unconfigured node does. Nothing
is deprecated. Say what the precedence actually is instead of labelling it. `docs/architecture.md`
carries the same word in three places (~953 "Direct keypair injection (legacy path)", ~1083 and
~1084 "(legacy behavior)"); fix them the same way, keeping the numbered precedence list intact.

### 4. "Missing/legacy column values are coalesced" — defensive, not versioned

`control-database.ts:845` (`queryPeerRecord`) and `:913` (`queryDeviceToken`) coalesce absent
columns to their empty form (`''` key/sig, `[]` addrs, `0` stamp) so the caller's verify and
freshness gates uniformly reject an unpublished or malformed row. That is handling for rows that
were never published, not for rows written by an older build. "Missing/null column values" says it
correctly; the rest of both doc comments is accurate and stays.

## Edge cases & interactions

- **`control-schema.ts` and `schemas/control.qsql` hold the same comment text and must stay in
  sync.** Change both, identically. A drift between the TypeScript-embedded schema and the `.qsql`
  artifact is exactly the kind of thing nobody notices until they diff the two.
- **This ticket changes comments only — no executable statement, no schema DDL, no signed digest.**
  The `FormationInvite` authorization digests sign column *values*, not comments, so nothing here
  can alter what peers agree on. If an edit would change a line that is not a comment, stop: it is
  out of scope and something has been misread.
- **Do not delete the `provisionUnbound` doc comment's tradeoff prose while adding the `NOTE:`.**
  The prose explains the decision; the `NOTE:` makes it greppable. Both belong.
- **`NOTE:` is the project's tag for tripwires and accepted tradeoffs alike** — keep the exact
  prefix so a single grep finds the whole set.
- **Watch for the word appearing in `dist/` build output.** Those are generated; ignore them and
  do not hand-edit.

## TODO

- Reword the `StrandId` comment in `packages/cadre-core/src/control-schema.ts` and, identically, in
  `schemas/control.qsql`: null means an **unbound** invite, where the responder provisions a fresh
  open strand and the recorder records its one consent row atomically. Same fix at
  `control-database.ts:1919`.
- In `strand-formation-manager.ts`, reword arm 2 from "the legacy/mock contract" to the
  mock/transport-test contract; add a `NOTE: accepted tradeoff — …` line at `provisionUnbound`
  capturing the declined removal, its reason, and its revisit condition; drop the dangling
  `formation-initiatorcreates-cover-or-remove` pointer.
- In `types.ts:411`, replace "legacy behavior" with the actual precedence (`privateKey` when
  supplied, otherwise libp2p generates an ephemeral key). Mirror it at `docs/architecture.md` ~953,
  ~1083, ~1084.
- In `control-database.ts` at ~845 and ~913, change "Missing/legacy column values" to
  "Missing/null column values".
- Grep `legacy` across `packages/cadre-core/src`, `schemas/`, and `docs/` and confirm every
  remaining hit either names something genuinely retired or belongs to `strand-proto` (owned by
  `publish-deprecated-strand-proto-decision`).
- Run `yarn workspace @serfab/cadre-core test` and `yarn lint`.
