description: Three more integration-test scenario files still keep their own private copies of test setup code that now lives in the shared test harness, so a cleanup pass started on this file set is only partway done.
prereq:
files: packages/integration-tests/src/harness/node-fixtures.ts, packages/integration-tests/src/harness/control-trio.ts, packages/integration-tests/src/scenarios/strand-addr-seed-convergence.integration.ts, packages/integration-tests/src/scenarios/control-cohort-three-node-isolation.integration.ts, packages/integration-tests/src/scenarios/control-cohort-cold-start-retry.integration.ts
difficulty: easy
----

<!-- resume-note -->
Continuation of the same-slug ticket, re-filed again after hitting a token-budget
warning mid-run — this time during final test validation, not the code edits
themselves. **All five files' code edits are done.** What's left is purely running
the validation commands and reading the results; no further code changes are
expected unless validation surfaces a real regression.

## What's actually done (code-complete, do not re-edit)

All five files listed under `files:` now import from `../harness/index.js` and
define no local copies of harness-provided helpers:

- `packages/integration-tests/src/scenarios/membership-connection-gater.integration.ts`
  — done in an earlier pass (before this run started).
- `packages/integration-tests/src/scenarios/control-stream-authz.integration.ts`
  — done in an earlier pass (before this run started).
- `packages/integration-tests/src/scenarios/strand-addr-seed-convergence.integration.ts`
  — done THIS run: swapped in `controlNodeConfig`, `createSignedSAppConfig`,
  `makeOwnOwner`, `connectControlNodes`, `controlAddrs` from
  `../harness/index.js`; removed the stale "copy, don't refactor" note; kept
  only the file-local `SIMPLE_SCHEMA` constant (not a harness concern).
- `packages/integration-tests/src/scenarios/control-cohort-three-node-isolation.integration.ts`
  — done THIS run: deleted the local `bootTrio`/`stopTrio`/`Trio`/`TrioHandles`/
  `wsTransports`/`nodeConfig`/`makeOwnOwner`/`connectionsTo`/`hasOutboundTo`/
  `peerStoreAddrsFor`; now imports `bootControlTrio`, `stopControlTrio`,
  `ControlTrioHandles`, `hasOutboundTo`, `connectionsTo`, `peerStoreAddrsFor`,
  `waitUntil`, `sleep` from `../harness/index.js`. Both call sites updated
  (`bootControlTrio({ reconcileMsB, handles })` / `stopControlTrio(handles)`),
  destructuring only `{ B, C, cPeerId }` or `{ B, cPeerId }` as each test body
  needs. Updated `packages/integration-tests/src/harness/control-trio.ts`'s
  file-header note (it no longer says "awaiting the harness-consolidation
  ticket" — it now just credits the scenario as the sequence's origin).
- `packages/integration-tests/src/scenarios/control-cohort-cold-start-retry.integration.ts`
  — done THIS run: swapped in `controlNodeConfig`, `makeOwnOwner`, `randomPeerId`,
  `connectionsTo` from `../harness/index.js`; kept `ed25519KeyPairFromLibp2p`
  imported from `@serfab/cadre-core` directly (still needed at its one call site
  for `pinnedKeyTrustPolicy`'s owner-key argument — that's not a harness helper).

Confirmed via grep: no scenario file in `files:` above contains any leftover
reference to `nodeConfig`, `wsTransports`, `CadreNodeConfig`, `MemoryRawStorage`,
`webSockets`, `circuitRelayTransport`, `TrioHandles`, `bootTrio`, or `stopTrio`.

## Validation status — what's confirmed and what's not

**Confirmed green:**
- `yarn workspace @serfab/integration-tests typecheck` — exit 0, no errors.
- `yarn lint` (repo-wide) — exit 0, no errors.

**Not yet confirmed — this is the remaining work:**
- The full `vitest run` suite was attempted twice and neither run produced a
  usable result:
  1. First attempt failed at the harness's stale-build guard
     (`test-harness/build-freshness.ts`): `@quereus/quereus`'s `dist` was stale
     relative to its `src`. Fixed by rebuilding it directly (the
     `yarn workspace @quereus/quereus build` form silently no-ops from some
     shells, per this ticket's own note — used
     `cd C:\projects\quereus\packages\quereus && npx tsc` instead, which
     succeeded).
  2. Second attempt (after that fix) hit the SAME stale-build guard again, this
     time flagging a DIFFERENT sibling workspace: `@optimystic/db-core`'s
     `dist` is stale relative to its `src`. This was not rebuilt — ran out of
     run budget before getting to it. Fix the same way:
     `cd C:\projects\optimystic\packages\db-core && npx tsc` (verify the exact
     package path and build command first — don't assume it mirrors quereus's
     layout without checking `package.json`).
  3. Separately: a full-suite `vitest run` across the whole
     `integration-tests` package takes longer than the 10-minute hard cap on a
     single foreground shell command in this environment. Once the stale-build
     guard is clear, don't retry the whole suite in one shot — either target
     just the changed/relevant files (see command below) or split the full run
     some other way that respects the timeout.

## Validation — what to run next

1. Fix the `@optimystic/db-core` staleness (see above), confirming with
   `npx tsc` output that it built clean.
2. Run the targeted subset covering everything this ticket touched:
   ```
   cd packages/integration-tests && npx vitest run --reporter=verbose \
     src/scenarios/membership-connection-gater.integration.ts \
     src/scenarios/control-stream-authz.integration.ts \
     src/scenarios/strand-addr-seed-convergence.integration.ts \
     src/scenarios/control-cohort-three-node-isolation.integration.ts \
     src/scenarios/control-cohort-cold-start-retry.integration.ts
   ```
   Two of these five are known PRE-EXISTING failures unrelated to this refactor
   (see `tickets/.pre-existing-known.md`):
   - `control-cohort-three-node-isolation.integration.ts` — blocked ticket
     `transactor-key-network-ignores-network-scoping`.
   - `control-cohort-cold-start-retry.integration.ts` — blocked ticket
     `control-db-cross-node-convergence-halted`.
   A continued failure in those two with the SAME fingerprint as before this
   refactor is expected and NOT a regression — do not re-triage them. The other
   three (`membership-connection-gater`, `control-stream-authz`,
   `strand-addr-seed-convergence`) must pass; any failure there (or a NEW
   failure mode/fingerprint in the two known-failing ones) means the refactor
   broke something and must be fixed before handoff.
3. If time/budget allows, also do a full
   `cd packages/integration-tests && npx vitest run --reporter=dot` pass (may
   need to be split into chunks to stay under the 10-minute command cap) to
   catch anything outside this five-file set that could plausibly be affected
   — unlikely given the change is confined to these files' own imports, but
   cheap to confirm if budget allows. Not required to close this ticket if
   budget is tight; the five-file targeted run above is the load-bearing check.
4. Once the targeted run is clean (three files passing, two known failures with
   unchanged fingerprint), this ticket is done — write it up as a `review/`
   ticket (this work no longer needs a `plan/`-stage design pass; it was fully
   scoped and the code is already written and typechecked/linted clean).

## Edge cases & interactions (carried over, already verified during the edits)

- `makeOwnOwner`'s shared version returns `Promise<string>` where some local
  copies returned `Promise<void>` — confirmed every call site in the three
  files edited this run discards the return value, so this was a no-op swap.
- `control-cohort-three-node-isolation`'s deleted `bootTrio` and the harness's
  `bootControlTrio` were diffed side-by-side (not just at the type level)
  before deletion — the step 1-6 ordering comments match; behavior preserved.
- Confirmed nothing in `control-cohort-three-node-isolation.integration.ts`
  still references the deleted local `Trio`/`TrioHandles` types by name (grep
  clean — see above).
- `strand-addr-seed-convergence`'s local `connectControlNodes` used `expect(...)`
  internally; the shared harness version throws a plain `Error` instead. Left
  as-is per the original ticket's guidance — this is the intended
  shared-harness pattern, not a regression.
