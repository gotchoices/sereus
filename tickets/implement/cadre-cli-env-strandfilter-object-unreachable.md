----
description: Make object-valued strandFilter (sAppId/strandId) reachable via CADRE_STRAND_FILTER env, and fail loudly on unrecognized filters
files: packages/cadre-cli/src/config/types.ts, packages/cadre-cli/src/config/loader.ts, packages/cadre-cli/docker/entrypoint.sh, packages/cadre-cli/test/strand-filter.spec.ts, packages/cadre-core/src/types.ts
----

## Problem (reproduced)

`CADRE_STRAND_FILTER` is mapped to the `strandFilter` config key (`types.ts:85`), but
the env-driven path can only ever produce `all`/`none`:

- `parseEnvValue` (`loader.ts:58-68`) returns the **raw string** for this var. There is no
  branch that turns an object-shaped value into an object.
- `parseStrandFilter` (`loader.ts:128-136`) only honors `{ sAppId }` / `{ strandId }` when the
  value is *already* a JS object. For any unrecognized string it **silently** returns
  `{ mode: 'all' }`.

This was confirmed with a throwaway test: setting `CADRE_STRAND_FILTER='{ "sAppId": "myapp" }'`
and running `applyEnvironmentOverrides` + `parseStrandFilter` yields `{ mode: 'all' }`, and
`parseStrandFilter('garbage')` also yields `{ mode: 'all' }`.

The container path is **doubly broken**: the Docker entrypoint writes the value verbatim into the
generated YAML (`entrypoint.sh:94-97`), so `strandFilter: {sAppId: x}` can land as a valid YAML
object in the file — but `applyEnvironmentOverrides` then runs against the loaded config at startup
(env var is still set in the container) and **clobbers** that object back to the raw string, so it
degrades to `all` regardless. The net effect: the documented `sAppId`/`strandId` filtering modes
are unreachable through the env-driven container/systemd deployment path, and the failure is silent
— a misconfigured node quietly over-subscribes to **all** strands.

## Desired behavior

1. Object-valued strand filters are settable through the environment by passing a JSON value, e.g.
   `CADRE_STRAND_FILTER='{"sAppId":"myapp"}'` or `'{"strandId":"<id>"}'`. The scalar forms
   `all` / `none` continue to work as bare strings.
2. An unrecognized / malformed strand-filter value **fails loudly** (throws with a clear message
   naming the valid forms) instead of silently defaulting to `mode: 'all'`. This applies to both the
   env path and a hand-edited config file.

## Design

### `parseEnvValue` (`loader.ts`)

Add a dedicated branch for `CADRE_STRAND_FILTER`. Keep `all`/`none` (case-insensitive, trimmed) as
bare strings; otherwise attempt `JSON.parse`. If the value starts with `{` (an intended object) but
fails to parse, throw a clear error — do **not** fall through to a raw string that would later
degrade. Decompose into a small helper (`parseStrandFilterEnv(value: string): unknown`) per the
"small, single-purpose functions" rule rather than inlining a multi-line block in `parseEnvValue`.

Note: `js-yaml` flow syntax (`{sAppId: x}`) is also valid JSON-ish but not strict JSON; standardize
on **JSON** as the documented env format (matches the `_NODES`/`_ADDRS` precedent of an explicit,
parseable encoding). Document the JSON requirement in a comment.

### `parseStrandFilter` (`loader.ts`)

- Keep the `undefined`/`'all'`/`'none'` scalar handling.
- For objects: validate that the discriminant field is a non-empty string before returning the
  `sAppId`/`strandId` mode. Reject objects carrying neither (or both) keys.
- Replace the trailing `return { mode: 'all' }` fallback with a `throw new Error(...)` whose message
  lists the accepted forms (`all`, `none`, `{"sAppId":"..."}`, `{"strandId":"..."}`) and echoes the
  offending value. This is the single validation point for both env and file-loaded configs.

This throw surfaces during `resolveConfig` → node startup, which is the correct loud-failure point
for a misconfigured container/systemd unit (the process should refuse to start rather than
over-subscribe).

### `types.ts`

`CliConfigFile.strandFilter` is currently typed as the union of scalar + object literal forms. Since
the env override now injects a parsed value before `parseStrandFilter`, no type change is strictly
required, but confirm `parseStrandFilter`'s input type still accepts the post-env-override shape
(it receives `unknown`-ish data from the merged config). Widen the `parseStrandFilter` parameter
type if needed (e.g. accept `unknown`) so the validation logic type-checks cleanly without `any`.

### `entrypoint.sh`

The verbatim-write of `CADRE_STRAND_FILTER` into YAML (`entrypoint.sh:94-97`) becomes redundant once
the env override is authoritative, but it is also harmless **iff** the value is valid YAML. To avoid
two divergent parse paths, the simplest correct change is to keep writing it (so the file reflects
the effective config for debugging) while relying on the env-override path as the source of truth.
Add a short comment in the entrypoint noting that `CADRE_STRAND_FILTER` must be JSON for the
`sAppId`/`strandId` object forms (e.g. `CADRE_STRAND_FILTER='{"sAppId":"myapp"}'`), and that bare
`all`/`none` are also accepted. JSON object syntax is valid YAML flow, so the verbatim file write
remains parseable.

## TODO

- [ ] In `loader.ts`, add `parseStrandFilterEnv(value: string): unknown` helper and call it from
      `parseEnvValue` for `envVar === 'CADRE_STRAND_FILTER'`: trim; return `'all'`/`'none'` lowercased
      as-is for those scalars; else `JSON.parse`; throw a clear error if a `{`-leading value fails to
      parse.
- [ ] In `loader.ts`, harden `parseStrandFilter`: validate `sAppId`/`strandId` are non-empty strings,
      and replace the silent `return { mode: 'all' }` fallback with a `throw` naming valid forms and
      echoing the bad value. Widen the parameter type away from the narrow literal union if needed
      (no `any`).
- [ ] In `entrypoint.sh`, add a comment documenting the JSON env format for object filters; verify the
      verbatim YAML write still produces a parseable file for `{"sAppId":...}`.
- [ ] Add `packages/cadre-cli/test/strand-filter.spec.ts` covering: `all`/`none` scalars via env;
      `{"sAppId":"x"}` and `{"strandId":"x"}` JSON via env round-trip through
      `applyEnvironmentOverrides` + `parseStrandFilter` to the correct mode; malformed JSON throws;
      unrecognized scalar string throws; empty/missing discriminant object throws. (No prior test file
      for this module exists — see `test/protobuf-identity.spec.ts` for the env/tmpdir test style.)
- [ ] Run `yarn workspace @serfab/cadre-cli build && yarn workspace @serfab/cadre-cli typecheck &&
      yarn workspace @serfab/cadre-cli test` and ensure green.
- [ ] If any docs enumerate `CADRE_*` env vars (grep `CADRE_STRAND_FILTER` under `docs/`), update them
      to document the JSON object format and the loud-failure behavior.
