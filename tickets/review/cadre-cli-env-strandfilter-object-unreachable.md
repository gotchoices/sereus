description: Review — object-valued strandFilter (sAppId/strandId) now reachable via CADRE_STRAND_FILTER env, and unrecognized filters fail loudly
files: packages/cadre-cli/src/config/loader.ts, packages/cadre-cli/test/strand-filter.spec.ts, packages/cadre-cli/docker/entrypoint.sh, packages/cadre-cli/docker/env.example, ops/docker/sereus-node/env.example

## What was implemented

The env-driven `CADRE_STRAND_FILTER` path previously could only ever yield `all`/`none`, and any
unrecognized value silently degraded to `{ mode: 'all' }` — so the documented `sAppId`/`strandId`
object filters were unreachable through the container/systemd deployment, and a misconfigured node
quietly over-subscribed to **all** strands. Both halves are now fixed in `loader.ts`:

- **New `parseStrandFilterEnv(value: string): unknown` helper** (called from `parseEnvValue` when
  `envVar === 'CADRE_STRAND_FILTER'`):
  - empty value → `'all'` (this is the docker-compose default `CADRE_STRAND_FILTER=`, which stays set
    in the container process even when the entrypoint omits it from the generated YAML — see the gap
    note below; this guard prevents a default node from crashing on startup);
  - `all`/`none` (trimmed, case-insensitive) → kept as scalar strings;
  - otherwise `JSON.parse`. A `{`-leading value that fails to parse **throws** (with the original
    parse error attached as `cause`) instead of degrading to a raw string. Any other unrecognized
    scalar is passed through unchanged for `parseStrandFilter` to reject loudly.
- **`parseStrandFilter` hardened** and re-typed to accept `unknown` (env overrides inject
  already-parsed JSON ahead of the narrow `CliConfigFile` type):
  - `undefined`/`null`/`'all'` → `{ mode: 'all' }`; `'none'` → `{ mode: 'none' }`;
  - objects must carry **exactly one** discriminant (`sAppId` xor `strandId`) whose value is a
    **non-empty string**;
  - the silent `return { mode: 'all' }` fallback is replaced with a `throw` naming all valid forms
    and echoing the offending value. This is the single validation point for **both** env and
    file-loaded configs, and surfaces during `resolveConfig` → node startup (correct loud-failure
    point: the process refuses to start rather than over-subscribe).
- **`entrypoint.sh`**: added a comment documenting the JSON env format for object filters and noting
  the env override is authoritative at startup (the verbatim YAML write only mirrors effective config
  for debugging; JSON object syntax is valid YAML flow, so it stays parseable). No behavioral change.
- **Docs**: `packages/cadre-cli/docker/env.example` already documented the JSON form — added the
  loud-failure note. `ops/docker/sereus-node/env.example` was **stale and wrong** ("comma-separated
  strand IDs" — never how it worked) and was rewritten to match. No `CADRE_*` enumerations exist
  under `docs/` (grep clean).

No change was needed in `cadre-core/src/types.ts` — `StrandFilter` already has the right shape.

## How to validate

Build/typecheck/test/lint all green locally:
`yarn workspace @serfab/cadre-cli build && ... typecheck && ... test` → **77 passed (7 files)**;
`yarn lint` → clean.

New test file `test/strand-filter.spec.ts` (16 tests) covers both the direct `parseStrandFilter`
path and the realistic env round-trip (`applyEnvironmentOverrides` → `parseStrandFilter`, mirroring
`resolveConfig`):

- scalars `all`/`none` via env (incl. `  ALL  ` / `None` case+trim);
- empty env → `all` (docker-compose default guard);
- `{"sAppId":"x"}` and `{"strandId":"x"}` JSON via env → correct mode;
- malformed JSON (`{"sAppId":`) throws (`/CADRE_STRAND_FILTER/`, at `applyEnvironmentOverrides`);
- unrecognized scalar (`myapp`/`garbage`) throws (`/Invalid strandFilter/`, at `parseStrandFilter`);
- object with no/empty/both discriminants, or non-string discriminant, throws.

Manual smoke (optional): `CADRE_STRAND_FILTER='{"sAppId":"myapp"}' node dist/bin/cadre.js start -c <cfg>`
should resolve `mode: sAppId`; a typo'd value should abort startup with the descriptive error.

## Known gaps / reviewer attention

- **Behavioral change — fail-loud is intended but not backward compatible.** Any deployment that
  previously relied on the silent `all` fallback for a malformed value (a typo'd env, or a file with
  e.g. `strandFilter: All` — note `parseStrandFilter` is **case-sensitive** for file configs; only
  the env path lowercases) will now **refuse to start**. This is exactly the desired behavior per the
  ticket, but flag it for any existing nodes. Confirm there's no operational doc promising the old
  lenient behavior.
- **Empty-env semantics.** `CADRE_STRAND_FILTER=` (empty) is mapped to `all` rather than treated as
  "no override / keep file value". In the docker path this is moot (the file is generated *from* env,
  so there's no file value to preserve), but a reviewer should confirm this is acceptable for any
  non-docker invocation that sets the var empty while also setting `strandFilter` in a config file —
  the empty env would clobber the file's object to `all`. Generic `applyEnvironmentOverrides` only
  skips on `undefined`, not empty string, so handling it in the parse helper was the least-invasive
  fix; an alternative is to make the override skip empty strings centrally.
- **No shell-side validation in `entrypoint.sh`.** A malformed value is still written verbatim into
  the YAML and caught at CLI startup (single validation point by design). That's intentional, but the
  failure message comes from the node process, not the entrypoint.
- **Out of scope — `cadre-provider`.** `ContainerRequest.strandFilter` is typed `string` and passed
  verbatim as `CADRE_STRAND_FILTER` (`docker-orchestrator.ts:117`). Object filters therefore require
  the provider's HTTP caller to send a JSON **string** (`'{"sAppId":"x"}'`) — consistent with the new
  env contract, no code break, but undocumented at the provider's API boundary. Not touched here.
