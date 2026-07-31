description: One package keeps its test files hidden from the type checker because a handful of them still have type errors, so those tests get no type safety at all — fix the errors and stop hiding them.
files: packages/cadre-provider/tsconfig.typecheck.json, packages/cadre-provider/src/service/__tests__/container-seed-endpoint.test.ts, packages/cadre-provider/src/service/__tests__/orchestrator-port-leak.test.ts, packages/cadre-host/package.json, packages/cadre-host/ui/tsconfig.json, docs/STATUS.md
difficulty: easy
---

# Bring `cadre-provider` test files (and `cadre-host/ui` test files) under `typecheck`

## Measured state — the plan ticket's premise was half-stale

The plan ticket said three packages exclude their tests. Re-measured on `master` at
`4ab183c`; only one does:

| package | typecheck program | tests in program? | errors |
|---|---|---|---|
| `cadre-core` | `tsconfig.typecheck.json` → `include: ["src", "test", "vitest.config.ts"]` | **yes** (`test/*.spec.ts`) | 0 — verified green |
| `cadre-host` (`src`) | `tsconfig.typecheck.json` → `include: ["src", ...]`, no `exclude` | **yes** (`src/**/__tests__/**`) | 0 — verified green |
| `cadre-host` (`ui`) | not in any program that runs | **no** (`ui/__tests__/*.test.ts`) | 0 — `tsc -p ui/tsconfig.json --noEmit` exits 0 today |
| `cadre-provider` | `tsconfig.typecheck.json` has `"exclude": ["src/**/__tests__/**"]` | **no** | **4** |

`cadre-core` / `cadre-host` `src` were already fixed by commit `c5b7afa`
(`ticket(implement): widen-typecheck-cadre-core-host-tests`). `docs/STATUS.md` was never
updated to match and still describes that gap as open, plus points at a ticket slug that is
not on the board. So the remaining work is `cadre-provider`, the `cadre-host/ui` test files,
and the doc.

Verification commands used (re-run these to confirm before changing anything):

```
cd packages/cadre-core   && npx tsc -p tsconfig.typecheck.json --noEmit   # exit 0
cd packages/cadre-host   && npx tsc -p tsconfig.typecheck.json --noEmit   # exit 0
cd packages/cadre-host   && npx tsc -p ui/tsconfig.json --noEmit          # exit 0
cd packages/cadre-provider && npx tsc -p tsconfig.json --noEmit --rootDir .  # exit 2, 4 errors
```

## The four `cadre-provider` errors, and why they happen

```
src/service/__tests__/container-seed-endpoint.test.ts(112,18): error TS2352: Conversion of type 'undefined' to type 'RequestInit' may be a mistake because neither type sufficiently overlaps with the other. If this was intentional, convert the expression to 'unknown' first.
src/service/__tests__/container-seed-endpoint.test.ts(112,44): error TS2493: Tuple type '[]' of length '0' has no element at index '1'.
src/service/__tests__/orchestrator-port-leak.test.ts(129,18): error TS2352: Conversion of type 'undefined' to type '{ Env: string[]; HostConfig: { PortBindings: Record<string, { HostIp?: string | undefined; HostPort: string; }[]>; }; }' may be a mistake because neither type sufficiently overlaps with the other.
src/service/__tests__/orchestrator-port-leak.test.ts(129,43): error TS2493: Tuple type '[]' of length '0' has no element at index '0'.
```

Both are the same shape. A spy is declared with a **zero-argument** implementation:

```ts
const fetchMock = vi.fn(async () => jsonResponse({ success: true, peersAdded: 1 }));
```

so `vi.fn` infers the call-arguments tuple as `[]`, and the later read
`fetchMock.mock.calls[0]?.[1]` indexes past the end of an empty tuple — `TS2493` — yielding
`undefined`, which the `as RequestInit` cast then rejects — `TS2352`. The production code
*does* pass arguments; the double just didn't say so.

The fix is to declare the parameters the double actually receives, not to cast harder. Two
sibling call sites in the same repo already do exactly this and are error-free — the
`_url`/`_init` spy at `container-seed-endpoint.test.ts:153` and `createVolume` in
`src/service/__tests__/fake-docker.ts` (`vi.fn(async (options: { Name?: string }) => …)`),
which types its parameter as the subset shape the test cares about. Follow that precedent.

### `container-seed-endpoint.test.ts:106`

```ts
// before
const fetchMock = vi.fn(async () => jsonResponse({ success: true, peersAdded: 1 }));
// after
const fetchMock = vi.fn(async (_url: string | URL, _init?: RequestInit) =>
  jsonResponse({ success: true, peersAdded: 1 }));
```

`mock.calls[0]?.[1]` then types as `RequestInit | undefined` and the existing
`as RequestInit` at line 112 narrows a union rather than converting `undefined` — legal, and
it may as well stay since the surrounding assertions already assume the init is present.

### `orchestrator-port-leak.test.ts:115`

`fakeDocker` is already `as unknown as Docker` wholesale, so the spy's own signature is free.
Type the parameter as the shape the assertions read and **drop the cast entirely**:

```ts
/** The subset of dockerode's create options this test asserts on. */
type CreateOpts = {
  Env: string[];
  HostConfig: { PortBindings: Record<string, Array<{ HostIp?: string; HostPort: string }>> };
};

const createSpy = vi.fn(async (_opts: CreateOpts) => ({
  id: 'cid-secure',
  start: vi.fn(async () => {}),
  remove: vi.fn(async () => {}),
}));
…
const opts = createSpy.mock.calls[0]![0];   // no `as` needed
```

Do **not** reach for `Docker.ContainerCreateOptions` here: its `Env` and `HostConfig` are
optional and its `PortBindings` is loosely typed, so every assertion below would need a `!`
and the `HostIp` check would lose its type. The local subset type is both stricter and
self-documenting. If `DockerOrchestrator` ever stops passing `Env`/`HostConfig`, this
parameter type is what fails — which is the point.

Note the other three `createContainer` doubles in the same file (lines ~29, ~52, ~93) are
*not* errors today because nothing reads their `mock.calls`. Leave them alone unless
touching them is needed; widening them is scope creep.

## `cadre-provider` config change

`packages/cadre-provider/tsconfig.typecheck.json` — delete the `exclude` key and the comment
block above it (lines 8–15). `include: ["src", "vitest.config.ts"]` then reaches
`src/**/__tests__/**` on its own. `rootDir: "."` stays correct: unlike `cadre-core` /
`cadre-host`, no `cadre-provider` test reaches outside the package (`test-harness` is only
mentioned in a comment in its `vitest.config.ts`, never imported), so there is no `TS6059`
risk and no reason to widen `rootDir` to `../..`.

## `cadre-host/ui` test files

`packages/cadre-host/vitest.config.ts` collects `ui/__tests__/**/*.test.ts` alongside
`src/**/__tests__/**/*.test.ts`, but `ui/` is not in `tsconfig.typecheck.json`'s program and
cannot join it — `ui/tsconfig.json` extends `@tsconfig/svelte`, uses `bundler` module
resolution and `types: ["svelte", "vite/client"]`, which the package's `NodeNext` program
cannot absorb. `ui/tsconfig.json` already lists `__tests__/**/*.ts` in its `include`, and it
already passes; nothing invokes it. Wire it in as a second compiler pass:

```jsonc
// packages/cadre-host/package.json
"typecheck": "tsc -p tsconfig.typecheck.json --noEmit && tsc -p ui/tsconfig.json --noEmit",
```

`tsc` silently ignores the `src/**/*.svelte` entries in that `include` (it cannot parse
`.svelte`), so this pass covers the `.ts` files only — which is the whole point. The
`.svelte` gap stays out of scope and stays owned by `check:svelte` / `svelte-check`.

Confirm `scripts/check-vitest-typecheck-coverage.mjs` still passes after this: it parses
`-p`/`--project` out of the `typecheck` script and per `docs/STATUS.md` already handles the
two-`-p` case where only one program covers `vitest.config.ts`. If it does not, that is a
real guard bug — fix the guard, do not revert the script change.

## `docs/STATUS.md`

In "Type-check coverage" (~line 542):

- Move `cadre-core`, `cadre-host`, `cadre-provider` from the "Shippable **source only**"
  bullet to the "Source **+ tests**" bullet. `strand-proto` stays source-only.
- Delete the first "Known coverage gaps" bullet (the `cadre-core`/`cadre-host` type-drift one
  naming `debt-widen-typecheck-to-test-files`) — it is closed.
- Delete the third gap bullet's first sentence about `cadre-provider` explicitly excluding
  its tests; keep the `strand-proto` sentence.
- Keep the `.svelte` gap bullet, and extend it to say `cadre-host`'s `ui/__tests__/*.ts` is
  now covered by a second `tsc` pass over `ui/tsconfig.json` while the `.svelte` files still
  are not.
- Do not leave the file claiming a gap that no longer exists — that stale claim is precisely
  what made this ticket look three times bigger than it is.

## Edge cases & interactions

- **Typing a mock must not change what it returns.** Adding parameters to `vi.fn` changes
  only the declared signature, but a slip (e.g. reordering, or accidentally consuming an arg)
  changes runtime behavior silently. `yarn test` inside `packages/cadre-provider` is a
  required gate, not a nicety — all 19 test files must still pass.
- **Unused-parameter lint.** New parameters exist only to shape the tuple, so they must be
  `_`-prefixed (`_url`, `_init`, `_opts`) per `AGENTS.md`. Run `yarn lint` — the flat config
  is a fully-enforced gate with no `warn` tier.
- **The other 17 `cadre-provider` test files enter the program for the first time.** The
  4-error measurement above came from a full `tsc -p tsconfig.json --noEmit --rootDir .`, so
  they are believed clean — but `tsconfig.typecheck.json` is not byte-identical to
  `tsconfig.json` (it adds `noEmit` and pins `rootDir: "."`). Re-run
  `yarn workspace @serfab/cadre-provider typecheck` after the config edit and treat any
  additional error as in-scope for this ticket, not as a surprise to defer.
- **`fake-docker.ts` and other non-`.test.ts` helpers** under `__tests__` also enter the
  program. They were in the 4-error measurement, so expect zero — but they are the likeliest
  source of a surprise since nothing type-checked them before either.
- **Root gate must be green end to end**, not just per-package: `yarn typecheck` at the repo
  root fans out to all 10 workspaces and then runs `yarn check:vitest-typecheck-coverage`.
  Run the root command, not only the two package commands.
- **No silencing.** No `as unknown as`, no `@ts-expect-error`, no `any`, no re-narrowing a
  program to dodge an error, and no `it.skip` / loosened assertion to get a green run. If a
  test asserts against a stale API shape, update the assertion to the current shape.
- **`cadre-core` / `cadre-host` need no code changes.** Verify they are still green after
  the `docs/STATUS.md` edit; do not "fix" anything there.

## TODO

- Re-run the four verification commands above on the current tree to confirm the measured
  state still holds before editing.
- Fix `container-seed-endpoint.test.ts:106` — declare `(_url: string | URL, _init?: RequestInit)`
  on the `fetchMock` spy.
- Fix `orchestrator-port-leak.test.ts:115` — add the local `CreateOpts` type, declare
  `(_opts: CreateOpts)` on `createSpy`, drop the `as { … }` cast at line 129.
- Drop the `exclude` key + its comment block from `packages/cadre-provider/tsconfig.typecheck.json`.
- Chain `tsc -p ui/tsconfig.json --noEmit` into `packages/cadre-host`'s `typecheck` script.
- Run `yarn workspace @serfab/cadre-provider typecheck` and
  `yarn workspace @serfab/cadre-host typecheck`; fix anything that surfaces.
- Run `yarn workspace @serfab/cadre-provider test` (streamed, e.g. `2>&1 | tee`) — all suites pass.
- Run root `yarn typecheck`, `yarn lint`, and `yarn check:vitest-typecheck-coverage`.
- Update `docs/STATUS.md` → "Type-check coverage" per the section above.
