description: Add a drift guard test that fails the suite whenever the embedded STRAND_SCHEMA diverges from the body of schemas/strand.qsql. Generalizes the (already-landed) control-schema-drift-guard to the strand membership/RBAC schema, handling the body-only vs. full-file asymmetry.
files: packages/quereus-plugin-sereus/test/strand-schema-drift.spec.ts (NEW), packages/quereus-plugin-sereus/src/strand-schema.ts, schemas/strand.qsql, packages/cadre-core/test/control-schema-drift.spec.ts (template), packages/quereus-plugin-sereus/vitest.config.ts
----

## Goal

The strand membership/RBAC schema is duplicated across two hand-maintained copies
with **no drift protection** today:

- `schemas/strand.qsql` — on-disk canonical copy (full `declare schema Strand { ... }`).
- `STRAND_SCHEMA` in `packages/quereus-plugin-sereus/src/strand-schema.ts` — the
  embedded runtime copy that actually runs in React Native / filesystem-less
  environments (`composeStrand` wraps it in `declare schema Strand { ... } apply
  schema Strand;` at runtime).

This schema gates strand membership, invites, and RBAC writes, so a one-sided edit
is a silent security regression — the exact risk that motivated the (now complete)
`control-schema-drift-guard`. Add the equivalent guard for the strand schema.

This ticket adds **only the guard**. Codegen / true single-sourcing of the schema
remains deferred (see the control ticket's "Known gaps").

## Design (resolved — do not re-litigate)

The `packages/cadre-core/test/control-schema-drift.spec.ts` is the template. Two
decisions were settled during planning; implement them as written:

### 1. Copy-and-adapt, do NOT build a shared cross-package util (Option 2)

There are exactly two consumers and they live in **different packages**
(`cadre-core` vs. `quereus-plugin-sereus`). A shared helper would need a cross-package
test-util home and coupling that two consumers don't justify. Copy the spec's shape
into `quereus-plugin-sereus` and adapt it. (Note for a future maintainer: a **third**
embedded-schema copy would tip the balance toward extracting a shared parameterized
helper — call that out in a code comment, but do not build it now.)

### 2. Compare the *body* of strand.qsql against STRAND_SCHEMA (NOT full-to-full)

The control guard compared whole-file == whole-constant because `CONTROL_SCHEMA`
embeds the full `declare schema ... apply schema ...`. `STRAND_SCHEMA` is **not**
symmetric — it holds only the inner table-declaration **body**.

The planning ticket floated "wrap `STRAND_SCHEMA` through the `composeStrand` path and
compare full-to-full" as possibly cleaner. It is **not practical here**, and we
deliberately reject it:

- `composeStrand` performs the wrap with **inline template-literal interpolation**
  (`compose-strand.ts` ~lines 260-265), not via a reusable pure function, and it is
  entangled with plugin/node/db setup that a unit test cannot call.
- `schemas/strand.qsql` has a **leading comment header** (lines 1-17) and **no
  `apply schema Strand;` line** (the file ends at the closing `}`; `apply` is added
  only at runtime). So there is no clean full-file form of the constant to compare to.

Therefore: **extract the body inside `declare schema Strand { ... }` from
`schemas/strand.qsql` with a real comment/string-aware brace-matched scanner**, then
compare it (normalized) against the normalized `STRAND_SCHEMA`. Reuse the control
guard's first-differing-line message, naming **both** files to edit.

### Why the extraction must be comment/string-aware (load-bearing)

`schemas/strand.qsql`'s **own comment header literally contains the text**
``declare schema Strand { ... } apply schema Strand;`` (lines 6-7) and
``declare schema Strand { ... }`` again (line 9). A naive
`indexOf('declare schema Strand')` / regex anchors **inside the comment** and
extracts garbage. The scanner must therefore skip `--` line comments, `/* ... */`
block comments, and `'...'` string literals (with `''` escaping) **both** when
locating the `declare schema Strand {` anchor **and** when brace-matching to its
closing `}`. This is exactly why "a real brace-matched extraction, not a janky regex"
is required (AGENTS.md: no half-baked janky parsers).

Today the body contains no interior `{`/`}`, no braces-in-strings, and no
braces-in-comments — so the matching close brace is the final `}`. The scanner must
nonetheless be written to handle all of the above so a future edit can't silently
fool it.

## Normalization (mirror the control guard, plus one rule)

Reuse the control guard's normalize, which tolerates ONLY EOL / trailing-whitespace /
trailing-newline differences and deliberately does NOT collapse interior whitespace or
strip comments (so any real content change — an altered `verify(...)` arg, a
tab-vs-space reindent — trips it):

```ts
const normalize = (s: string): string =>
  s.replace(/\r\n/g, '\n')   // CRLF -> LF (repo uses core.autocrlf)
   .replace(/[ \t]+$/gm, '')  // strip trailing horizontal whitespace per line
   .replace(/^\n+/, '')       // NEW: drop leading blank lines — the extracted body
                              // begins with the newline after `{`; STRAND_SCHEMA
                              // begins directly with `    table Header`
   .replace(/\n+$/g, '')      // drop trailing blank lines / final newline
   .trimEnd();
```

The added `^\n+` rule is the only delta vs. the control guard: the extracted body
starts with the `\n` that follows the opening `{`, whereas `STRAND_SCHEMA` starts
directly at `    table Header (`. Stripping leading blank LINES (not leading
whitespace) preserves the 4-space indentation of the first content line, so a real
indentation change still trips the guard. Confirmed: with this normalize the two
copies are byte-equivalent on current master.

## Path resolution

The new spec lives at `packages/quereus-plugin-sereus/test/strand-schema-drift.spec.ts`.
Repo root is three levels up (`test/` → `quereus-plugin-sereus/` → `packages/` → root),
identical depth to the control guard:

```ts
const QSQL_URL = new URL('../../../schemas/strand.qsql', import.meta.url);
```

It is a pure/fast unit test (file read + string compare; no network, no db). The
`unit` vitest project (`vitest.config.ts`: `include: ['test/**/*.spec.ts']`, e2e
excluded) picks it up automatically under `yarn test` — no config change needed.

## Edge cases & interactions

- **Anchor-in-comment (the headline risk):** `schemas/strand.qsql` contains
  ``declare schema Strand { ... }`` inside its leading `--` comment header. The
  extractor MUST ignore those occurrences and anchor on the first *real* (non-comment,
  non-string) `declare schema Strand {`. Add a unit assertion proving the extractor
  picks the real block, not the comment text.
- **Brace inside a comment / string:** today there are none, but the scanner must skip
  `{`/`}` that appear inside `--` line comments, `/* */` block comments, and `'...'`
  string literals when counting depth. Cover each with a small synthetic-input unit
  test of the extractor (e.g. a body containing `-- a } b`, `/* } */`, and `'}'`).
- **`''` escaping inside string literals:** a `'...''...'` literal must not be read as
  closing early. Cover with a synthetic input.
- **Whitespace tolerance in the anchor:** match `declare`, whitespace, `schema`,
  whitespace, `Strand`, optional whitespace, `{` as tokens — tolerate run-of-spaces /
  newlines between tokens, but keep `Strand` an exact (case-sensitive) identifier match.
- **No `apply schema Strand;` in the file:** the file ends at the closing `}`. The
  scanner stops at the matching `}` and never depends on an `apply` line. If a future
  edit adds one after the `}`, extraction is unaffected.
- **Missing/renamed block:** if `declare schema Strand {` cannot be found (e.g. someone
  renames the schema or deletes the file body), the extractor must throw a clear error
  rather than silently return `''` and "pass" by comparing empty-to-empty. Assert this
  failure mode.
- **Leading-newline normalization:** verify the `^\n+` rule does NOT eat the first
  content line's indentation (it strips blank lines, not leading spaces) — otherwise a
  real reindent of `table Header` would be masked.
- **Trailing whitespace / CRLF on checkout:** the repo uses `core.autocrlf`; the
  CRLF→LF and trailing-whitespace rules already cover git-delivered CRLF and any
  editor trailing-space noise. No interior collapse.
- **Cross-guard independence:** this spec lives in `quereus-plugin-sereus`; the control
  guard stays in `cadre-core`. No shared module, no import coupling between them.

## Suggested structure

Keep it one file for parity with the control guard's single-file pattern. Put the
comment/string-aware `extractDeclareSchemaBody(source, schemaName)` as a small,
single-purpose function (decomposed scanner — a tiny tokenizer state machine, not one
mega-regex) either at the top of the spec or in a sibling `test/` helper module if you
prefer it independently unit-testable. Then:

- one `it(...)` asserting `STRAND_SCHEMA` matches the extracted body of
  `schemas/strand.qsql` (the actual guard, with the first-diff message naming both
  `packages/quereus-plugin-sereus/src/strand-schema.ts` and `schemas/strand.qsql`);
- a handful of `it(...)`s exercising the extractor against the synthetic edge-case
  inputs above (comment-brace, string-brace, `''` escape, comment-anchor, missing
  block) so the guard can't be silently fooled into extracting the wrong text.

## TODO

- Add `packages/quereus-plugin-sereus/test/strand-schema-drift.spec.ts`.
  - Implement `extractDeclareSchemaBody(source, schemaName)` as a comment/string-aware,
    brace-matched scanner that returns the text strictly inside the matching braces and
    throws if the named `declare schema <name> {` block is absent.
  - Implement the `normalize` helper (control guard's + the `^\n+` rule) and a
    `firstDiffLine` helper (copy from the control guard).
  - Main guard test: `normalize(STRAND_SCHEMA)` === `normalize(extractDeclareSchemaBody(
    fileContents, 'Strand'))`, with an actionable message naming both files.
  - Extractor unit tests for each edge case in "Edge cases & interactions".
- Add a one-line comment in the spec noting the deliberate copy-vs-shared-util decision
  and that a third embedded-schema copy should prompt extracting a shared helper.
- Run `yarn workspace @serfab/quereus-plugin-sereus test` (the `unit` project; stream
  with `2>&1 | tee`) and confirm green on current master.
- Sanity-check the guard actually bites: temporarily make a one-sided edit (e.g. change
  one character in `STRAND_SCHEMA`), confirm the suite goes red with the first-diff
  message naming both files, then revert. Note the result in the review handoff.
- Run `yarn workspace @serfab/quereus-plugin-sereus typecheck` to confirm types.
- Do NOT run the e2e project (it spins up real libp2p) — this guard is unit-only.
