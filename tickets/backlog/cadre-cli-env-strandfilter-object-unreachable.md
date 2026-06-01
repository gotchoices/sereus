----
description: strandFilter sAppId/strandId modes cannot be set via environment variable
files: packages/cadre-cli/src/config/types.ts, packages/cadre-cli/src/config/loader.ts, packages/cadre-cli/docker/entrypoint.sh
----
The cadre-cli config layer exposes `CADRE_STRAND_FILTER` as an environment override (`ENV_MAPPINGS` in `packages/cadre-cli/src/config/types.ts:85` maps it to the `strandFilter` config key). However, `parseEnvValue` in `packages/cadre-cli/src/config/loader.ts:57-67` returns the raw string for this variable, so only the scalar forms `all` and `none` ever produce a valid filter. Downstream, `parseStrandFilter` (`packages/cadre-cli/src/config/loader.ts:127-135`) only honors the object forms `{ sAppId }` and `{ strandId }` when the value is already an object; for any unrecognized string it silently falls back to `{ mode: 'all' }`.

The container/systemd path makes this worse. The Docker entrypoint writes the env value verbatim into the generated YAML (`packages/cadre-cli/docker/entrypoint.sh:94-97`), so an operator who sets `CADRE_STRAND_FILTER` to anything other than `all`/`none` gets a node that quietly serves all strands rather than the intended `sAppId`/`strandId` subset.

This diverges from Sereus's stated cadre-node capability of filtering which strands a node participates in. The documented `sAppId`/`strandId` filtering modes are effectively unreachable through the env-driven container/systemd deployment path without hand-editing a config file, and the failure mode is silent: an attempted but malformed filter degrades to `all` with no error or warning.

Expected behavior: object-valued strand filters should be settable through the environment (for example, by accepting a JSON value for `CADRE_STRAND_FILTER` and parsing it into the `sAppId`/`strandId` object form), or the env-only path should be explicitly documented as not supporting `sAppId`/`strandId` filtering (which requires a config file). At a minimum, an unrecognized strand-filter value must fail loudly rather than silently defaulting to `mode: 'all'`, so a misconfigured container does not silently over-subscribe to strands.

Key references: `packages/cadre-cli/src/config/types.ts`, `packages/cadre-cli/src/config/loader.ts`, `packages/cadre-cli/docker/entrypoint.sh`.
