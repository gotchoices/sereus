description: Object-valued strandFilter (sAppId/strandId) now reachable via CADRE_STRAND_FILTER env, and unrecognized filters fail loudly. Reviewed + fixed a build-breaking tsconfig gap.
files: packages/cadre-cli/src/config/loader.ts, packages/cadre-cli/tsconfig.json, packages/cadre-cli/test/strand-filter.spec.ts, packages/cadre-cli/docker/entrypoint.sh, packages/cadre-cli/docker/env.example, ops/docker/sereus-node/env.example

## What shipped

The env-driven `CADRE_STRAND_FILTER` path previously could only ever yield `all`/`none`, and any
unrecognized value silently degraded to `{ mode: 'all' }` — so the documented `sAppId`/`strandId`
object filters were unreachable through the container/systemd deployment, and a misconfigured node
quietly over-subscribed to **all** strands. Both halves are fixed in `loader.ts`:

- **New `parseStrandFilterEnv(value)` helper** (called from `parseEnvValue` for
  `CADRE_STRAND_FILTER`): empty → `'all'` (docker-compose default guard), `all`/`none`
  (case-insensitive, trimmed) → scalar, otherwise `JSON.parse`. A `{`-leading value that fails to
  parse throws (with the parse error as `cause`); any other unrecognized scalar passes through for
  `parseStrandFilter` to reject.
- **`parseStrandFilter` hardened** and re-typed to `unknown`: objects must carry exactly one
  discriminant (`sAppId` xor `strandId`) with a non-empty string value; the silent
  `return { mode: 'all' }` fallback is replaced with a descriptive `throw`. Single validation point
  for both env and file configs, surfacing at node startup.
- **Docs**: `entrypoint.sh` comment documents the JSON env format; both `env.example` files note the
  loud-failure behavior; `ops/docker/sereus-node/env.example` (previously wrong — "comma-separated
  strand IDs") rewritten to match.

## Review findings

Scrutinized the implement diff (`d0e5a37`) with fresh eyes before reading the handoff. Angles:
correctness, type safety, error handling, DRY/single-validation-point, cross-platform, docs accuracy,
test coverage (happy/edge/error paths), and out-of-scope blast radius.

### Major — found and fixed inline (build was broken at HEAD)

- **`cadre-cli` did not compile.** `parseStrandFilterEnv` introduced the package's *first*
  `new Error(msg, { cause: err })` (a two-arg `ErrorOptions` ctor from ES2022), but
  `packages/cadre-cli/tsconfig.json` had no `lib` override, so it defaulted to ES2020 libs that lack
  `ErrorOptions`. `yarn workspace @serfab/cadre-cli build` failed with
  `TS2554: Expected 0-1 arguments, but got 2` at `loader.ts:101`. The handoff's "build/typecheck all
  green" claim was **false** — vitest's esbuild transform does not typecheck, so the implementer's
  passing test run masked a red build.
  **Fix:** added `"lib": ["ES2022", "DOM", "DOM.Iterable"]` to `packages/cadre-cli/tsconfig.json`,
  matching the exact precedent in `cadre-core`/`cadre-host` (the two sibling packages that already use
  `{ cause }`). Build now clean. Kept inline rather than filing a ticket because it is squarely this
  ticket's regression and a one-line, idiomatic fix.

### Minor — found and fixed inline

- **Test gap on JSON-scalar/array env values.** The `JSON.parse` branch could return a non-object
  (number, boolean, array) — e.g. a realistic typo `CADRE_STRAND_FILTER=0` — which was unverified.
  Behavior was already correct (`parseStrandFilter` throws), but added a regression test
  (`resolveFromEnv('42')` and `'["x"]'` both throw `/Invalid strandFilter/`). Suite now 78 tests.

### Reviewed — no change needed

- **Object validation logic** (`xor` discriminant, non-empty string guards, both/neither/empty/
  non-string rejection) is correct and well-tested (16 → 17 `it` blocks).
- **Empty-env → `all` guard** is necessary and correct: without it, a default docker node (entrypoint
  omits `strandFilter:` from the YAML, but the empty env var stays in the process) would crash on
  startup. Verified against `entrypoint.sh`'s `[ -n "$CADRE_STRAND_FILTER" ]` write guard.
- **`status.ts`** loads the raw file config (not `resolveConfig`) and displays `strandFilter` without
  validating, so a malformed *file* filter shows in `status` output but still aborts node startup.
  Minor display-vs-runtime inconsistency, pre-existing, out of scope — not worth a ticket.
- **Out-of-scope `cadre-provider`** (`docker-orchestrator.ts:117` passes `request.strandFilter`
  verbatim as the env string) is consistent with the new contract — an object filter is sent as a
  JSON string. Correctly untouched.

### Accepted known gap (no ticket)

- **Non-docker empty-env clobber.** Setting `CADRE_STRAND_FILTER=` (empty) while also setting an
  object `strandFilter` in a config file overrides it to `all`, because the generic
  `applyEnvironmentOverrides` only skips `undefined`, not empty strings. The docker path (the real
  deployment) is unaffected — the file is generated *from* env, so there's no file value to preserve.
  Making the override skip empty strings centrally would change behavior for every env var (riskier);
  the localized empty→`all` choice is the least-invasive fix and is the accepted behavior.

### Validation

- `yarn workspace @serfab/cadre-cli build` → clean (was failing before the tsconfig fix).
- `yarn workspace @serfab/cadre-cli test` → **78 passed (7 files)**.
- `yarn lint` → clean.

## Behavioral note for operators

Fail-loud is intended but **not backward compatible**: any node that previously relied on the silent
`all` fallback for a malformed value (a typo'd env, or a file with e.g. `strandFilter: All` — note the
file path is case-sensitive; only the env path lowercases) will now refuse to start. This is the
desired behavior per the ticket; flag it for any existing nodes.
