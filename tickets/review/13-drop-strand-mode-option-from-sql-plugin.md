description: The SQL package no longer advertises a "bootstrap mode" for connecting to a workspace; that retired idea is replaced by the plain choice of storage engine it always was, and a connection now reports which engine it actually got.
files: packages/quereus-plugin-sereus/src/types.ts, packages/quereus-plugin-sereus/src/parse-config.ts, packages/quereus-plugin-sereus/src/compose-strand.ts, packages/quereus-plugin-sereus/src/index.ts, packages/quereus-plugin-sereus/README.md, packages/quereus-plugin-sereus/test/plugin.spec.ts, packages/quereus-plugin-sereus/test/e2e/local-transactor.e2e.spec.ts, packages/quereus-plugin-sereus/test/e2e/strand-schema.e2e.spec.ts, packages/cadre-core/src/strand-database.ts, packages/cadre-core/test/strand-spec-helpers.ts, packages/cadre-core/test/strand-transactor-handover.spec.ts, packages/cadre-core/test/strand-membership-network-transactor-parity.spec.ts, packages/cadre-core/test/strand-solo-write-budget.spec.ts, packages/reference-app-web/src/lib/cadre-web.ts
difficulty: medium
----

# Review: `mode` dropped from `@serfab/quereus-plugin-sereus`, `transactor` promoted

Third and last of the strand-mode retirement. The SQL package's `mode?: 'bootstrap' |
'networked'` option is gone; `transactor?: 'local' | 'network' | 'test'` is now the documented
public knob, and `SereusPluginResult` reports the **resolved** transactor so specs can assert the
arm they ran on instead of assuming it.

## What changed

**`types.ts`** — `mode` deleted. New exported `StrandTransactor = 'local' | 'network' | 'test'`
(closed union; the doc comment says why it is closed and when to widen). `transactor` documented
with one sentence per value, no lifecycle vocabulary. `SereusPluginResult.transactor` added as a
**required** field carrying the resolved value.

**`parse-config.ts`** — `mode` parsing removed. `transactor` validated against the three known
values and **throws** on anything else (`transactor must be one of local, network, test`); empty
string and absent both leave it unset so `composeStrand` applies the default. A `NOTE:` records the
pre-existing policy that unknown *keys* are silently ignored (see "Known gaps").

**`compose-strand.ts`** — resolution collapsed to `transactor = 'network'` destructuring default;
the mode branch and the `mode=` log field are gone. `ResolveStorageContext.resolvedTransactor` is
now typed `StrandTransactor` instead of `string`. The result carries `transactor:
resolvedTransactor`. Storage wiring (`rawStorageFactory` only for `local`) and browser IndexedDB
skipping (only for `test`) are unchanged — comments reworded only.

**`cadre-core`** — `StrandDatabase` records the resolved transactor and exposes
`getTransactor()`; this is the only production-code addition outside the plugin, and it exists so
the solo-write-budget spec can prove which engine it measured. `strand-spec-helpers.ts` passes
`transactor` for both arms and **throws** if the strand resolved to a different engine than asked
for; `RawStrand` now carries `transactor`.

**Docs/prose sweep** — README options tables (both the programmatic and the loader table, which
gains a `transactor` row), the "Bootstrap mode" section renamed to "Local transactor (in-process, no
cohort)" and reframed so it does not read as an app recommendation, and the dev section's spec list.
Beyond the ticket's list, "bootstrap mode" prose was also cleared from five `cadre-core` membership
specs, one `integration-tests` scenario header, and `reference-app-web` — see "Scope beyond the
ticket".

**Rename** — `test/e2e/bootstrap.e2e.spec.ts` → `test/e2e/local-transactor.e2e.spec.ts` (git mv,
history preserved), header rewritten, and the CRUD case now asserts `result.transactor === 'local'`.

## Use cases to exercise when reviewing

**The option still selects the engine it names.** `connectToStrand(db, { strandId, transactor:
'local', storage })` must commit with no peers, and `result.transactor` must read `'local'`. Covered
by `local-transactor.e2e.spec.ts` (real libp2p + FileRawStorage) and by
`plugin.spec.ts` → "should report the transactor it resolved to".

**Omitting the option lands the network transactor.** Pinned where it can run for real:
`cadre-core/test/strand-transactor-handover.spec.ts` phase 2 now asserts `era2.transactor ===
'network'`. It is *not* pinned in the plugin's unit spec — a mocked libp2p node cannot satisfy the
coordinator lookup the network transactor's hydrate performs, so a unit-level default assertion
would have to fake the very thing it claims to prove.

**A typo is rejected, not silently downgraded.** `parseConfig({ strand_id, transactor: 'locl' })`
throws. Worth a reviewer's judgement: this is stricter than the neighbouring `fret_profile`, which
silently falls back to `'edge'`. The reasoning is in the code — a transactor typo surfaces only as a
mystifying hang on a machine with no peers — but the inconsistency is real and a reviewer may prefer
one policy for the whole parser.

**The evidence specs are now evidence.** All three specs the previous tickets left unable to assert
their arm now do:
- `strand-transactor-handover.spec.ts` — phase 1 `'local'`, phase 2 `'network'`.
- `strand-membership-network-transactor-parity.spec.ts` — all three cases assert `'network'`.
- `strand-solo-write-budget.spec.ts` — asserts the measured strand is on `'network'` before any
  budget is compared.
To check these bite, flip `openRawStrand`'s call to hard-code `'local'` and confirm the parity spec
fails at the assertion rather than passing quietly.

**No production behaviour moved.** `cadre-core`'s production path passed no transactor before and
passes none now; its helpers passed the local arm before and pass it now. Any diff in the write
budgets would mean otherwise — they were unchanged.

## Known gaps — read these before trusting the green run

**`parseConfig` silently ignores unknown keys, and that policy was left alone.** It reads the keys it
knows; there is no allowlist. So a SQL-level or JSON-level caller that still writes `mode =
'bootstrap'` in its settings gets **no error and the network transactor**. The ticket asked to check
this and report rather than change it, so it is reported: `plugin.spec.ts` → "should ignore a key it
does not know, including the retired `mode`" pins the current behaviour so it is a decision on
record. If a reviewer wants a loud rejection, that is a policy change across every key, not a
`mode`-shaped patch.

**Type-only breakage is silent for JavaScript callers.** A JS (non-TS) caller passing `{ mode:
'bootstrap' }` to `connectToStrand` directly gets the network transactor with no diagnostic. No shim
was added — deliberate, per the ticket.

**`transactor` is now a closed union, which narrows what was previously expressible.**
Optimystic's `collection-factory.ts` also accepts a custom transactor name registered by the host;
the old `transactor?: string` could carry one. Nothing in this repo registers a custom transactor, so
nothing broke, but a downstream consumer that does would now need `| (string & {})`. The reason is
in the `StrandTransactor` doc comment.

**The browser entry has no spec asserting the reported transactor.** `connect-browser.ts` flows
through the same `composeStrand`, so the field is populated identically, but the browser suites are
bundle-shape/smoke tests and none reads `result.transactor`. Argued, not measured.

**`'test'` is now documented publicly.** It was `@internal` before; the ticket asked for all three
values documented, so Optimystic's in-memory fake is now in the README's options table. A reviewer
may reasonably think a public README should not advertise a test fake.

**Cluster policy is still omitted by both node factories** (`connect.ts`, `connect-browser.ts`) —
`backlog/debt-plugin-strand-node-omits-cluster-policy`, deliberately untouched here. No e2e spec
added in this pass depends on the current defaults.

## Scope beyond the ticket (flagged, not hidden)

The ticket's final TODO was a repo-wide grep for `bootstrap` used to mean a transactor choice. It
turned up sites outside the listed files, all fixed here:

- Five `cadre-core` membership spec headers and one `integration-tests` scenario header said "in
  bootstrap mode" — comment-only rewording to "on the local transactor".
- `reference-app-web` was **factually wrong**, not merely stale: `cadre-web.ts` claimed the solo
  chat strand "auto-selects `bootstrap` mode (no other cadre peers)", which stopped being true when
  `retire-strand-mode-in-cadre-core` landed — that app's strand runs on the network transactor and a
  lone node coordinates for itself. Comments in `cadre-web.ts`, `messages.svelte.ts`, `Home.svelte`,
  the app README, and two Playwright spec comments now say so.
- One **user-visible string changed**: `requireStrandLibp2p` in `cadre-web.ts` threw "…it is still
  launching or runs in bootstrap mode (no cohort). Formed strands must be added with
  mode:\"networked\"." — advice for an API that no longer exists. It now reads "…it is still
  launching, or it was released". No test asserts this message (grepped).

Two `bootstrap` mentions survive on purpose: the handover spec's header naming the retired concept
as the thing being migrated away from, and the parse-config test that feeds `mode: 'bootstrap'` to
prove it is ignored. `StrandMode` returns nothing repo-wide.

## Validation actually run

```
packages/quereus-plugin-sereus: yarn typecheck                → clean
packages/quereus-plugin-sereus: yarn build                    → clean (needed before cadre-core typechecks against the new types)
packages/quereus-plugin-sereus: yarn vitest run               → 8 files, 79 passed, 1 todo
packages/quereus-plugin-sereus: yarn vitest run --project e2e → 3 files, 19 passed, 1 todo
packages/cadre-core:            yarn typecheck                → clean
packages/cadre-core:            yarn vitest run               → 98 files, 1514 passed, 1 skipped
repo root:                      yarn lint                     → clean
repo root:                      yarn build                    → clean
```

**No e2e spec is gated behind an environment flag** — all three plugin e2e files ran with real
libp2p nodes (verified with `--reporter=verbose`; the 4-node case takes ~50s). The one `todo` is
pre-existing and unrelated: `networked.e2e.spec.ts` → "peer A continues accepting writes after peer B
shuts down (needs cluster downsize support)". The `1 skipped` in cadre-core is likewise pre-existing.

**Not run:** `reference-app-web`'s Playwright e2e (needs a browser + dev server; the changes there
are comments plus the one error string) and `integration-tests` (comment-only change, real-network
harness). Both were beyond this ticket's validation list and neither has a behavioural change to
cover.

## Suggested review focus

- Is throwing on an unknown `transactor` the right call next to `fret_profile`'s silent fallback?
- Is `StrandDatabase.getTransactor()` worth production surface for a test assertion, or should the
  budget spec reach the value another way?
- Does the closed `StrandTransactor` union need `| (string & {})` after all?
- Does the README's local-transactor section read as "do not use this in an app" clearly enough?
