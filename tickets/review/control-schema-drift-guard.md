description: Drift-guard test asserting the embedded CONTROL_SCHEMA matches schemas/control.qsql; CONTROL_SCHEMA extracted to its own module. Ready for review.
files: schemas/control.qsql, packages/cadre-core/src/control-schema.ts (new), packages/cadre-core/src/control-database.ts, packages/cadre-core/test/control-schema-drift.spec.ts (new)
----

## What shipped

The security-critical `CadreControl` authorization schema lived as two hand-maintained
copies (`schemas/control.qsql` on disk; the embedded `CONTROL_SCHEMA` string in
`control-database.ts`, which is the one that actually runs since `loadSchema()` uses it by
default and no runtime path sets `schemaPath`). Nothing enforced they stayed identical, so a
one-sided edit was a silent security regression.

Implemented the **drift-guard test** approach from the ticket (codegen deliberately deferred):

- **Extracted** `CONTROL_SCHEMA` from `control-database.ts` into a new dedicated module
  `packages/cadre-core/src/control-schema.ts`, carrying an expanded block comment that states
  the drift-guard invariant. `control-database.ts` now `import { CONTROL_SCHEMA } from
  './control-schema.js'` and dropped the 125-line inline definition + its old comment. The
  constant stays package-internal (not re-exported from `index.ts`); the test imports it
  directly via `../src/control-schema.js`, matching how `schema-verification.spec.ts` imports
  internals.
- **Added** `packages/cadre-core/test/control-schema-drift.spec.ts`: reads `schemas/control.qsql`
  from disk (`new URL('../../../schemas/control.qsql', import.meta.url)` → repo root), imports
  `CONTROL_SCHEMA`, normalizes both for EOL/trailing-newline only, and asserts equality with an
  actionable mismatch message (first differing line number + both lines + "mirror in BOTH files").

No runtime behavior change: the embedded constant remains the live source of truth and RN still
gets it with no file read.

## ⚠️ Key deviation from the ticket — read this first

**The ticket's premise that the two copies were "byte-identical" was wrong.** A programmatic
diff found **two comment-only differences** (verified before any edits):

| line | `schemas/control.qsql` | embedded copy (old) |
|------|------------------------|---------------------|
| 49   | `…(see PeerAddressRecord in cadre-core).` | `…(see PeerAddressRecord).` |
| 69   | `…(cadre-core peer-record.ts:peerRecordSignedPayload).` | `…(peer-record.ts:peerRecordSignedPayload).` |

Both are cross-reference annotations; the SQL semantics were identical. A strict guard (which the
ticket explicitly mandates — "do not strip comments") would otherwise have **failed on master**.

**Resolution chosen:** reconcile by adopting the **qualified** form (`…in cadre-core` /
`cadre-core peer-record.ts…`) in **both** copies. Concretely: the new `control-schema.ts` was
generated from `schemas/control.qsql` so it matches byte-for-byte, and **`schemas/control.qsql`
was left untouched**. Rationale: the qualified comment is accurate and unambiguous in *both*
locations (the repo-root reference file genuinely benefits from the package qualifier; carrying
it into the in-package copy is harmless), and not touching the on-disk reference artifact
minimizes risk. This is behavior-preserving — comments never affect SQL execution.

**Reviewer: sanity-check this direction.** The alternative was to *drop* the qualifiers from
`schemas/control.qsql` (making both use the unqualified form, since the embedded copy was nominally
the "source of truth"). Either yields a passing guard; I picked the more-informative comment. If
you prefer the other direction, it's a two-line edit in `schemas/control.qsql` + regenerate the
constant.

## How the guard works (and its deliberate limits)

```ts
const normalize = (s) =>
  s.replace(/\r\n/g, '\n')      // CRLF -> LF  (repo is core.autocrlf=true, no .gitattributes)
   .replace(/[ \t]+$/gm, '')    // strip trailing horizontal whitespace per line
   .replace(/\n+$/g, '')        // drop trailing blank lines / final newline
   .trimEnd();
```

It tolerates **only** EOL and trailing-newline/whitespace differences. It does **not** collapse
interior whitespace or strip comments, so any real content change — e.g. a changed `verify(...)`
argument or a flipped curve — trips it. (The per-line trailing-whitespace strip is safe: SQL is
whitespace-insensitive at line ends, so it can't mask a semantic change.)

## Validation performed

- `yarn workspace @serfab/cadre-core build` (tsc) → clean (silent success).
- `yarn workspace @serfab/cadre-core typecheck` (covers `src` + `test`) → clean.
- `yarn workspace @serfab/cadre-core test` → **306 passed (23 files)**, including the new
  `control-schema-drift` spec. No regressions. The pre-existing seed-bootstrap CadrePeer-delete
  failure noted in the ticket did **not** surface (suite fully green), so no
  `.pre-existing-error.md` was filed.
- **Guard-bites check (done, then reverted):** temporarily changed one `'ed25519'` →
  `'ed25519x'` in `control-schema.ts`; the spec failed with the actionable message ("First
  difference at line 12: …") and vitest's diff. File restored; suite green again. The mutation
  was **not** committed.
- **EOL robustness:** working tree is CRLF (autocrlf); the CRLF→LF normalization makes the
  assertion pass regardless of LF/CRLF checkout.

## Test / validation / usage cases for the reviewer

- **Primary use case (drift detection):** edit either copy without mirroring → spec fails,
  naming the first divergent line and instructing to fix both files. This is the safety net for
  the two in-flight tickets that hand-edit both copies (`formationinvite-fix-curve-and-wire-consent`,
  `control-key-constraints-*`); if either lands a one-sided edit, this guard catches it. No
  ordering/`prereq:` dependency on them — the guard passes on current master independently.
- **Behavior preservation:** `ControlDatabase` still boots from the embedded schema; exercised by
  `control-database-genesis.spec.ts` and `control-authorization-binding.spec.ts` (both boot a real
  CadreNode using `CONTROL_SCHEMA` and pass).
- **Worth an independent reviewer pass:** re-run the guard-bites check with a *different* mutation
  (e.g. delete a whole constraint line, or add a trailing space mid-literal) to confirm the
  normalization isn't over-tolerant for your taste.

## Known gaps / honest notes

- **The second copy is still hand-maintained.** This guard *catches* drift; it does not
  *eliminate* the duplication. True single-source would require codegen (generator script +
  committed generated file + prebuild wiring + an "is-generated-file-current" test) — deferred per
  the ticket as not worth the build surface for a two-copy artifact. Revisit if a third copy appears.
- **Scope is the control schema only.** A parallel duplication exists for the strand schema
  (`STRAND_SCHEMA` ↔ `schemas/strand.qsql`); the completed `apply-strand-membership-schema` ticket
  explicitly calls for generalizing *this* guard to cover it. Out of scope here, but the spec is a
  ready template — a follow-up could parameterize it over `{constant, qsqlPath}` pairs.
- **Path coupling:** the test hard-codes `../../../schemas/control.qsql`. If the test file or the
  schemas dir moves, `readFile` throws ENOENT (a loud failure, not a silent pass) — acceptable, but
  noted.
