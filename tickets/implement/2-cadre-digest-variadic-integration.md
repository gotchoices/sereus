----
description: Update the cross-network integration tests and their sample database schema to the new crypto hashing call shape, so the end-to-end scenarios that prove TypeScript-signed writes are accepted by the SQL constraints pass again.
prereq: cadre-digest-variadic-libs
files:
  - C:/projects/sereus/packages/integration-tests/fixtures/simple-sapp.qsql
  - C:/projects/sereus/packages/integration-tests/src/scenarios/rbac-signed-write.integration.ts
  - C:/projects/sereus/packages/integration-tests/src/scenarios/strand-membership-closed-strand-e2e.integration.ts
difficulty: medium
----

## Goal

Finish the `digest` API migration on the **integration-tests** surface, after the
library packages have landed (`cadre-digest-variadic-libs`). These are the end-to-end
scenarios that prove a TS-signed write is accepted by the SQL `verify(...)` constraints
(TS↔SQL digest agreement) over a real network.

Apply the **same migration rule** established in `cadre-digest-variadic-libs`
(single concatenated-TEXT payload → one bare field; raw-bytes-signed → `'bytes'`):

- `digest(payload, 'sha256', 'utf8', 'bytes')` (TS) → `digest([payload], 'sha256', 'bytes') as Uint8Array`
- `digest(x, 'sha256', 'utf8')` (SQL) → `digest(x)` (the trailing literals are now hashed data fields under the variadic SQL function)

## Surfaces

- `fixtures/simple-sapp.qsql` — the sApp schema used by the RBAC scenario. SQL `digest`
  calls (lines ~36,44 the `Id || '|' || Name || '|' || coalesce(Value,'')` payload, and
  line ~50 `digest(old.Id, 'sha256','utf8')`): drop the trailing `'sha256','utf8'`.
  Also fix the explanatory comment header (lines ~11-13) that quotes the old 4-arg /
  3-arg forms.
- `src/scenarios/rbac-signed-write.integration.ts` — TS helpers `signItem` (line ~111)
  and `signDelete` (line ~117): `digest([itemPayload(...)], 'sha256', 'bytes')` /
  `digest([id], 'sha256', 'bytes')`, `sign(hashBytes, …, 'bytes', …)` unchanged. Fix the
  `signItem` doc comment that quotes `digest(payload,'sha256','utf8')`.
- `src/scenarios/strand-membership-closed-strand-e2e.integration.ts` — TS helper
  `signItem` (line ~141): same `digest([itemPayload(...)], 'sha256', 'bytes')` migration.

## Edge cases & interactions

- **Byte-parity with the migrated libs.** The strand-layer SQL these scenarios drive now
  lives in the migrated `strand-schema.ts` / `simple-sapp.qsql`; the TS signer must frame
  the single payload string identically (one TAG_TEXT field). A mismatch fails closed
  (every signed write rejected), surfacing as the scenario hanging on convergence or
  asserting a rejected write.
- **`itemPayload` ordering.** The `Id|Name|Value` join and its `coalesce(Value,'')` must
  match the SQL `new.Id || '|' || new.Name || '|' || coalesce(new.Value,'')` exactly
  (same order, same `''` fallback for null Value).
- **No remaining literals in SQL `digest(`.** After editing, the fixture must have no
  `digest(` call carrying a `'sha256'`/`'utf8'` argument.

## TODO

- [ ] Migrate `fixtures/simple-sapp.qsql` SQL `digest(...)` calls + comment header.
- [ ] Migrate `rbac-signed-write.integration.ts` `signItem` / `signDelete` + doc comment.
- [ ] Migrate `strand-membership-closed-strand-e2e.integration.ts` `signItem`.
- [ ] Run the `rbac-signed-write` and `convergence-stress` integration scenarios; both
  must go green (stream output with `tee`, never silent redirect). If a scenario's
  wall-clock routinely exceeds ~10 minutes it is not agent-runnable — document the
  deferral and let CI run it out-of-band rather than letting the idle timer expire.
- [ ] Final repo sweep for the acceptance criterion: 4-arg `digest(...)` call sites are
  gone, and SQL `digest(` calls carry no algorithm/encoding literals — excluding the
  intentional Node `createHash(...).digest('hex')` usages in
  `cadre-provider/src/server/auth.ts` and the reference-app polyfills.

## Acceptance criteria (whole migration, both tickets)

- `yarn typecheck` and `yarn test` pass in `packages/cadre-core` and
  `packages/quereus-plugin-sereus` (from the prereq ticket).
- The `convergence-stress` and `rbac-signed-write` integration scenarios pass.
- No remaining old-form `digest(...)` call sites in sereus: 4-arg TS calls and any SQL
  `digest(` with literal algorithm/encoding args, excluding the Node-hash polyfills noted
  above.
