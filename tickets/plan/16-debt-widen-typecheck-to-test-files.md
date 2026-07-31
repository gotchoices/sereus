description: Test files in three packages are deliberately kept out of the type checker because they still contain type errors left over from library upgrades, so those tests get no type safety at all — fix the errors and let the checker see them.
files: packages/cadre-core/tsconfig.typecheck.json, packages/cadre-host/tsconfig.typecheck.json, packages/cadre-provider/tsconfig.typecheck.json, packages/cadre-provider/src/service/__tests__/container-seed-endpoint.test.ts, packages/cadre-provider/src/service/__tests__/orchestrator-port-leak.test.ts, docs/STATUS.md
difficulty: medium
---

# Bring `cadre-core`, `cadre-host` and `cadre-provider` test files under `typecheck`

## Background

`yarn typecheck` covers every package, but three packages deliberately restrict their
type-check program to shippable source and exclude their own test files. The reason is
historical: those tests accumulated type errors during dependency upgrades, and widening the
program would have turned the gate red, so the scope was left narrow with a note in
`docs/STATUS.md` promising a follow-up. That follow-up was never filed — `docs/STATUS.md`
referenced a ticket slug (`widen-typecheck-cadre-core-host-tests`) that does not exist on the
board. This ticket is that missing work, extended to `cadre-provider`, which turned out to
have the same problem.

Consequence today: those test files are checked by nothing. Vitest does not type-check, and
`tsc` never sees them. A test can reference a removed API, pass a wrong-shaped object, or
drift from the production types indefinitely, and only fail at runtime — if it fails at all.

## What is known about the errors

- **`cadre-provider`** — small and bounded. Four errors across two files, both of the same
  kind: a `as`-cast of a `undefined` value pulled out of an empty mock-call tuple.

  ```
  src/service/__tests__/container-seed-endpoint.test.ts(112,18): error TS2352: Conversion of type 'undefined' to type 'RequestInit' may be a mistake …
  src/service/__tests__/container-seed-endpoint.test.ts(112,44): error TS2493: Tuple type '[]' of length '0' has no element at index '1'.
  src/service/__tests__/orchestrator-port-leak.test.ts(125,18): error TS2352: Conversion of type 'undefined' to type '{ Env: string[]; HostConfig: { … } }' may be a mistake …
  src/service/__tests__/orchestrator-port-leak.test.ts(125,43): error TS2493: Tuple type '[]' of length '0' has no element at index '0'.
  ```

  Reproduce with `npx tsc -p tsconfig.json --noEmit --rootDir .` from inside the package.
  These look like the mock helper being typed as an empty tuple rather than a call-arguments
  tuple — worth fixing the helper's typing rather than casting at each call site.

- **`cadre-core` tests and `cadre-host` server tests** — larger and not re-measured recently.
  `docs/STATUS.md` describes the drift as: libp2p `peerId` → `privateKey`,
  `CadreNodeConfig.privateKey` now a `PrivateKey` rather than a `Uint8Array`, a new
  `NodePorts.admin` field, and implicitly-`any` parameters. Measure the real error count
  before deciding whether this splits into per-package tickets.

## Expected outcome

- Test files are inside each package's `typecheck` program (the `tsconfig.typecheck.json`
  `include` gains `test` / stops excluding `src/**/__tests__/**`), and `yarn typecheck` is
  green at the root.
- Errors are fixed at the source — a test asserting against a stale API shape should be
  updated to the current shape. No blanket `as unknown as`, no `@ts-expect-error` used as a
  silencer, no re-narrowing the program to dodge a hard case.
- The tests still pass afterwards. Type-correcting a mock can quietly change what it returns,
  so `yarn test` per package matters as much as `yarn typecheck` here.
- `docs/STATUS.md` → "Type-check coverage" loses the "known coverage gaps" entries this
  closes, rather than being left describing a gap that no longer exists.

## Scope note

`cadre-host`'s `ui/` Svelte files and `reference-app-web`'s `.svelte` files are a **separate**
gap — `tsc` cannot check `.svelte` at all, that needs `svelte-check`. Out of scope here.
`strand-proto` is deprecated and stays source-only by design; also out of scope.

Splitting this per package is reasonable if `cadre-core`/`cadre-host` turn out to be much
larger than `cadre-provider` — start by measuring, then decide.
