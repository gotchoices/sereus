description: The NativeScript phone app now has a unit-test runner and its first two test suites, covering how the app stores its own small records in the phone's database and how it starts and stops the networking node.
files: packages/reference-app-ns/package.json, packages/reference-app-ns/tsconfig.json, packages/reference-app-ns/vitest.config.ts, packages/reference-app-ns/test/global-setup.ts, packages/reference-app-ns/test/build-targets.spec.ts, packages/reference-app-ns/test/node-local-slots.spec.ts, packages/reference-app-ns/test/cadre-phone.spec.ts, packages/reference-app-ns/src/node-local-slots.ts, packages/reference-app-ns/src/cadre-phone.ts, docs/STATUS.md
difficulty: medium
---

# Review: Vitest harness for `reference-app-ns` + its first two suites

## What landed

`packages/reference-app-ns` had three checks (`typecheck`, `test:bundle`,
`test:e2e` — the last needs a device, so nothing automated ran it) and no unit
test runner. It now runs Vitest, with 40 tests across 3 files.

**Harness (Phase 1).**

- `package.json`: `vitest` `^4.0.17` in `devDependencies` (resolves to 4.1.8),
  scripts `"test": "vitest run"` and `"dev:test": "vitest"`. Root `yarn test`
  is `yarn workspaces foreach -A run test`, so no root change was needed.
- `vitest.config.ts`: single project, `environment: 'node'`,
  `include: ['test/**/*.spec.ts']`, `globalSetup: ['./test/global-setup.ts']`.
  No `@nativescript/core` alias — neither suite imports it. (The follow-on
  ticket `debt-ns-invite-trust-tests` adds that for the view models.)
- `test/global-setup.ts` + `test/build-targets.spec.ts`: the stale-build guard,
  mirroring `reference-app-rn`'s pair with `@optimystic/db-p2p-storage-ns` in
  place of the `-rn` one. Same eight targets.
- `tsconfig.json`: `include` gained `"test/**/*.ts"` and `"vitest.config.ts"`.

**Which of the two tsconfig paths was taken — path A, the simple one.** The
ticket flagged that this package's `customConditions: ["react-native",
"browser"]` might break resolution of `vitest` / `vitest/config` type entries,
with a `tsconfig.test.json` + chained-script fallback if so. It did not break:
`tsc --noEmit -p tsconfig.json` passes with the widened `include` and the
`customConditions` untouched, so no second program and no chained script.
`@types/node` resolves transitively as predicted and no `types` array or
`@types/node` devDependency was added (knip stays clean).

**`node-local-slots.spec.ts` (Phase 2)** — 24 tests. `FakeKvStore` implementing
the exported `KvStoreApi` (a `Map` plus injectable `getError` / `setError`).
Covers `kvSlot` round-trip / absent key / read fault / write fault; the two key
strings as exact literals; per-party distinctness and cross-family
non-collision; then the real `PersistentTrustedOwnerStore` and
`PersistentBootstrapPeerStore` over a real `kvSlot` (reopen, raw envelope,
junk text, foreign `partyId`, read fault, failed persist).

**`cadre-phone.spec.ts` (Phase 3)** — 16 tests. Mocks
`@optimystic/db-p2p-storage-ns` (recording `openOptimysticNSDb`, a stub
`loadOrCreateNSPeerKey`, and a `SqliteKVStore` fake that applies its prefix
exactly like the real class) and `../src/ns-storage`; mocks **only** the
`CadreNode` export of `@serfab/cadre-core` so both node-local stores stay real
over the fake KV. Drives the module through its real exports with
`vi.resetModules()` + a dynamic import per test.

## Deviations from the ticket, and additions

- **Path A for the tsconfig** (above) — no `tsconfig.test.json`.
- **`@serfab/cadre-core` is imported statically at the top of
  `cadre-phone.spec.ts`, and the real namespace is cached across resets.** Not
  in the ticket, and load-bearing. Evaluating cadre-core's compiled graph (plus
  the linked `@optimystic/*` and `@quereus/quereus` behind it) takes seconds. On
  the first attempt that cost landed *inside* test bodies via a dynamic
  `import('@serfab/cadre-core')`, blew Vitest's default 5s `testTimeout`, and
  the timed-out in-flight imports then cascaded — one later test ran the **real**
  `CadreNode` and failed in `libp2p`. Two changes fixed it: the static top-level
  import charges the cost to the file's import phase, and the mock factory does
  `H.state.core ??= await importOriginal(...)` so `vi.resetModules()` re-runs the
  factory without re-evaluating that graph. Net: 40 tests in ~430ms of test time.
- **Two extra tests in each suite** beyond the ticket's list: a raw-envelope
  assertion for the bootstrap-peer store, both records sharing one KV store
  without clobbering each other, one party's record not leaking into another's
  slot, and a bootstrap-peer analogue of the pre-seeded-literal-key end-to-end
  test.
- **`docs/STATUS.md`**: the stale-build section now records `cadre-provider` as
  the only unguarded package and adds a bullet for `reference-app-ns`; the
  type-check-coverage section lists `reference-app-ns` among the packages
  covered via their main `tsconfig.json` and drops the "tenth workspace, nothing
  to include" wording. A fourth stale claim the ticket did not list was also
  corrected (~line 678: "has no test files yet").

## Validation actually run

All from `C:\projects\sereus` unless noted. All green.

| Command | Result |
| --- | --- |
| `yarn workspace @serfab/reference-app-ns test` | 3 files, 40 tests passed |
| `yarn workspace @serfab/reference-app-ns typecheck` | exit 0 |
| `yarn workspace @serfab/reference-app-ns test:bundle` | webpack compiled, 0 errors 0 warnings |
| `yarn lint` | exit 0 |
| `yarn check:vitest-typecheck-coverage` | every vitest config inside its typecheck program |
| `yarn check:test-file-typecheck-coverage` | 267 files across 10 packages, 3 allowlisted |
| `yarn dep-check` (knip + dep-ranges) | exit 0; only the pre-existing warn-level dead-code hints, none new |

**The guard was observed firing, not assumed.** The first suite run failed at
`globalSetup` with `@quereus/quereus: dist is stale — src was edited after the
last build`. Fixed by building the sibling (`yarn workspace @quereus/quereus
build` in `C:\projects\quereus`), per the ticket's instruction not to weaken the
target list.

**The `vi.resetModules()` isolation was verified by removing it.** With the
reset deleted from `loadModule()`, 10 of the 16 `cadre-phone` tests fail
(module singletons leak, `startPhoneNode` early-returns over the next test's
assertions). Restored afterwards; the final run is the 40-passing one above.

No pre-existing test failures were encountered, so `tickets/.pre-existing-error.md`
was not written.

## Known gaps — treat the tests as a floor

- **Root `yarn test` was not run end-to-end.** Only this package's suite plus
  the four root gates. The new `test` script is wired in by convention
  (`workspaces foreach -A run test`), and `test:bundle` confirms the shared
  `tsconfig.json` / devDependency changes did not disturb the webpack graph, but
  the full cross-workspace run is unverified from this ticket. Worth one
  `yarn test` at review time.
- **`SqliteKVStore` is faked, not exercised.** By decision (recorded in the
  implement ticket): the real driver lives in `@optimystic/db-p2p-storage-ns`
  and is covered there. So nothing here proves the real `SqliteKVStore` still
  satisfies the hand-written `KvStoreApi` subset in `src/node-local-slots.ts` —
  the only guard for that is the type-checked assignment in `cadre-phone.ts`,
  which is deliberate and should stay a type-level check, not a runtime one.
- **`CadreNode` is faked wholesale.** The suite proves the *config* handed to it
  (party id, bootstrap addrs, empty `listenAddrs`, both node-local stores) and
  the handle lifecycle around it. It proves nothing about `CadreNode.start()`
  itself, and nothing about the transports beyond "constructed, two of them".
- **`ns-storage.ts` is mocked away and has no coverage at all.** The lazy
  per-strand `IRawStorage` proxy (open-promise caching, the sync/async
  mismatch it exists to bridge) is untested. Not in this ticket's scope and not
  in the follow-on's either — a candidate for a future `debt-` ticket if the
  reviewer thinks it earns one.
- **The `@serfab/cadre-core` namespace cache is a behaviour change under
  `vi.resetModules()`.** Parked as a `NOTE:` at the site
  (`test/cadre-phone.spec.ts`, the `core` field of the hoisted state) — see
  Review findings below.
- **Timing sensitivity.** `cadre-phone.spec.ts` stays under the default 5s
  `testTimeout` only because the expensive import sits at file scope. A future
  test that reaches a fresh real-cadre-core import from inside a test body will
  hit the same cascade described above. The reason is written in the comment on
  that static import; no timeout was raised globally.
- **Windows only.** Everything above ran on Windows 11 / PowerShell. The
  stale-build guard's junction handling is exercised, its POSIX symlink path is
  not (though `reference-app-rn` and `reference-app-web` already share it).

## Review findings

- Tripwire — the mock factory caches the real `@serfab/cadre-core` namespace
  across `vi.resetModules()` so the suite does not re-evaluate that package's
  compiled graph per test. Harmless today (only the two stateless node-local
  store classes are used from it) but wrong the moment cadre-core grows
  module-scoped mutable state a test needs cleared. Parked as a `NOTE:` on the
  `core` field of the hoisted state in
  `packages/reference-app-ns/test/cadre-phone.spec.ts`.
