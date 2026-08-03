description: The NativeScript phone app has no unit tests at all. Give it a test runner that works on a plain developer machine (no phone attached), and use it to check the code that stores the app's own small records in the phone's database.
files: packages/reference-app-ns/package.json, packages/reference-app-ns/tsconfig.json, packages/reference-app-ns/vitest.config.ts, packages/reference-app-ns/test/global-setup.ts, packages/reference-app-ns/test/build-targets.spec.ts, packages/reference-app-ns/test/node-local-slots.spec.ts, packages/reference-app-ns/test/cadre-phone.spec.ts, packages/reference-app-ns/src/node-local-slots.ts, packages/reference-app-ns/src/cadre-phone.ts, packages/reference-app-rn/test/node-local-slots.spec.ts, packages/reference-app-rn/test/global-setup.ts, packages/reference-app-rn/test/build-targets.spec.ts, test-harness/build-freshness.ts, docs/STATUS.md
difficulty: medium
---

# A unit-test runner for `reference-app-ns`, plus its first two suites

## Situation

`packages/reference-app-ns` ships three checks today — `typecheck`,
`test:bundle` (webpack-compiles the whole import graph), `test:e2e` (needs a
device or emulator, so nothing automated runs it). There is no unit-test runner,
so every piece of app-level glue in `src/` is unverified except by the type
checker. This ticket adds the runner and the two suites that do not need any
NativeScript view machinery. The view-model suites are the follow-on ticket
`debt-ns-invite-trust-tests`, which depends on this one.

## Decisions already made (do not re-litigate)

**Runner is Vitest**, matching `reference-app-rn` and `reference-app-web`. Add
`vitest` at `^4.0.17` (same range as both siblings) to `devDependencies`, and
scripts `"test": "vitest run"` / `"dev:test": "vitest"`. The root `yarn test`
is `yarn workspaces foreach -A run test`, so adding the `test` script is the
whole of "wire it into the repo's normal test invocation" — no root change.

**No real SQLite in this package's tests.** The ticket's research note suggested
borrowing `@optimystic/db-p2p-storage-ns`'s own `node:sqlite` driver. Rejected:
that driver is `test/node-sqlite-driver.ts` in the sibling repo and is excluded
from the published `files`, so it cannot be imported — reproducing it here means
a second copy of a SQLite driver in a second repo, and it would drag
`node:sqlite` types into a TypeScript program that also carries NativeScript's
global declarations. What `SqliteKVStore` does with SQL is owned and covered by
`@optimystic/db-p2p-storage-ns` (`test/sqlite-kv-store.spec.ts` over there). What
*this* package owns is the key strings, the empty key prefix, and the
pass-through slot — all reachable through the `KvStoreApi` seam that
`src/node-local-slots.ts` exists to provide. Use an in-memory fake.

**Single Vitest project, `environment: 'node'`.** Neither suite in this ticket
imports `@nativescript/core`, so no aliasing is needed here. (The follow-on
ticket adds an alias for the view models — do not pre-build it, and do not add a
stub file this ticket never uses.)

**Stale-build guard, same as the two sibling apps.** Both suites here import
*real*, non-mocked `@serfab/cadre-core` values (`PersistentTrustedOwnerStore`,
`PersistentBootstrapPeerStore`), which resolve through a symlink to that
package's `dist`. Without the guard, an unbuilt edit to `cadre-core/src` makes
this suite green about code it never ran. Mirror
`packages/reference-app-rn/test/global-setup.ts` +
`packages/reference-app-rn/test/build-targets.spec.ts` exactly, swapping
`@optimystic/db-p2p-storage-rn` for `@optimystic/db-p2p-storage-ns`.

## Interfaces / files

### `packages/reference-app-ns/vitest.config.ts` (new)

```ts
export default defineConfig({
	test: {
		environment: 'node',
		include: ['test/**/*.spec.ts'],
		globalSetup: ['./test/global-setup.ts'],
	},
});
```

Keep the module doc comment short and factual — say why the environment is
`node` (nothing here touches a NativeScript view) and that the `globalSetup`
guard exists because the suites run `cadre-core`'s compiled output.

### `packages/reference-app-ns/test/global-setup.ts` (new)

Copy of the RN file's shape. Exported `TARGETS`, then
`assertBuildFresh(TARGETS, import.meta.url)`:

| packageName | distEntry | location |
| --- | --- | --- |
| `@serfab/cadre-core` | `dist/index.js` | `workspace` |
| `@serfab/quereus-plugin-sereus` | `dist/index.js` | `workspace` |
| `@optimystic/db-core` | `dist/src/index.js` | `linked` |
| `@optimystic/db-p2p` | `dist/src/index.js` | `linked` |
| `@optimystic/db-p2p-storage-ns` | `dist/src/index.js` | `linked` |
| `@optimystic/quereus-plugin-crypto` | `dist/index.js` | `linked` |
| `@optimystic/quereus-plugin-optimystic` | `dist/index.js` | `linked` |
| `@quereus/quereus` | `dist/src/index.js` | `linked` |

Verified during planning: this package sets
`installConfig.hoistingLimits: "workspaces"`, and its own `node_modules` holds
`@optimystic/db-core`, `db-p2p`, `db-p2p-storage-ns` and `@quereus/quereus`;
the two `@optimystic/quereus-plugin-*` resolve one level up at the repo root.
`assertBuildFresh` walks the `node_modules` chain upward from the setup file,
so both depths resolve — same as RN.

### `packages/reference-app-ns/test/build-targets.spec.ts` (new)

```ts
describeBuildTargets('reference-app-ns', {
	packageDir: packageRootFrom(import.meta.url, '..'),
	targets: TARGETS,
	expectFound: { '@serfab/cadre-core': 'workspace', '@optimystic/db-p2p': 'linked' },
});
```

### `packages/reference-app-ns/tsconfig.json` (edit)

Add `"test/**/*.ts"` and `"vitest.config.ts"` to `include`. Two root gates
depend on this and both run under `yarn typecheck` / `yarn test`:
`scripts/check-vitest-typecheck-coverage.mjs` (the vitest config must be inside
a `tsc` program) and `scripts/check-test-file-typecheck-coverage.mjs` (every
collected spec and every `globalSetup` module must be too).

`@types/node` is already resolvable from this package (transitively — confirmed
at `packages/reference-app-ns/node_modules/@types/node`) and already
auto-included in the current program alongside `@nativescript/types`, so
`test-harness/build-freshness.ts`'s `node:fs` / `node:path` imports resolve with
no manifest change. Do **not** add a `types` array and do **not** add
`@types/node` as a devDependency — `knip` runs clean on this package today and
an unreferenced `@types` entry is exactly what it flags.

**Fallback, only if needed:** this tsconfig sets
`customConditions: ["react-native", "browser"]`, which participates in resolving
`vitest` / `vitest/config` type entries. If that turns out to break, do not
weaken the app program — add `tsconfig.test.json` that `extends` the main
config, drops `customConditions`, and sets
`include: ["test/**/*.ts", "vitest.config.ts", "src/**/*", "references.d.ts"]`,
then chain the script: `tsc --noEmit -p tsconfig.json && tsc --noEmit -p tsconfig.test.json`.
Both gates scrape every `-p` from the script and accept coverage by any one
program; `cadre-host` is the existing precedent for a chained typecheck script.
Say in the review handoff which of the two paths you took and why.

### `packages/reference-app-ns/test/node-local-slots.spec.ts` (new)

Model on `packages/reference-app-rn/test/node-local-slots.spec.ts` — same
structure, but this package has only one slot family (`kvSlot`) and no secure
store, so it is the smaller half of that file. Reuse its `FakeKvStore`
(a `Map` plus injectable `getError` / `setError`) implementing the exported
`KvStoreApi`, and its real-peer-id fixture
`12D3KooWQVo7JTYHgoj9rt9HScoxaM5axn3uB8P1WHiKrhhUqed3` — the bootstrap-peer
store runs `peerIdFromString` over every key on reload, so a fixture that must
survive a reopen has to actually parse.

Do not restate what `packages/cadre-core/test/node-local-snapshot.spec.ts`
already owns (cold start, corrupt JSON, foreign party, discard-all vs
drop-entry, failed-persist recovery *as policy*). Say so in the file's doc
comment, as the RN file does.

### `packages/reference-app-ns/test/cadre-phone.spec.ts` (new)

The module holds two pieces of state private to itself — the `CadreNode`
singleton and the `OptimysticNSDBHandle` — with no injection seam, so the suite
drives it through its real exports and resets between tests with
`vi.resetModules()` plus a dynamic `await import('../src/cadre-phone')` in each
test (or a small `loadModule()` helper). Note in the file comment that the
reset is what keeps the singletons from leaking across tests.

Three mocks, all hoisted (define fakes via `vi.hoisted` so the factories can
reach them):

```ts
vi.mock('@optimystic/db-p2p-storage-ns', () => ({
	openOptimysticNSDb: /* records opens; returns a handle with a spy close() */,
	loadOrCreateNSPeerKey: /* returns a stub PrivateKey object */,
	SqliteKVStore: /* fake class: records (db, prefix) ctor args, Map-backed get/set, records every key touched */,
}));
vi.mock('../src/ns-storage', () => ({ makeLazyNsStorage: () => ({}) }));
vi.mock('@serfab/cadre-core', async (importOriginal) => ({
	...(await importOriginal<typeof import('@serfab/cadre-core')>()),
	CadreNode: FakeCadreNode,   // everything else stays real
}));
```

`FakeCadreNode` records the `CadreNodeConfig` it was constructed with, exposes
`isRunning`, and has `start()` / `stop()` whose behaviour each test can steer
(resolve, or reject with a chosen error). The partial `cadre-core` mock is what
lets `PersistentTrustedOwnerStore` / `PersistentBootstrapPeerStore` stay **real**
over the fake `SqliteKVStore`, which is the point of the suite: it proves the
empty prefix and the literal keys end to end, not just as constructor arguments.

The real libp2p transport factories (`webSockets()`, `circuitRelayTransport()`)
are only *constructed*, never started, and both import cleanly under plain Node
— leave them unmocked.

## TODO

### Phase 1 — harness

- Add `vitest` `^4.0.17` to `devDependencies`; add `test` and `dev:test` scripts.
- Write `vitest.config.ts` as specced above.
- Write `test/global-setup.ts` with the eight targets, and
  `test/build-targets.spec.ts` holding that list against the manifest.
- Extend `tsconfig.json`'s `include`; confirm `yarn typecheck` in the package
  passes, then `yarn check:vitest-typecheck-coverage` and
  `yarn check:test-file-typecheck-coverage` from the repo root.
- Confirm the empty-but-for-`build-targets` suite runs: `yarn workspace
  @serfab/reference-app-ns test 2>&1 | tee <scratch>/ns-test.log`.

### Phase 2 — `node-local-slots.spec.ts`

- `FakeKvStore` implementing `KvStoreApi`, with injectable read/write faults.
- `kvSlot` round-trip: `save('hello world')` then a **fresh** `kvSlot` over the
  same fake loads `'hello world'` — proves the slot itself is stateless.
- Never-written key loads `undefined`.
- A read fault **rejects** rather than resolving `undefined`. This is the case
  the ticket calls out: were it to resolve `undefined`, the store above would
  cold-start and the next save would overwrite an intact record.
- A write fault rejects rather than resolving.
- Key shape, as exact literals: `anchorSlotKey('p') === 'trusted-owners.p'`,
  `bootstrapPeersSlotKey('p') === 'bootstrap-peers.p'`. Renaming either silently
  orphans every installed phone's record instead of failing.
- Distinct parties get distinct keys, and the two families never collide with
  each other for any party.
- Real `PersistentTrustedOwnerStore` over a real `kvSlot`: a trusted key
  survives a fresh `open()` of the same slot; the raw persisted envelope records
  the source; junk text pre-seeded under the key yields an empty store without
  throwing; an envelope carrying a foreign `partyId` yields an empty store; a
  read fault rejects `open()` and leaves the fake untouched; a failed persist
  rejects `trust()` while the in-memory trust still stands.
- Real `PersistentBootstrapPeerStore` over a real `kvSlot`: same six, with
  `record(peerId, addrs)` and the real-peer-id fixture.

### Phase 3 — `cadre-phone.spec.ts`

- Start opens the identity database exactly once, and constructs
  `SqliteKVStore` with **that same handle** and the empty prefix `''`.
- The keys the two stores read during start are exactly
  `trusted-owners.<partyId>` and `bootstrap-peers.<partyId>` — assert against
  the recorded key list, not against the constructor argument alone.
- A trusted-owner envelope pre-seeded in the fake KV under the literal
  `trusted-owners.<partyId>` is visible to the started node's store. This is the
  end-to-end version of the previous bullet: prefix and key together.
- `startPhoneNode` twice while running returns the same node and opens no second
  database handle.
- `stopPhoneNode` closes the handle and leaves `getPhoneNode()` null.
- **`stopPhoneNode` closes the handle even when `node.stop()` rejects**, the
  rejection propagates to the caller, and `getPhoneNode()` is null afterwards.
  This is the `finally` in `stopPhoneNode` — a leaked native SQLite handle
  blocks the next open of the file.
- `stopPhoneNode` after a start that failed inside `CadreNode.start()` still
  closes the handle.
- `stopPhoneNode` with nothing ever started is a no-op: no close, no throw.
- After a stop, the next `startPhoneNode` opens a **new** handle rather than
  reusing the closed one.
- A rejecting `db.close()` still leaves the module's handle cleared: the
  rejection propagates, and the next `startPhoneNode` opens a fresh handle
  instead of handing back a dangling one.
- `startSolo(partyId)` reaches `CadreNode` with an empty `bootstrapNodes` list;
  `startPhoneNode` passes its `partyId` and `bootstrapAddrs` through unchanged.
- The config carries `network.listenAddrs: []` — NativeScript clients cannot
  listen for inbound connections, and a "helpful" default here would be a silent
  runtime failure on device.
- Both node-local stores are wired into the config (`trustedOwners.store`,
  `bootstrapPeers.store`) and are the ones opened for `opts.partyId`.

### Phase 4 — docs + validation

- `docs/STATUS.md`: three claims go stale with this ticket and must be
  corrected, not appended to —
  1. the stale-build-guard section (~line 574) says `reference-app-ns` "has no
     `vitest.config.ts` yet" and is one of two unguarded packages;
  2. the type-check-coverage section (~line 597) repeats the same claim;
  3. the same section's "tenth workspace ... nothing to include there" wording.
- Run, streaming output (never a silent redirect — the runner's idle timer is
  10 minutes):
  - `yarn workspace @serfab/reference-app-ns test 2>&1 | tee <scratch>/ns-test.log`
  - `yarn workspace @serfab/reference-app-ns typecheck 2>&1 | tee <scratch>/ns-tsc.log`
  - `yarn lint 2>&1 | tee <scratch>/lint.log`
  - `yarn check:vitest-typecheck-coverage && yarn check:test-file-typecheck-coverage`
  - `yarn dep-check` (knip) — this package's knip cleanliness was hard-won; a
    regression here is yours, not pre-existing.

## Edge cases & interactions

- **Module-singleton bleed.** `cadre-phone.ts` holds `node` and `identityDb` at
  module scope. Without `vi.resetModules()` per test, a test that leaves a node
  "running" makes the next `startPhoneNode` early-return and the assertions read
  the previous test's state. Verify the reset works by writing two tests that
  each assert "exactly one open" — if they pass individually but not together,
  the reset is not taking.
- **Partial mock of `@serfab/cadre-core`.** Spreading the namespace from
  `importOriginal` must keep every other export live; if
  `PersistentTrustedOwnerStore` comes back `undefined`, the suite will fail in a
  confusing place. Assert early (or let the first store test fail loudly) rather
  than defaulting.
- **`vi.mock` hoisting.** The factories run before the file's own top-level
  `const`s. Fakes referenced from a factory must come from `vi.hoisted`.
- **Two suites, two different `@serfab/cadre-core` treatments.** `node-local-slots.spec.ts`
  uses the module unmocked; `cadre-phone.spec.ts` mocks one export of it. Mocks
  are per-file in Vitest, but confirm both suites pass in the *same* run, not
  only in isolation.
- **The stale-build guard fires on a dirty sibling checkout.** If
  `../optimystic` or `../quereus` has unbuilt `src` edits, the whole suite fails
  at `globalSetup` with a message naming the package. That is the guard working;
  build the sibling, do not weaken the target list.
- **`test:bundle` must stay green.** The webpack bundle entry is `app/app.ts`,
  so `test/` is outside its graph — but the new devDependency and the changed
  `tsconfig.json` `include` are shared, so re-run
  `yarn workspace @serfab/reference-app-ns test:bundle` once at the end.
- **The `KvStoreApi` fake and the real `SqliteKVStore` can drift.** The local
  interface in `src/node-local-slots.ts` is a hand-written subset; nothing checks
  the real class still satisfies it beyond `cadre-phone.ts` assigning one to the
  other, which stays type-checked. Do not add a runtime check for this — the
  type-level assignment in `cadre-phone.ts` is the guard.
- **Read fault vs absent key is the load-bearing distinction** in both suites.
  A test that asserts only "rejects" without asserting "did not resolve
  undefined" is weaker than it looks; assert the rejection *and*, where the store
  is involved, that nothing was written.

## Follow-on

`debt-ns-invite-trust-tests` (this ticket is its `prereq`) adds the
`@nativescript/core` alias and the view-model suites for `src/cadre-vm.ts` and
`app/settings/settings-view-model.ts`.
