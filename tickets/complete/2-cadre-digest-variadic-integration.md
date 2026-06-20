description: The cross-network end-to-end tests that prove a TypeScript-signed write is accepted by the database's signature checks were updated to the new crypto hashing call shape, and now pass over a real two-node network.
prereq: none
files:
  - C:/projects/sereus/packages/integration-tests/fixtures/simple-sapp.qsql
  - C:/projects/sereus/packages/integration-tests/src/scenarios/rbac-signed-write.integration.ts
  - C:/projects/sereus/packages/integration-tests/src/scenarios/strand-membership-closed-strand-e2e.integration.ts
difficulty: medium
---

## What landed

Final ticket of the variadic-`digest` migration chain (after `cadre-digest-variadic-libs`).
Migrated the integration-tests surface — the real-network E2E scenarios that prove TS↔SQL
digest byte-parity (a TS-signed write satisfies the SQL `verify(digest(...))` CHECK
constraints).

Migration rule (single concatenated-TEXT payload → one bare field; raw-bytes-signed →
`'bytes'`):
- **TS:** `digest(payload, 'sha256', 'utf8', 'bytes')` → `digest([payload], 'sha256', 'bytes') as Uint8Array`
- **SQL:** `digest(x, 'sha256', 'utf8')` → `digest(x)` (the literals were spurious extra hashed fields under the variadic SQL `digest`)

Edits:
- `fixtures/simple-sapp.qsql` — three SQL `digest(...)` calls (two `Id|Name|Value` payloads
  in `AuthorizedWrite`, plus `digest(old.Id)` in `AuthorizedDelete`) dropped their trailing
  `'sha256','utf8'`; comment header updated to the new forms.
- `rbac-signed-write.integration.ts` — `signItem`/`signDelete` now frame the payload as a
  single-element array; doc comment updated.
- `strand-membership-closed-strand-e2e.integration.ts` — its `signItem` got the same
  single-array framing.

## Review findings

**Verdict: accept. No major findings; nothing required an inline fix.** The implementation
is a surgical, correct call-shape migration. The implement handoff was accurate and honest,
including the stale-`dist/` gotcha.

### Checked — byte-parity correctness (the dominant failure mode)
Traced the new API against `quereus-plugin-crypto` source
(`optimystic/packages/quereus-plugin-crypto/src/crypto.ts:319` `digest(fields, algorithm, encoding)`;
`plugin.ts:127` SQL `digest` registered `numArgs:-1`, variadic over fields, hasher/encoder
resolved once from default config sha256/base64url):
- TS `digest([payload], 'sha256', 'bytes')` = raw `sha256(encodeFields([payload]))`.
- SQL `digest(payload)` = `base64url(sha256(encodeFields([payload])))`; `verify`'s default
  base64url input-encoding decodes that back to the same raw bytes the TS side signed.
- Single-element TS array ⇔ single SQL variadic field → identical framed encoding. ✓
- The payload field is always non-null TEXT both sides (Id/Name are `not null`; SQL
  `coalesce(Value,'')` ⇔ TS `value ?? ''` collapse null *before* the digest sees a single
  concatenated field), so there is no NULL-vs-empty framing divergence. ✓
- `cadre-core/test/digest-variadic-parity.spec.ts` pins this contract directly for the
  library single-string and multi-field shapes; the rbac/closed-strand scenarios prove it
  end-to-end (the *accepts* passing is the real proof — a framing mismatch fails closed).

### Checked — completeness sweep
- `digest\([^)]*'utf8'` across the repo → only `tickets/*.md` docs; **zero code call sites**.
- All live `digest(` call sites in `packages/**/{src,scenarios,fixtures}` use the new
  array/variadic shape (verified cadre-core src + integration-tests).
- No `.qsql`/schema `digest(` carries an algorithm/encoding literal.
- Fixture comment header (`simple-sapp.qsql:9-15`) reviewed line-by-line and accurately
  describes the new TS (`digest([payload],…,'bytes')`) vs SQL (`digest(payload)`) shapes.

### Checked — test coverage (rbac, 8 cases)
Happy path (authorized insert/update/delete), error/reject paths (wrong-payload sig, null
sig, wrong-member update, non-creator delete), and the null-Value edge (case 8, the
empty-segment branch). Adequate for a call-shape migration — the accepts are the byte-parity
witnesses, the rejects guard fail-closed behavior.

### Checked — lint / typecheck / SQL style
- `eslint` on both changed `.ts` files → clean (exit 0).
- `integration-tests typecheck` → exit 0.
- Fixture SQL reserved words are lowercase (human-review rule); `digest`/`verify`/`coalesce`
  all lowercase. ✓

### Validation run (after rebuilding both libs — see build note)
- `rbac-signed-write.integration.ts` — **1 passed** (4.3s body).
- `strand-membership-closed-strand-e2e.integration.ts` — **1 passed**.
- `convergence-stress.integration.ts` — **3 passed** (regression guard; does not touch digest).

### Build note (carried forward from implement, confirmed real)
`integration-tests` imports `@serfab/cadre-core` / `@serfab/quereus-plugin-sereus` via their
package `exports`, which resolve to gitignored `dist/`. A fresh checkout (CI / clean clone)
**must `yarn build` those two packages before running the integration tests**, or it hits a
stale-`dist/` `Unsupported output encoding: utf8` and could misread it as a regression. This
is an environment/build-artifact concern, not a code defect — confirmed cleared by rebuilding
(`yarn workspace @serfab/quereus-plugin-sereus build`,
`yarn workspace @serfab/cadre-core build`). Verified the rebuilt
`cadre-core/dist/strand-membership-writer.js` now emits `digest([payload], 'sha256', …)`.

### Minor observations — noted, not actioned (no ticket filed)
- `itemPayload`/`signItem` are duplicated between the two scenario files. This is
  pre-existing per-scenario fixture self-containment, not introduced by this ticket;
  factoring a shared test helper for two 1-line signers would be over-engineering. Left as-is.
- Cross-node replication is best-effort (logged, not asserted) in both scenarios — by design,
  per each file's SCOPE header; the writer-local accept/reject parity is the deliverable.
  `strand-formation-e2e.integration.ts` remains pre-existing red (bootstrap-mode Phase 2),
  unrelated to digest. Neither is a finding against this ticket.

No `.pre-existing-error.md` filed: the only failure observed was the stale-`dist/`
build-artifact issue, resolved by rebuilding — not a pre-existing code failure.
