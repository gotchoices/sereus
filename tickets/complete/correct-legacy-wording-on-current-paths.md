description: Comments that called a current, working code path "legacy" were corrected so live design stops reading like leftover cruft, and one removal a maintainer had already declined is now recorded at the code site as a deliberate tradeoff.
files: packages/cadre-core/src/control-schema.ts, schemas/control.qsql, packages/cadre-core/src/strand-formation-manager.ts, packages/cadre-core/src/control-database.ts, packages/cadre-core/src/types.ts, packages/cadre-core/src/strand-solicitation.ts, packages/cadre-core/test/control-authorization-binding.spec.ts, packages/cadre-core/test/control-formation-invite.spec.ts, packages/cadre-core/test/cadre-node-identity.spec.ts, docs/architecture.md
difficulty: easy
---

# Say "legacy" only where something is actually legacy

Comment-only work. No executable statement, schema DDL, or signed digest byte
changed — `FormationInvite` authorization digests sign column *values*, not
comments, so nothing here alters what peers agree on.

## What shipped

1. **`FormationInvite.StrandId` nullable column** — `control-schema.ts:490` and
   its mirror `schemas/control.qsql:479` said `null => legacy responder-provisions
   path`. Now describes the live design: null means an **unbound** invite, where
   the responder provisions a fresh open strand and atomically records its one
   consent row. Same fix at `control-database.ts:1919`.

2. **`strand-formation-manager.ts` `provisionUnbound` arm 2** — was "the
   legacy/mock contract"; it is the mock/transport-test contract (a
   `StrandProvisioner` with no real recorder, used by unit and integration tests,
   not an old version of anything). Reworded, and the plan-stage decision to keep
   the arm is now a greppable `NOTE: accepted tradeoff — …` carrying the reason
   and the revisit condition. A dangling pointer to a nonexistent backlog slug
   (`formation-initiatorcreates-cover-or-remove`) was dropped.

3. **`types.ts:411`** (`CadreNodeConfig.keyStore` doc) — "Absent ⇒ legacy
   behavior" now states the actual precedence: falls back to `privateKey` when
   set, else libp2p generates an ephemeral key. Mirrored in `docs/architecture.md`
   (the `CadreNodeConfig` code block and identity-resolution steps 3 and 4).

4. **`control-database.ts:845` and `:913`** — "Missing/legacy column values are
   coalesced" → "Missing/null column values", which is what the defensive
   coalescing is actually for (a row that was never published, not one written by
   an older build).

5. **`strand-solicitation.ts:44`** — the `unbound` arm of `resolveStrand`'s
   discriminated union was parenthetically "legacy/open"; now "unbound/open".

6. **Three test-file sites** carrying the same two mislabels (added at review):
   `control-authorization-binding.spec.ts:123` ("unbound/legacy path"),
   `control-formation-invite.spec.ts:1354` ("legacy/open path"), and
   `cadre-node-identity.spec.ts:135` (a test title reading "(legacy path)" for the
   supported `privateKey` route).

## Left alone deliberately

Every surviving use of the word in `packages/cadre-core`, `schemas/`, and `docs/`
names something genuinely retired:

- `push-notifier-fcm.ts:5` — Google's actually-deprecated FCM server-key HTTP API,
  contrasted with the HTTP v1 API this file uses.
- `strand-solicitation.ts:289` / `:299` — the `formStrand(invitation: OpenInvitation
  | string)` bare-token arm is a real superseded call shape. Already owned by
  `tickets/implement/retire-form-strand-string-overload`, which removes it.
- `peer-authorization.spec.ts:101-127` — a regression test asserting that an old
  untagged digest construction is *rejected*. Genuinely legacy, deliberately kept.
- `docs/architecture.md:1114` / `:1148` and `docs/reference-app-rn.md:158-160` —
  the one-time migration off the old plaintext identity store into the
  secure-enclave `KeyStore`.

## Review findings

**Checked:** the implement diff read fresh before the handoff summary; the
`control-schema.ts` ↔ `schemas/control.qsql` comment line compared byte-for-byte
(identical); a `legacy|deprecated|backward.compat` grep across the **whole repo**
rather than the three paths the implementer swept (this closes the implementer's
own stated gap); `docs/architecture.md`, `docs/api.md`, `docs/strands.md`, and
`docs/reference-app-rn.md` read for drift against the new wording; `yarn lint`;
`yarn workspace @serfab/cadre-core test`.

**Minor — fixed in this pass:**

- *The sweep stopped at `src/`.* Three test files carried the identical mislabels
  the ticket existed to remove (item 6 above). Fixed inline. The scope error, not
  the three lines, is the finding: a wording sweep that greps only `src` leaves
  the next reader meeting the same wrong word in the tests that document the path.
- *The new `NOTE:` duplicated the prose it sat beneath.* `provisionUnbound` ended
  up with a "Plan tradeoff" paragraph and a `NOTE: accepted tradeoff` paragraph
  giving the same reason (~6 unit + ~6 integration sites, zero production
  benefit) in different words. The implement ticket said not to delete the prose
  while adding the `NOTE:`, and the literal reading produced a redundancy that
  will drift apart on the next edit. Merged into one `NOTE: accepted tradeoff`
  block keeping the (a)/(b) framing, the measured churn, and the revisit
  condition. Nothing was lost.

**Major — none filed, and here is why.** The one judgment call the implementer
flagged for a second look (`strand-solicitation.ts:289`/`:299`, the `formStrand`
string overload, which does read like a kept-for-compat shim against the
project's "no backwards compat yet" convention) is already claimed by
`tickets/implement/retire-form-strand-string-overload` — an open ticket in a
*later* pipeline stage that removes exactly this arm. Filing anything would have
been a duplicate. The implementer's call to leave the word in place was correct:
it is genuinely legacy, and it is already being retired.

**Tripwires — none recorded, and the reason is that the obvious candidate is
already guarded.** The one architectural risk this ticket touches is drift between
the two hand-synced copies of the control schema (`control-schema.ts` and
`schemas/control.qsql`), which is exactly the failure a comment-only edit could
introduce silently. That is not a tripwire because
`packages/cadre-core/test/control-schema-drift.spec.ts` already asserts the two
match and fails with an instruction to mirror the edit in both — a boundary
invariant, in place and passing. No other concern in this diff is conditional on
a future event; comments have no runtime, resource, or performance surface.

**Validation:** `yarn lint` → exit 0, clean. `yarn workspace @serfab/cadre-core
test` → 104 test files, 1644 passed, 1 skipped (pre-existing), exit 0. The one
skip is pre-existing and unrelated; nothing was skipped, disabled, or loosened.
