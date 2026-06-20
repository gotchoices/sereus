description: The cross-network end-to-end tests that prove a TypeScript-signed write is accepted by the database's signature checks were updated to the new crypto hashing call shape, and now pass over a real two-node network.
prereq: none
files:
  - C:/projects/sereus/packages/integration-tests/fixtures/simple-sapp.qsql
  - C:/projects/sereus/packages/integration-tests/src/scenarios/rbac-signed-write.integration.ts
  - C:/projects/sereus/packages/integration-tests/src/scenarios/strand-membership-closed-strand-e2e.integration.ts
difficulty: medium
---

## What landed

Completed the `digest` API migration on the **integration-tests** surface — the second
and final ticket of the chain started by `cadre-digest-variadic-libs` (now in
`complete/`). These are the real-network E2E scenarios that prove TS↔SQL digest
agreement (a TS-signed write satisfies the SQL `verify(...)` CHECK constraints).

Same migration rule as the libs ticket — single concatenated-TEXT payload → one bare
field; raw-bytes-signed → `'bytes'`:

- **TS:** `digest(payload, 'sha256', 'utf8', 'bytes')` → `digest([payload], 'sha256', 'bytes') as Uint8Array`
- **SQL:** `digest(x, 'sha256', 'utf8')` → `digest(x)` (the literals were spurious extra hashed fields under the variadic SQL function)

Edits, exhaustively:

- `fixtures/simple-sapp.qsql` — the 3 SQL `digest(...)` calls (the two `Id|Name|Value`
  payloads in `AuthorizedWrite`, and `digest(old.Id)` in `AuthorizedDelete`) dropped their
  trailing `'sha256','utf8'`. The comment header (lines 11/13) that quoted the old TS/SQL
  forms was updated to `digest([payload], 'sha256', 'bytes')` / `digest(payload)`.
- `rbac-signed-write.integration.ts` — `signItem` and `signDelete` helpers now frame the
  payload as a single-element array (`digest([itemPayload(...)], 'sha256', 'bytes')`,
  `digest([id], 'sha256', 'bytes')`); the `sign(hashBytes, …, 'bytes', …)` lines are
  unchanged. The `signItem` doc comment that quoted `digest(payload,'sha256','utf8')` was
  updated to `digest(payload)`.
- `strand-membership-closed-strand-e2e.integration.ts` — its `signItem` helper got the
  same single-array framing.

The `itemPayload` join (`${id}|${name}|${value ?? ''}`) was already byte-identical to the
SQL `new.Id || '|' || new.Name || '|' || coalesce(new.Value,'')`; only the digest call
shape changed, so signer/verifier still operate on identical bytes.

## ⚠️ Build-staleness gotcha the reviewer MUST know (honest flag)

The libs ticket migrated cadre-core/quereus-plugin-sereus **source** and validated against
**source** (their vitest runs `src/`). But the integration-tests package imports
`@serfab/cadre-core` via its package `exports`, which resolve to **`dist/`** (gitignored
build artifact). The libs ticket's local `dist/` was never rebuilt, so the integration
tests were executing the OLD compiled `signStrandPayload` —
`digest(payload, 'sha256', 'utf8', 'bytes')` — against the NEW 3-arg crypto plugin, which
read `'utf8'` as the output encoding and threw **`Unsupported output encoding: utf8`** from
`issueInvite` in the closed-strand scenario (NOT from any code this ticket edited).

Root cause is purely stale local `dist/`, not a code defect. I rebuilt the two libs:
```
yarn workspace @serfab/quereus-plugin-sereus build
yarn workspace @serfab/cadre-core build
```
and the failure cleared. **Because `dist/` is gitignored, that rebuild does not travel with
the commit** — a fresh checkout (CI, or the review agent) must `yarn build` these two
packages (or run a repo-wide build) before the integration tests, or it will hit the same
`Unsupported output encoding: utf8` and wrongly read it as a regression. The libs review
(commit `912c25a`) rebuilt only `quereus-plugin-sereus` dist; **cadre-core dist also needs
building** for the integration surface, since cadre-core's own specs run from `src` and
never exercised its dist.

## How to validate (use cases the scenarios prove)

Run order — build libs first, then the scenarios:

```
yarn workspace @serfab/quereus-plugin-sereus build
yarn workspace @serfab/cadre-core build
cd packages/integration-tests
yarn vitest run src/scenarios/rbac-signed-write.integration.ts --reporter=verbose
yarn vitest run src/scenarios/convergence-stress.integration.ts --reporter=verbose
yarn vitest run src/scenarios/strand-membership-closed-strand-e2e.integration.ts --reporter=verbose
```

What each proves (the migration's whole point is TS-signs ⇔ SQL-verifies byte parity;
a framing mismatch fails CLOSED — every signed write rejected):

- **rbac-signed-write** — 8 cases over a real two-node strand: authorized insert/update/
  delete accepted; wrong-payload sig, null sig, wrong-member update, non-creator delete
  rejected; and (case 8) a **null-Value** insert exercising the `coalesce(Value,'')` ⇔
  `value ?? ''` empty-segment branch. If the new framing were wrong, the *accepts* would
  flip to rejects — so green here is the real proof, not just the rejects.
- **closed-strand-e2e** — drives the migrated `signItem` (App.Items signed write by a
  freshly-admitted member) AND, transitively, the libs' migrated `signStrandPayload`
  (`issueInvite`/`consumeInvite`/`registerMemberPeer`/`addAuthority`). This scenario is the
  one that surfaced the stale-dist gotcha above; it's the best end-to-end exercise of the
  migrated *library* digest paths over a real network.
- **convergence-stress** — does not touch digest directly; included per the ticket as a
  regression guard that the cross-network machinery still converges under burst/interleaved/
  disconnect load.

## Validation run (this ticket)

After rebuilding both libs:
- `yarn workspace @serfab/integration-tests typecheck` — exit 0.
- `rbac-signed-write.integration.ts` — **1 passed** (4.3s test body).
- `convergence-stress.integration.ts` — **3 passed** (sequential burst, interleaved,
  disconnect resilience).
- `strand-membership-closed-strand-e2e.integration.ts` — **1 passed** (was red on stale
  dist; green after rebuild).

Did NOT re-run cadre-core / quereus-plugin-sereus `yarn test` — that was the libs ticket's
acceptance (already green at `912c25a`); the integration scenarios now validate those same
migrated digest paths through real usage, which is the stronger end-to-end check.

## Completeness sweep (acceptance criterion)

- `digest\([^)]*'utf8'` across the whole repo → only `tickets/*.md` (documentation), **zero
  code call sites**.
- `'utf8'` across `packages/**/*.{ts,qsql}` and `schemas/` → only unrelated Node
  `Buffer`/`readFileSync`/`TextDecoder` encodings; **no `digest(...)` carries it**.
- No SQL `digest(` in any `.qsql`/`*-schema.ts` carries an algorithm/encoding literal.
- Intentional exclusions left untouched: Node `createHash(...).digest('hex')` in
  `cadre-provider/src/server/auth.ts` and the reference-app `node-crypto`/`hermes` polyfills
  (these are Node's crypto, not the variadic plugin `digest`).

## Known gaps / what the reviewer should adversarially probe

- **Cross-node replication is best-effort, not gated**, in both rbac and closed-strand
  (see each file's SCOPE header). The migration's deliverable is the writer-local
  accept/reject parity; replication depends on control-sync wiring owned by other tickets
  and is logged, not asserted. Don't read a `replication observed=false` log line as a
  failure of this migration.
- **`strand-formation-e2e.integration.ts` is pre-existing red** (bootstrap-mode Phase 2),
  unrelated to digest — not run here, not in scope.
- **The reviewer's first action should be a clean `yarn build` of the two libs** (see the
  build-staleness section). The biggest risk to a fair review is hitting the stale-dist
  `Unsupported output encoding: utf8` and misattributing it to this ticket's edits.
- No `.pre-existing-error.md` was filed: the only failure encountered was the stale-dist
  one, which is an environment/build artifact issue I resolved by rebuilding, not a
  pre-existing *code* failure.
