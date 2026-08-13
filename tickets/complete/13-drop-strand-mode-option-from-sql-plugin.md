description: The SQL package no longer advertises a "bootstrap mode" for connecting to a workspace; that retired idea is replaced by the plain choice of storage engine it always was, and a connection now reports which engine it actually got.
files: packages/quereus-plugin-sereus/src/types.ts, packages/quereus-plugin-sereus/src/parse-config.ts, packages/quereus-plugin-sereus/src/compose-strand.ts, packages/quereus-plugin-sereus/src/index.ts, packages/quereus-plugin-sereus/README.md, packages/quereus-plugin-sereus/test/plugin.spec.ts, packages/quereus-plugin-sereus/test/e2e/local-transactor.e2e.spec.ts, packages/cadre-core/src/strand-database.ts, packages/cadre-core/test/strand-spec-helpers.ts, docs/STATUS.md
----

# Complete: `mode` dropped from `@serfab/quereus-plugin-sereus`, `transactor` promoted

Third and last of the strand-mode retirement. `mode?: 'bootstrap' | 'networked'` is gone;
`transactor?: 'local' | 'network' | 'test'` is the documented public knob, and
`SereusPluginResult.transactor` reports the **resolved** engine so specs can assert the arm they ran
on instead of assuming it.

## What shipped

- **`types.ts`** — `mode` deleted; exported `StrandTransactor` closed union; `transactor` documented
  per value; `SereusPluginResult.transactor` added as a required field.
- **`parse-config.ts`** — `mode` parsing removed; `transactor` validated against the three known
  values and **throws** on anything else.
- **`compose-strand.ts`** — resolution collapsed to a `transactor = 'network'` destructuring
  default; the result carries the resolved value. Storage wiring (`rawStorageFactory` only for
  `local`) and browser IndexedDB skipping (only for `test`) unchanged.
- **`cadre-core`** — `StrandDatabase.getTransactor()` (the only production addition outside the
  plugin) so the solo-write-budget spec can prove the engine it measured; `strand-spec-helpers.ts`
  passes `transactor` for both arms and throws on a mismatch.
- **Prose sweep** — plugin README (both options tables, the renamed "Local transactor" section, the
  spec list), six `cadre-core`/`integration-tests` spec headers, `reference-app-web` (where the
  comments were factually wrong, not merely stale, plus one user-visible error string that advised
  an API that no longer exists).
- **Rename** — `test/e2e/bootstrap.e2e.spec.ts` → `test/e2e/local-transactor.e2e.spec.ts`.

## Review findings

Read the implement diff (`4bca32c`) before the handoff summary. Scrutinised for correctness,
resource cleanup, type safety, DRY, doc accuracy, and whether the new assertions can actually fail.

**Fixed in this pass (minor):**

- **`packages/cadre-core/test/strand-spec-helpers.ts` — the new mismatch guard leaked the strand it
  rejected.** `openRawStrand` threw *before* pushing the strand onto the `opened` list the
  `afterEach` drains, so a run that tripped the guard left a live libp2p node and `Database` behind
  — the one path where the failure is loudest is the one that leaks. Registration now happens
  before the guard. Confirmed reachable, not theoretical: hard-coding `transactor: 'local'` in
  `openRawStrand` (the mutation the handoff suggested) makes all three parity cases fail *at the
  guard*, which is the throw that used to leak. Reverted after the check; the spec passes again.
- **`packages/quereus-plugin-sereus/src/types.ts` — the `StrandTransactor` doc comment was
  factually wrong.** It said the union covers "the three names Optimystic's `collection-factory.ts`
  switches on". That factory switches on **four** — `network`, `local`, `test`, and `mesh-test`
  (its production transactor stack over a one-node mock mesh) — before falling through to a
  host-registered custom transactor. Comment corrected, and it now records *why* `mesh-test` is
  excluded rather than merely omitted: `composeStrand`'s node gate special-cases only `'test'`, so
  `'mesh-test'` would be handed a real libp2p node it does not want. Nothing in this repo uses
  `mesh-test` (grepped `packages/`), so no behaviour changed — this is the tripwire for widening
  the union, parked at the union's own definition.
- **`docs/STATUS.md` — the solo-strand evidence bullet did not reflect the change.** It described
  the three evidence specs without noting that they now pin the *resolved* transactor. Added: what
  reports it, what enforces it in the helpers, and that before this any of the three would have
  passed with its transactor option silently ignored.

**Filed (major, class not instance):** `backlog/debt-plugin-loader-config-swallows-typos` —
`parseConfig` now validates `transactor` and throws on a typo, but every other key it reads still
falls back silently (`fret_profile = 'cor'` → `'edge'`, `port = '4001'` → `0`, `enable_cache =
'false'` → enabled), and unknown keys are dropped without a word. Filed as one boundary-invariant
ticket at the parse seam rather than a point ticket per key, with `transactor` cited as the
precedent and the compatibility cost of an allowlist stated as the decline argument. This subsumes
the handoff's "unknown keys silently ignored" known gap — same site, same seam. Site-claim grep
over the board found nothing else touching `parse-config.ts`.

**Considered and left alone (with reasons — not silence):**

- *Throwing on an unknown `transactor` next to `fret_profile`'s silent fallback* — the throw is the
  right side of the inconsistency (a wrong storage engine surfaces only as a hang on a peerless
  machine), so it stays; the inconsistency itself became the backlog ticket above rather than a
  reason to weaken the new check.
- *`StrandDatabase.getTransactor()` as production surface for a test assertion* — three lines, and
  it catches a plugin default flip that would otherwise silently re-baseline the write budgets.
  Kept.
- *The parity spec's three `expect(transactor).toBe('network')` lines can no longer fail*, now that
  the helper throws on mismatch. Kept as in-file documentation of what each case is about; they
  cost nothing and the reader of that file should not have to open the helper.
- *`const resolvedTransactor: StrandTransactor = transactor` in `composeStrand` is a bare rename* —
  removing it would rename the public `ResolveStorageContext.resolvedTransactor` field or make it
  read `resolvedTransactor: transactor`. Churn without a gain.
- *No browser spec asserts the reported transactor* — `connect-browser.ts` flows through the same
  `composeStrand` return statement, so there is no second code path to cover; the browser suites are
  bundle-shape/smoke tests by design.
- *`'test'` documented publicly in the README* — the loader genuinely accepts it, so documenting it
  is more honest than an `@internal` tag on a reachable value.

**Checked and clean (empty categories, with what was checked):**

- *Retired vocabulary* — repo-wide grep across `packages/`, `docs/`, `schemas/`, `ops/` for
  `mode: 'bootstrap'`, `'networked'`, `mode=`, `StrandMode`, and "bootstrap mode". Every survivor is
  deliberate history: `strand-instance-manager-backfill.spec.ts`'s header describing the gate that
  *used to* read `mode === 'networked'`, the handover spec's header naming the retired concept,
  `plugin.spec.ts` feeding `mode: 'bootstrap'` to prove it is ignored, and STATUS.md's account of
  the retirement. No stale claim about current behaviour remains.
- *Blast radius of making `SereusPluginResult.transactor` required* — grepped every
  `connectToStrand` / `SereusPluginResult` reference outside the plugin: only `cadre-core`
  (`strand-database.ts` plus specs) consumes either, and no test double constructs the result type.
  Nothing else in the repo implements the interface.
- *Docs that should have been touched* — `architecture.md`, `strands.md`, `cadre-consistency.md`,
  `releasing.md` never documented the `mode` option (checked, not assumed), so STATUS.md was the
  only doc carrying drift. STATUS.md's "Release readiness — measured 2026-08-03" table still says 78
  plugin tests; that is a dated measurement snapshot at a named SHA, not a live count, and was left
  alone deliberately.
- *Source hygiene* — the four touched sources stay small (`wc -l`: `types.ts` 106,
  `parse-config.ts` 70, `compose-strand.ts` 319, `strand-database.ts` 202); `parseTransactor` is a
  single-purpose function rather than an inline branch. No size-debt to file.

## Validation run in this pass

```
packages/quereus-plugin-sereus: yarn typecheck                → clean
packages/quereus-plugin-sereus: yarn build                    → clean
packages/quereus-plugin-sereus: yarn vitest run               → 8 files, 79 passed, 1 todo
packages/quereus-plugin-sereus: yarn vitest run --project e2e → 3 files, 19 passed, 1 todo
packages/cadre-core:            yarn typecheck                → clean
packages/cadre-core:            yarn vitest run               → 98 files, 1514 passed, 1 skipped
repo root:                      yarn lint                     → clean
```

Plus the mutation check above (parity spec red under a hard-coded `'local'`, green after revert).
The one plugin `todo` and cadre-core's one `skipped` are both pre-existing and unrelated. No
pre-existing failures surfaced, so nothing was written to `tickets/.pre-existing-error.md`.

**Not run:** `reference-app-web`'s Playwright e2e (needs a browser + dev server; that package's
changes are comments plus one error string, and no test asserts the string — grepped) and
`integration-tests` (comment-only change, real-network harness). Both were outside this ticket's
validation list and neither carries a behavioural change.

## Accepted breakage (per the repo's no-back-compat policy)

A JavaScript (non-TypeScript) caller passing `{ mode: 'bootstrap' }` to `connectToStrand` gets the
network transactor with no diagnostic; a SQL/JSON settings file still carrying `mode = 'bootstrap'`
likewise. No shim was added. A downstream consumer that registers a custom Optimystic transactor
would now need the union widened. All three are deliberate and stated at their sites.
