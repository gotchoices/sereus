description: Review the strand schema drift guard — a vitest unit test that fails whenever the embedded STRAND_SCHEMA diverges from the body of schemas/strand.qsql. Mirrors the landed control-schema-drift-guard but handles the body-only vs. full-file asymmetry via a comment/string-aware brace-matched extractor.
files: packages/quereus-plugin-sereus/test/strand-schema-drift.spec.ts (NEW), packages/quereus-plugin-sereus/src/strand-schema.ts, schemas/strand.qsql, packages/cadre-core/test/control-schema-drift.spec.ts (template)
----

## What landed

A single new file: `packages/quereus-plugin-sereus/test/strand-schema-drift.spec.ts`.
No production code changed — `src/strand-schema.ts` and `schemas/strand.qsql` are
untouched (verified: `git status` shows only the new test file).

The guard protects the security-critical `Strand` membership/RBAC schema, which is
duplicated across two hand-maintained copies with no drift protection before this:

- `schemas/strand.qsql` — on-disk canonical copy: a full `declare schema Strand { ... }`
  block, preceded by a 17-line `--` comment header, with **no** `apply schema Strand;`
  line (apply is added only at runtime by `composeStrand`).
- `STRAND_SCHEMA` in `src/strand-schema.ts` — the embedded runtime copy that runs in
  React Native / filesystem-less environments. Holds only the **inner table-declaration
  body** (starts at `    table Header (`), not the full declare/apply wrapper.

Because the control guard compares whole-file == whole-constant (its constant embeds
the full declare/apply) but `STRAND_SCHEMA` is body-only, this guard instead:

1. Extracts the text strictly inside `declare schema Strand { ... }` from the `.qsql`
   file using a **comment/string-aware, brace-matched scanner**, then
2. compares `normalize(extractedBody)` === `normalize(STRAND_SCHEMA)`.

### Why a real scanner (not a regex) — the load-bearing risk

`schemas/strand.qsql`'s own comment header (lines 6–9) **literally contains the text**
`declare schema Strand { ... } apply schema Strand;`. A naive
`indexOf('declare schema Strand')` or regex anchors **inside that comment** and extracts
garbage. The extractor is a small tokenizer state machine (decomposed single-purpose
helpers: `skipLineComment` / `skipBlockComment` / `skipStringLiteral` / `skipNonCode` /
`matchSchemaAnchor` / `findSchemaOpenBrace` / `findMatchingBrace`) that skips `--` line
comments, `/* */` block comments, and `'...'` string literals (with `''` escaping) both
when locating the anchor and when brace-matching to the close `}`.

### Normalization

Mirrors the control guard's normalize (CRLF→LF, strip trailing horizontal ws, drop
trailing blank lines/newline) **plus one delta**: a `^\n+` rule that strips leading
blank LINES. This is required because the extracted body begins with the `\n` after the
opening `{`, whereas `STRAND_SCHEMA` begins directly at `    table Header (`. It strips
blank *lines*, not leading *spaces*, so a real reindent of `table Header` still trips
the guard (there is an explicit unit test asserting this).

## Validation performed (this is a floor — treat as a starting point)

- `yarn workspace @serfab/quereus-plugin-sereus exec vitest run --project unit` →
  **4 files, 45 tests passed** (17 new from this spec).
- `yarn workspace @serfab/quereus-plugin-sereus typecheck` → exit 0.
- `npx eslint <new file>` → exit 0 (clean).
- **Guard-bites check (the important one):** temporarily changed one char in
  `STRAND_SCHEMA` (`UUID`→`UUIX`), re-ran the guard test → it went **red** with the
  actionable message:
  `Strand schema drift detected ... Mirror your edit in BOTH
  packages/quereus-plugin-sereus/src/strand-schema.ts and schemas/strand.qsql.
  First difference at line 2: ...`. Then reverted; suite green again.
- e2e project deliberately **not** run (spins up real libp2p; this guard is unit-only).

### Extractor unit tests included (so the guard can't be silently fooled)

The main guard test is backed by 15 extractor/normalize tests exercising: anchor-in-
`--`-comment, anchor-in-`/* */`-comment, `}` inside `--` comment, `}` inside `/* */`
comment, `}` inside a string, `''`-escaped string containing `}`, nested `{ }`,
whitespace-run tolerance between anchor tokens, whole-identifier name matching
(`X` must not match `XY`), trailing-`apply`-line independence, missing-block throw,
name-only-in-comment throw, unbalanced-block throw, and the leading-blank-line
normalization preserving indentation.

## Use cases / what to scrutinize during review

The reviewer should treat the tests above as a floor. Suggested adversarial angles:

- **Confirm the guard genuinely catches a *one-sided* edit in the OTHER direction** —
  the validation above edited `STRAND_SCHEMA`; try editing only `schemas/strand.qsql`
  (e.g. change a `verify(...)` arg or a constraint name) and confirm red. Both
  directions go through the same compare, but worth a sanity pass since this schema
  gates RBAC writes.
- **Re-derive the byte-equivalence claim**: the planning ticket asserted the two copies
  are byte-equivalent under this normalize on master. The green guard test confirms it,
  but the reviewer may want to eyeball the diff is truly empty (it is — the test passes
  with an exact `toBe`).
- **Extractor robustness vs. the actual file**: the scanner only *needs* to handle the
  current file shape, but is written defensively. Consider whether any realistic future
  edit to `strand.qsql` could fool it (see Known gaps).

## Known gaps / honest limitations (NOT fixed here — by design or flagged)

- **Drift guard only, not single-sourcing.** Codegen / true single-sourcing of the
  schema remains deferred — identical scope decision to the control guard's "Known
  gaps". Two copies still exist; this only fails the build when they diverge.
- **No comments *between* anchor tokens.** `matchSchemaAnchor` tolerates whitespace
  runs between `declare` / `schema` / `Strand` / `{`, but NOT a comment between them
  (e.g. `declare /* x */ schema`). The current file has none; flagged so a reviewer
  doesn't assume full generality.
- **Non-nested block comments only.** The scanner treats the first `*/` as closing a
  `/* */` (standard SQL semantics). If Quereus ever supported nested block comments,
  the scanner would need revisiting. None exist in the file today.
- **Only single-quoted string literals are recognized.** Double-quoted / backtick
  *identifiers* are not treated as quoted spans. If a future schema used a quoted
  identifier containing `{`, `}`, `'`, or `--`, the scanner could miscount. The current
  schema uses none. Low risk, but a real limitation of the lexer.
- **Failure line number is relative to the normalized body, not the `.qsql` file.**
  The first-diff message says "line N" where N is the line within the compared body
  (so the `.qsql` file line is ~N+18 due to the comment header + `declare` line). This
  matches the control guard's "line-within-compared-text" behavior; not changed, but a
  reviewer reading a future failure should know the number isn't a raw file line.
- **Third-copy note is a code comment only.** The spec documents (in a header comment)
  the deliberate copy-vs-shared-util decision and that a *third* embedded-schema copy
  should prompt extracting a shared parameterized helper. No helper was built (correct
  per the resolved design — exactly two consumers in two packages).

## Disposition guidance for the reviewer

Per review-stage rules: minor findings (wording, an extra extractor edge test, a
clearer failure message) → fix inline and note in `## Review findings`. Anything that
would change the design (e.g. deciding to single-source the schema via codegen, or to
extract the shared helper now) → spawn a new `backlog/` or `plan/` ticket rather than
expanding this one.
