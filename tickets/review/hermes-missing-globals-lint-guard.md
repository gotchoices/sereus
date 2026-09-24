description: The phone apps carried a note claiming a database library leaks cancellation hooks on every request, which stopped being true when that library was fixed; the note is corrected and a linter rule now stops our own code from using browser features the phone runtimes lack.
architecture: docs/reference-app-rn.md#global-polyfills-polyfillshermesjs
files: eslint.config.mjs, packages/reference-app-rn/polyfills/hermes.js, packages/reference-app-ns/src/polyfills/abort.ts, docs/reference-app-rn.md, docs/testing.md
----

# Handoff: `AbortSignal.any` warning corrected, phone-runtime lint guard added

## What changed

**Lint guard (`eslint.config.mjs`).** Four `no-restricted-syntax` selectors — `AbortSignal.timeout(…)`, `AbortSignal.any(…)`, `Promise.withResolvers(…)`, `new DOMException(…)` — now apply to first-party source: `packages/*/src/**/*.{ts,tsx,mts,cts}` plus `packages/cadre-host/ui/src/**`. Each message names the replacement. `AbortSignal.prototype.throwIfAborted()` is deliberately not banned (comment above the block says why). The messages point at `startBudget` in `packages/cadre-core/src/formation-approval.ts` as the in-repo example of an explicit timer/relay that is released on every exit path.

**Flat-config replacement semantics.** A later config entry that sets `no-restricted-syntax` *replaces* the earlier entry's options for the files it matches; entries do not merge. A plain second block would have silently dropped the `CadreControl.CadrePeer` guard across all of `packages/*/src`. So the selector lists became named consts (`CADRE_PEER_WRITE_GUARD`, `PHONE_RUNTIME_GUARD`, `PHONE_RUNTIME_SCOPE`) and each scope spells out its full list:

- all TS files → CadrePeer selectors (unchanged behaviour, same regexes);
- package source → CadrePeer + phone-runtime selectors;
- `control-database.ts` (the CadrePeer exemption) → phone-runtime selectors only, so the exemption no longer switches off the whole rule for a source file;
- the four `CadrePeer` test fixtures → `off`, as before.

**The one existing hit.** `packages/reference-app-ns/src/polyfills/abort.ts` `abortError` gets an `// eslint-disable-next-line no-restricted-syntax -- …` with its reason (the `typeof DOMException` feature check is on the same line). No config-level exemption, because that would also switch off the CadrePeer selectors sharing the rule.

**The stale note.**
- `packages/reference-app-rn/polyfills/hermes.js` and `packages/reference-app-ns/src/polyfills/abort.ts`: the comment above `AbortSignal.any` no longer claims optimystic's repo client leaks or cites the ticket. It is now a `NOTE:` tripwire: a combination whose inputs all fail to abort keeps its listeners for as long as the inputs live; no caller does that today (`p-wait-for`, the only dependency that calls it, always pairs with an `AbortSignal.timeout`); the fix belongs at that call site, not in the polyfill.
- `docs/reference-app-rn.md` `AbortSignal.any()` row: "Required by" is now `p-wait-for` (and the libp2p packages that pull it in); the leak sentence and ticket reference are replaced with the same conditional statement plus a pointer to the lint guard.
- `docs/testing.md` "Lint coverage": one new bullet describing the guard, its scope, the `throwIfAborted` exclusion, the single exemption, and the replace-not-merge behaviour of the rule.

## Verification

- `yarn lint` — exit 0, no output.
- Temporary probe files (created, linted, deleted; `git status` clean of them) containing one of each banned construct plus both CadrePeer SQL forms:
  - `packages/cadre-core/src`, `packages/reference-app-web/src`, `packages/cadre-host/ui/src`: all six report.
  - `packages/cadre-core/test`: only the two CadrePeer selectors report (phone guard correctly out of scope).
- `eslint --print-config` on `control-database.ts`: exactly the four phone selectors. On `control-revocation-reap.spec.ts`: severity `0` (off), as before.
- `yarn workspace @serfab/reference-app-rn vitest run --project polyfills` — 3 files, 30 tests pass.
- `packages/reference-app-ns/test/polyfills.spec.ts` — 7 tests pass (see the gap below for how it was run).

## Tests added

None, per the ticket: `yarn lint` is the enforcement, and the existing polyfill specs already pin the listener-detach behaviour. No test pins the never-aborting case (that would encode a known limitation as expected).

## Known gaps — read these

- **`yarn workspace @serfab/reference-app-ns test` did not run.** Its stale-build guard stopped at global setup: `@optimystic/db-core: dist is stale — src was edited after the last build`. That is the linked sibling `../optimystic`, whose source is being edited now; per `tickets/rules/sibling-repos.md` I did not build it. The full NS suite is therefore unverified on this run. What I did instead: `polyfills.spec.ts` imports nothing from any sibling `dist` (only `vitest` and `src/polyfills/*`), so I ran that one file through a throwaway vitest config in the scratchpad with the guard left out (repo config untouched): 7/7. My only NS change is a comment and a lint directive — no runtime change — so the residual risk is low, but the reviewer may want to re-run the full suite once the sibling has rebuilt. This is the guard doing its job, not a pre-existing test failure, so no `.pre-existing-error.md` was written.
- **Scope wider than the ticket's glob.** The ticket says `packages/*/src/**` "includes `cadre-host/ui`", but that glob does not reach `packages/cadre-host/ui/src` (one level deeper). I added it explicitly to match the stated intent. Measured zero hits there.
- **`.svelte` scripts are not covered** (the globs are the `.ts` family, as the ticket specified). Recorded as a `NOTE:` at `PHONE_RUNTIME_SCOPE` in `eslint.config.mjs`; none use these APIs today.
- **Only `AbortSignal.x(…)` call expressions match**, not a bare reference (`const f = AbortSignal.any`) or `globalThis.AbortSignal.any(…)`. Same as optimystic's selectors; targets the copy-paste mistake, not a determined bypass.
- The messages reference `startBudget`, which is module-private to `formation-approval.ts`. It is a pattern to copy, not something to import; if that file is renamed or the function moves, the message text goes stale silently.

## Tripwires recorded

- Never-aborting `AbortSignal.any` combination keeps its listeners: `NOTE:` in `hermes.js`, `abort.ts`, and the docs row.
- `.svelte` scripts outside the phone-runtime guard: `NOTE:` at `PHONE_RUNTIME_SCOPE` in `eslint.config.mjs`.

## For the reviewer

- Confirm the flat-config composition is right by resolving a couple more files with `eslint --print-config` (e.g. a file in `packages/reference-app-rn/src` and one in `packages/integration-tests/src`).
- Check the CadrePeer selector strings are byte-identical to the originals after being moved into consts (they now interpolate a shared regex source; the probe confirmed both forms still match).
- Confirm nothing else in the repo still cites `bug-abortsignal-any-leaks-listeners-on-hermes` as an open defect (remaining hits should be only under `tickets/`, e.g. `tickets/.garden-report.md`, which is a historical record).
