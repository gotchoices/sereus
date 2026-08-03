description: The NativeScript phone app now has a unit-test runner and its first three test suites, covering how the app stores its own small records in the phone's database and how it starts, stops, and drives the networking node.
files: packages/reference-app-ns/package.json, packages/reference-app-ns/tsconfig.json, packages/reference-app-ns/vitest.config.ts, packages/reference-app-ns/test/global-setup.ts, packages/reference-app-ns/test/build-targets.spec.ts, packages/reference-app-ns/test/node-local-slots.spec.ts, packages/reference-app-ns/test/cadre-phone.spec.ts, packages/reference-app-ns/src/cadre-phone.ts, packages/reference-app-ns/README.md, docs/reference-app-ns.md, docs/STATUS.md
---

# Complete: Vitest harness for `reference-app-ns` + its first three suites

`packages/reference-app-ns` had three checks (`typecheck`, `test:bundle`,
`test:e2e` — the last needs a device, so nothing automated ran it) and no unit
test runner. It now runs Vitest: **45 tests across 3 files**, green.

## What shipped

**Harness.** `vitest` `^4.0.17` (resolves 4.1.8) in `devDependencies`, scripts
`"test": "vitest run"` / `"dev:test": "vitest"` matching every other workspace.
`vitest.config.ts` is a single project, `environment: 'node'`,
`include: ['test/**/*.spec.ts']`, `globalSetup: ['./test/global-setup.ts']`. No
`@nativescript/core` alias — neither suite imports it. `tsconfig.json`'s
`include` gained `"test/**/*.ts"` and `"vitest.config.ts"`; the package's
`customConditions: ["react-native", "browser"]` turned out not to disturb
resolution of the `vitest` type entries, so no second tsconfig and no chained
script (the ticket's path A).

**Stale-build guard.** `test/global-setup.ts` + `test/build-targets.spec.ts`,
mirroring `reference-app-rn`'s pair with `@optimystic/db-p2p-storage-ns` in place
of the `-rn` one. Same eight targets, over the shared
`test-harness/build-freshness.ts` and `test-harness/build-targets-spec.ts`.

**`node-local-slots.spec.ts`** — 24 tests. A `FakeKvStore` implementing the
exported `KvStoreApi` (a `Map` plus injectable `getError` / `setError`). Covers
`kvSlot` round-trip / absent key / read fault / write fault; the two key strings
as exact literals; per-party distinctness and cross-family non-collision; then
the real `PersistentTrustedOwnerStore` and `PersistentBootstrapPeerStore` over a
real `kvSlot` (reopen, raw envelope, junk text, foreign `partyId`, read fault,
failed persist, both records sharing one store).

**`cadre-phone.spec.ts`** — 21 tests (16 from implement, 5 added in review).
Mocks `@optimystic/db-p2p-storage-ns` (recording `openOptimysticNSDb`, a stub
`loadOrCreateNSPeerKey`, and a `SqliteKVStore` fake that applies its prefix
exactly like the real class) and `../src/ns-storage`; mocks **only** the
`CadreNode` export of `@serfab/cadre-core`, so both node-local stores stay real
over the fake KV. Drives the module through its real exports with
`vi.resetModules()` + a dynamic import per test.

The implementer's load-bearing detail worth keeping in view: `@serfab/cadre-core`
is imported statically at file scope and its namespace is cached across
`vi.resetModules()`. Evaluating that package's compiled graph takes seconds; done
inside a test body it blows the default 5s `testTimeout` and the timed-out
in-flight imports cascade into a test running the *real* `CadreNode`. Charged to
the import phase instead, the whole file's test time is well under a second.

## Review findings

### Checked and clean — no action

- **The shared guard is not duplicated.** `build-targets.spec.ts` goes through
  `test-harness/build-targets-spec.ts`; the only per-package parts are the suite
  name, the package root, and the two pinned dependencies. Same shape as
  `reference-app-rn` / `reference-app-web`.
- **`TARGETS` is correct and its doc comment is accurate.** The list is
  deliberately wider than `dependencies` (it adds `quereus-plugin-sereus` and the
  two `@optimystic/quereus-plugin-*`, reached transitively) and correctly does
  *not* claim `@optimystic/db-core` as an extra, since this package declares it
  directly — unlike the `-rn` comment it was adapted from.
- **Script naming matches every other workspace** (`test` / `dev:test`), so the
  root `yarn test` foreach picks it up with no root change.
- **`docs/STATUS.md`'s new claims hold.** `cadre-provider` really is now the only
  package with no stale-build guard — verified it declares zero `workspace:` /
  `link:` / `file:` dependencies and its `vitest.config.ts` has no `globalSetup`.
  Ten workspaces, ten vitest configs, all inside a type-check program.
- **`node-local-slots.spec.ts` needed nothing.** Happy path, absent key, both
  fault directions, key-shape pinning, cross-family collision, cold start over
  junk and over a foreign party, failed persist, and the shared-store case are all
  present. The one test that could have been theatre — "the two key families never
  collide" — is backed by a real end-to-end assertion in the sibling suite.

### Found and fixed in this pass

- **Five exported functions had zero coverage.** Everything past `stopPhoneNode`
  in `src/cadre-phone.ts` — `applySeed`, `decodeSeed`, `dialPeer`,
  `getConnectionPaths`, `addStrand` — was untested: neither the "not started"
  guard nor the forward to the node. Added four tests. `FakeCadreNode` grew
  recording implementations of those methods plus a `FakeControlNode` for
  `getControlNode()`, returning opaque sentinels (the wrappers add nothing but the
  guard, so identity is the whole assertion — no cast, no fabricated cadre-core
  result shapes). `dialPeer` is now checked on both branches, and asserted to hand
  libp2p a **parsed** `Multiaddr` rather than the raw string.
- **The `identityDb ??=` reuse branch was never exercised.** Every existing test
  reached the open call with `identityDb` null. Added a test that fails a start,
  then retries: the retry must fall through the `node?.isRunning` early-return and
  reuse the handle the failed start left open, because a second open there strands
  a native SQLite handle that then blocks every later open of the same file.
- **Both docs that enumerate this package's checks were stale.** Neither
  `docs/reference-app-ns.md` § "Testing Strategy" nor
  `packages/reference-app-ns/README.md` § "Scripts" listed the new unit tier — the
  implement pass updated `STATUS.md` only. Added a row to each, plus a
  "Unit suite" subsection in `docs/reference-app-ns.md` stating what is real, what
  is mocked, and what has no coverage. Also corrected the neighbouring claim that
  the bundle smoke "is the only runtime-adjacent gate an agent or CI without an
  Android device can run" — now true as written (whole-graph reach), rather than
  contradicted by the suite two rows above it.
- **A `STATUS.md` claim was left behaviourally unverified.** It said the
  unknown-key injection check had been run against "the nine configs that existed
  then", quietly exempting the new one. Ran it: injecting
  `notARealVitestOption` into `packages/reference-app-ns/vitest.config.ts` fails
  `typecheck` with the same `TS2769 … does not exist in type 'InlineConfig'`
  fingerprint as the other nine. Reverted the injection; the doc now says ten.

### Recorded as tripwires, not tickets

- **`cadre-core`'s namespace is cached across `vi.resetModules()`** (carried over
  from implement). Harmless today — the suite uses only the two stateless
  node-local store classes from it — and wrong the moment cadre-core grows
  module-scoped mutable state a test needs cleared. `NOTE:` on the `core` field of
  the hoisted state in `packages/reference-app-ns/test/cadre-phone.spec.ts`;
  confirmed present and accurate.
- **The node-delegating helpers guard on `!node`, not on `node.isRunning`.** A
  start that failed inside `CadreNode.start()` leaves a non-running node in the
  singleton until `stopPhoneNode` clears it, and these five helpers would forward
  to it. Unreachable today: their only UI path is `cadre-vm.ts`, which adopts a
  node solely when `existing?.isRunning` and sets status `error` on a failed start.
  `NOTE:` parked above the helper block in
  `packages/reference-app-ns/src/cadre-phone.ts`.

### Filed as a new ticket

- **`backlog/debt-ns-storage-lazy-proxy-untested`** — `src/ns-storage.ts` is the
  only module in `src/` with no coverage at all, and it is not pure boilerplate:
  `openStorage` caches the *promise*, so a rejected open is replayed for every
  later operation on that strand with no retry until the app restarts. Read from
  the code, not run. The ticket covers both the missing tests and the open policy
  question. Checked the board first — nothing under `backlog/`, `fix/`, `plan/`,
  `implement/`, or `review/` mentions that file.

### Deliberately not filed

- **`SqliteKVStore` is faked, not exercised** — by decision recorded at implement
  time. The real driver lives in `@optimystic/db-p2p-storage-ns` and is covered in
  that repo; the only guard that it still satisfies the hand-written `KvStoreApi`
  subset is the type-checked assignment in `cadre-phone.ts`, which should stay a
  type-level check.
- **`CadreNode` is faked wholesale** — the suite proves the config handed to it and
  the handle lifecycle around it, and proves nothing about `CadreNode.start()` or
  the transports beyond "constructed, two of them". That is the intended seam for
  a unit suite; real-node behaviour belongs to `integration-tests` and the device
  e2e harness.
- **View models and pages** — already owned by `implement/debt-ns-invite-trust-tests`
  and `backlog/debt-ns-chat-vm-unit-tests`.

## Validation run at review

All from `C:\projects\sereus` unless noted.

| Command | Result |
| --- | --- |
| `yarn workspace @serfab/reference-app-ns test` | 3 files, **45 tests passed** |
| `yarn workspace @serfab/reference-app-ns typecheck` | exit 0 |
| `yarn workspace @serfab/reference-app-ns test:bundle` | webpack compiled, 0 errors 0 warnings |
| `yarn lint` | exit 0 |
| `yarn check:vitest-typecheck-coverage` | every vitest config inside its typecheck program |
| `yarn check:test-file-typecheck-coverage` | 267 files across 10 packages, 3 allowlisted |
| `yarn dep-check` (knip + dep-ranges) | exit 0; only the pre-existing warn-level dead-code hints |
| unknown-key injection into `vitest.config.ts` | `TS2769` as expected, reverted |
| `yarn workspaces foreach -A --exclude @serfab/integration-tests run test` | 9 workspaces; 1461 passed, **5 pre-existing failures**, 1 skipped |

**The cross-workspace sweep closes the implement handoff's stated gap** — that
the new `test` script had never been shown to run under the root foreach, and
that the shared `tsconfig.json` / devDependency edits had never been shown not to
disturb sibling workspaces. Both now demonstrated.

**`integration-tests` was deliberately excluded and is not covered by this
ticket.** Its suite binds real network ports across 237 tests and routinely runs
past the ten-minute idle budget, so it is not agent-runnable inside a ticket; it
is also independently red (see below). Left for CI or a human.

**Pre-existing failures — already tracked, not re-reported.** The 5 failures in
the sweep are exactly the entries in `tickets/.pre-existing-known.md` for
`packages/cadre-core/test/control-revocation-reissue.spec.ts` (4) and
`control-revocation-replay.spec.ts` (1), owned by the blocked
`10-revocation-reissue-same-pk-update-unique-collision` with the probe fix in
`implement/10-control-revocation-reissue-test-fixes`. Same fingerprints
(`UNIQUE constraint failed: Revocation.TableName, Revocation.StampId` and
`context.OwnerKey isn't a column`). Nothing in this ticket's diff touches that
subsystem, no test was skipped or loosened, and `tickets/.pre-existing-error.md`
was **not** written.

**The stale-build guard fired repeatedly during this review, correctly.** The
linked `../quereus` checkout is being edited concurrently (three modified files in
its working tree), so its `dist` kept going stale mid-review; each run refused to
start until `yarn workspace @quereus/quereus build` was re-run there. Exactly the
failure the guard exists to prevent — the suite would otherwise have reported
green about compiled output that no longer matched its source. Environmental, not
a defect.

## Known limits of the coverage

- `ns-storage.ts` is mocked away and untested — now ticketed (above).
- The suite runs on Windows only. The stale-build guard's junction handling is
  exercised; its POSIX symlink path is not (though `reference-app-rn` and
  `reference-app-web` already share that code).
- `cadre-phone.spec.ts` stays under the default 5s `testTimeout` only because the
  expensive `@serfab/cadre-core` import sits at file scope. A future test that
  reaches a fresh real-cadre-core import from inside a test body will hit the
  cascade described above; the reason is written in the comment on that import.
