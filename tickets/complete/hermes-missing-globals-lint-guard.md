description: The phone apps carried a note claiming a database library leaks cancellation hooks on every request, which stopped being true when that library was fixed; the note is corrected and a linter rule now stops our own code from using browser features the phone runtimes lack.
architecture: docs/reference-app-rn.md#global-polyfills-polyfillshermesjs
files:
  - eslint.config.mjs
  - packages/reference-app-rn/polyfills/hermes.js
  - packages/reference-app-ns/src/polyfills/abort.ts
  - docs/reference-app-rn.md
  - docs/reference-app-ns.md
  - docs/testing.md
----

# Phone-runtime lint guard + corrected `AbortSignal.any` note

## What shipped

**Lint guard (`eslint.config.mjs`).** Four `no-restricted-syntax` selectors — `AbortSignal.timeout(…)`, `AbortSignal.any(…)`, `Promise.withResolvers(…)`, `new DOMException(…)` — apply to first-party source: `packages/*/src/**/*.{ts,tsx,mts,cts}` plus `packages/cadre-host/ui/src/**` (one level deeper than the first glob reaches). Each message names the replacement. `AbortSignal.prototype.throwIfAborted()` is deliberately not banned — libp2p requires it regardless and both apps polyfill it. Mirrors the equivalent guard in `../optimystic/eslint.config.js`.

**Flat-config composition.** A later config entry that sets `no-restricted-syntax` *replaces* the earlier entry's options for the files it matches; entries do not merge. So the selector lists are named constants (`CADRE_PEER_WRITE_GUARD`, `PHONE_RUNTIME_GUARD`, `PHONE_RUNTIME_SCOPE`) and each scope spells out its full list: all TypeScript files get the CadrePeer selectors; package source gets CadrePeer plus phone-runtime; `control-database.ts` (the CadrePeer exemption) gets phone-runtime only, so exempting it from one guard no longer switches off the other; the four CadrePeer test fixtures stay `off`.

**The one existing hit.** `packages/reference-app-ns/src/polyfills/abort.ts` `abortError` carries an `eslint-disable-next-line` with its reason — the `typeof DOMException` feature check is on the same line. A site-level disable rather than a config entry, because a config entry would also drop the CadrePeer selectors sharing the rule.

**The stale note.** The comment above `AbortSignal.any` in `hermes.js` and `abort.ts`, and the `AbortSignal.any()` row in `docs/reference-app-rn.md`, no longer claim that optimystic's repo client leaks a listener per request — it now hand-rolls its combinator, as does quereus's `combineAbortSignals`. Each is now a `NOTE:` tripwire: a combination whose inputs *all* fail to abort keeps its listeners for as long as the inputs live; no caller does that today; the fix belongs at whatever call site first does, not in the polyfill.

**Docs.** `docs/testing.md` "Lint coverage" gained a bullet for the guard — scope, the `throwIfAborted` exclusion, the single exemption, and the replace-not-merge behaviour. `docs/reference-app-ns.md` gained the polyfill rows listed under review findings below.

## Review findings

**Diff read:** `9610f182` (implement commit), read before the handoff summary, plus the surrounding config, both polyfill files in full, and the two app docs.

### Checked and clean

- **Flat-config composition.** Resolved five files with `eslint --print-config` across every scope — `reference-app-rn/src`, `cadre-host/ui/src`, `reference-app-web/src`, `cadre-core/src/control-database.ts`, `cadre-core/test/control-revocation-reap.spec.ts`. Each got exactly the intended selector set (the fixture resolves to severity `0`). The CadrePeer selector strings survive the move into constants byte-identical — the resolved config prints the same two regexes as before the change.
- **Scope completeness.** Enumerated every `src` tree under `packages/` to depth 5, excluding `node_modules` and `platforms`. The only trees outside `PHONE_RUNTIME_SCOPE` are native: `reference-app-ns/App_Resources/Android/src` and `reference-app-rn/android/app/src`. No TypeScript source escapes the guard.
- **Existing hits.** Grepped first-party source for all four APIs plus `globalThis.AbortSignal`. Every remaining mention is either a comment or a polyfill *assignment* (`Promise.withResolvers = function …`), which is not a `CallExpression` and correctly does not match. The single `eslint-disable` in `abort.ts` is therefore the complete exemption set, and `yarn lint` exits 0.
- **The load-bearing claim, "no caller does that today."** Verified independently rather than taken from the handoff. `p-wait-for` reaches `AbortSignal.any` only on the branch where both a timeout signal and a caller signal exist, so the combination always contains an `AbortSignal.timeout`, which always fires. A sweep of `node_modules` found only two files naming `AbortSignal.any`: `p-wait-for` and `any-signal`, and `any-signal`'s is a docstring — it hand-rolls its own combinator. Optimystic's repo client and quereus's `combineAbortSignals` both hand-roll too (read-only check of the linked siblings). The claim holds.
- **`abort.ts` `static any` reason handling.** It passes `source.reason` straight through where the React Native version defaults it; not a defect, because the NativeScript `[ABORT]` trigger defaults a missing reason to a named `AbortError` itself.

### Fixed inline

- **`p-wait-for` provenance was overstated.** The docs row and the `hermes.js` comment named five libp2p packages as pulling it in. Four of them — `libp2p`, `@libp2p/websockets`, `@libp2p/circuit-relay-v2`, `@libp2p/tcp` — list it as a **devDependency**, so it is absent from their shipped `dist`; the only import in shipped code is `@libp2p/webrtc`'s `private-to-public` listener. Corrected in both places. (`abort.ts`'s version of the note carries no package list and was left alone.)
- **The `AbortSignal.timeout` message pushed callers to hand-roll something cadre-core already has.** `withDeadline` in `packages/cadre-core/src/control-stream.ts` runs an operation under a timer wired to an `AbortController` and has five call sites; two existing comments in cadre-core already name it as the `AbortSignal.timeout` replacement. A guard whose message says only "use an explicit AbortController plus a timer" invites a sixth hand-rolled variant inside the one package that has the helper. The message now names `withDeadline` for cadre-core first and keeps the hand-rolled pattern (`startBudget`) for everywhere else — `withDeadline` is not re-exported from cadre-core's package entry point, so it cannot be recommended across package boundaries.
- **`docs/reference-app-ns.md` had no row for `abort.ts` at all.** That section promises to cover "every shim in `src/polyfills/`", and its table is the NativeScript counterpart of the React Native table this change updated — yet `AbortController`/`AbortSignal`, the largest shim there and the file this change edited, was missing. Added it, with the same never-aborting caveat and a pointer to the lint guard. Comparing the table against the boot audit's `markPolyfilled` keys turned up three more keys with no row; added those too: `Intl.DateTimeFormat`, `BroadcastChannel`, `process`.

### Tripwires recorded

- **Lint messages name two in-repo examples by path** (`withDeadline` in `control-stream.ts`, `startBudget` in `formation-approval.ts`) and nothing imports either, so a rename or move makes the advice point at nothing without failing anything. The handoff listed this under "Known gaps" but gave it no home in the code; it is now a `NOTE:` above `PHONE_RUNTIME_GUARD` in `eslint.config.mjs`.
- Carried forward from the implement pass, both re-verified as zero-hit today: `.svelte` component scripts are outside the guard's globs (`NOTE:` at `PHONE_RUNTIME_SCOPE`), and only `AbortSignal.x(…)` call expressions match, not a bare reference or a `globalThis.`-qualified call.

### Considered and left alone

- **The `'no-restricted-syntax': 'off'` exemption for the four CadrePeer test fixtures** would also drop the phone-runtime guard if a fixture ever moved under `src`. All four are under `test/`, which `PHONE_RUNTIME_SCOPE` does not reach, and the constant block's comment already warns about exactly this. No change.
- **The same `NOTE:` paragraph appears in `hermes.js`, `abort.ts` and the React Native docs.** Deliberate, not a DRY violation: two independent runtimes each need the caveat at their own polyfill, and the docs row is the index.

### Tests

**None added, and none cut.** The implement pass added none and the review adds none. The enforcement here is `yarn lint` itself, which is a check script rather than logic with branching, and the existing polyfill specs already pin the listener-detach contract for both runtimes. A test for the never-aborting case would encode a known limitation as expected behaviour, which is what the `NOTE:` is for instead.

**Run:** `yarn lint` (exit 0); `@serfab/reference-app-rn vitest --project polyfills` (3 files, 30 tests); `@serfab/reference-app-ns test` (6 files, 110 tests); `@serfab/cadre-core test` (138 files, 2261 passed, 1 pre-existing skip). All pass. The full monorepo suite was not run: neither the implement diff nor this pass changes any runtime code — only comments, documentation, and one lint-message string.

**Closed gap from the handoff.** The implementer could not run the NativeScript suite because the linked sibling `@optimystic/db-core` had a stale `dist` and, per `tickets/rules/sibling-repos.md`, could not build it. That sibling has since rebuilt; the full suite runs and passes here, so the unverified-suite caveat is resolved.

### Tickets filed

None. Nothing reached the filing bar — the two remaining concerns are genuinely conditional and are recorded as tripwires at their sites, and everything else was minor and fixed in this pass.
