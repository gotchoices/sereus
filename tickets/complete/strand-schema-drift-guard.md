description: Drift guard (vitest unit test) that fails whenever the embedded STRAND_SCHEMA diverges from the body of schemas/strand.qsql. Mirrors the landed control-schema-drift-guard but handles the body-only vs. full-file asymmetry via a comment/string-aware brace-matched extractor.
files: packages/quereus-plugin-sereus/test/strand-schema-drift.spec.ts (NEW), packages/quereus-plugin-sereus/src/strand-schema.ts, packages/quereus-plugin-sereus/src/compose-strand.ts, schemas/strand.qsql, packages/cadre-core/test/control-schema-drift.spec.ts (template), docs/architecture.md
----

## What landed

A single new file: `packages/quereus-plugin-sereus/test/strand-schema-drift.spec.ts`
(375 lines). No production code changed — `src/strand-schema.ts` and
`schemas/strand.qsql` are untouched.

The guard protects the security-critical `Strand` membership/RBAC schema, which is
duplicated across two hand-maintained copies (on-disk `schemas/strand.qsql` full
`declare schema Strand { ... }` block, vs. the body-only embedded `STRAND_SCHEMA`
constant that runs in filesystem-less environments). Because the embedded copy holds
only the inner table-declaration body, the guard extracts the text strictly inside
`declare schema Strand { ... }` from the `.qsql` file using a comment/string-aware,
brace-matched tokenizer (a real scanner, because the file's own 17-line comment header
literally contains `declare schema Strand { ... } apply schema Strand;`, which a naive
`indexOf`/regex would false-anchor on), then compares `normalize(body)` ===
`normalize(STRAND_SCHEMA)`. Normalization mirrors the control guard plus a `^\n+` rule
that strips leading blank LINES (not leading spaces) to absorb the `\n` after the
opening `{`.

## Review findings

Adversarial pass over the implement diff (commit `032a8a3`), read before the handoff
summary. Verdict: **solid; no minor fixes and no major tickets required.** The
implementer's claims were re-derived independently rather than trusted.

### Verification performed (independent of the handoff)
- **Full unit suite green:** `yarn workspace @serfab/quereus-plugin-sereus exec vitest
  run --project unit` → **4 files, 45 tests passed** (17 from this spec: 1 guard + 15
  extractor/normalize + 1 leading-blank-line normalize).
- **Typecheck:** `yarn workspace @serfab/quereus-plugin-sereus typecheck` → exit 0.
- **Lint:** `npx eslint <new file>` → exit 0, clean.
- **Bidirectional guard-bite (the gap the handoff flagged as worth a sanity pass):** the
  implementer had only edited `STRAND_SCHEMA`. I edited the OTHER copy —
  `schemas/strand.qsql`, `Member.NoUpdate` `check on update (false)` → `(true)` — and
  re-ran the guard: it went **red** at the correct line with the actionable "Mirror your
  edit in BOTH ..." message and a unified-style diff. Reverted via `git checkout`; tree
  clean, suite green again. The guard catches one-sided drift in both directions.

### Correctness / SPP / robustness (scrutinized)
- **Extractor cannot be fooled by the file's own comment header.** `findSchemaOpenBrace`
  calls `skipNonCode` (which dispatches to `skipLineComment` / `skipBlockComment` /
  `skipStringLiteral`) at every position before attempting `matchSchemaAnchor`, so the
  `declare schema Strand { ... }` text living inside the leading `--` comment block is
  skipped, not anchored on. Confirmed by reading the real file (anchor-in-comment on
  lines 3–7) and by the green main guard test.
- **Brace matching is trivially safe for THIS file** (SQL DDL uses `()` not `{}`, so the
  only braces are the outer schema wrapper → depth 1), but `findMatchingBrace` correctly
  handles the body's real `/* empty - singleton */` block comments and `''`/`'...'`
  string literals (`'c'`, `'sha256'`, `coalesce(..., '')`, etc.) so a brace inside a
  future comment/string won't miscount. The 15 extractor tests cover nested `{}`, `}` in
  `--`/`/* */`/string, `''`-escape, whole-identifier name matching, missing/unbalanced
  blocks, and the `apply`-line independence.
- **Body extraction matches the runtime wrapper.** `compose-strand.ts:260-265` wraps
  `${STRAND_SCHEMA}` in `declare schema Strand { ... } apply schema Strand;`, so the
  guard's "body strictly inside the braces == STRAND_SCHEMA" invariant is exactly what
  the runtime relies on. Re-derived by reading `composeStrand`.
- **Path resolution** (`new URL('../../../schemas/strand.qsql', import.meta.url)`)
  resolves test/ → quereus-plugin-sereus/ → packages/ → repo root; confirmed correct (the
  green guard test reads the real file), and consistent with the control guard.
- **Normalize asymmetry (`^\n+`) is correct and bounded:** it uses non-`m` `^`, so it
  strips only leading blank lines at string start (the `\n` after `{`), never interior
  blanks; it strips blank *lines* not leading *spaces*, so a real reindent of
  `table Header` still trips the guard (locked by an explicit unit test). A leading
  *comment* line added to one copy is still caught (only blank lines are removed).

### Docs
- Checked, **already accurate — no update needed.** `docs/architecture.md:58` already
  states the membership schema "ships as an embedded `STRAND_SCHEMA` constant (kept
  byte-equivalent to `schemas/strand.qsql`)"; this guard now *enforces* that documented
  invariant rather than changing it. The precedent `control-schema-drift-guard` review
  (commit `5280674`) likewise touched no docs — drift guards are test-only.

### DRY
- The deliberate copy of `normalize`/`firstDiffLine` from `cadre-core`'s
  `control-schema-drift.spec.ts` (rather than a shared util) is justified: exactly two
  consumers in two different packages. The header comment records that a THIRD copy
  should tip the balance toward a shared parameterized helper. Concur — no action now.

### Known limitations (acknowledged in the spec; NOT defects, NO action taken)
- Drift guard only — true single-sourcing / codegen remains deferred (same scope call as
  the control guard). Two copies still exist; the build only fails when they diverge.
- Extractor is tuned to the current file shape: no comment *between* anchor tokens
  (`declare /* x */ schema`), non-nested block comments only, single-quoted strings only,
  and lowercase `declare`/`schema` keywords (case-sensitive `startsWith`; lowercase SQL
  is lint-enforced per AGENTS.md). None occur in the file today; a violating future edit
  would throw "could not find" rather than silently mis-compare — a loud, safe failure.
- The first-diff line number is relative to the normalized body, not the raw `.qsql` line
  (the file line is ~+18 due to the comment header). Matches the control guard's behavior;
  the actionable "edit BOTH files" guidance is unaffected.

**Major findings:** none — no new fix/plan/backlog tickets spawned.
**Minor findings:** none requiring an inline change. The test suite already covers happy
path, the real-file anchor trap, brace/comment/string edge cases, error paths
(missing/unbalanced/comment-only blocks), and the normalize regression. Adding tests for
the documented non-features above would cement limitations rather than add value, so they
were deliberately left out.

## Validation summary
- Unit: 45 passed (incl. 17 new). Typecheck: 0. Lint: 0. Bidirectional drift bite:
  confirmed red then reverted. Working tree clean.
- e2e project (`--project e2e`) deliberately not run: it spins up real libp2p and this
  guard is a pure textual unit test with no runtime dependency.
