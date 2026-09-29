description: Review the strict checking of the node's configuration file at startup — a misspelled, retired, or wrongly-typed setting now stops the node with an error naming the setting and its source (file or environment variable), instead of being silently ignored.
architecture: packages/cadre-cli/README.md#configuration
files: packages/cadre-cli/src/config/schema.ts (new), packages/cadre-cli/src/config/strand-filter.ts (new), packages/cadre-cli/src/config/loader.ts, packages/cadre-cli/src/config/types.ts, packages/cadre-cli/src/config/index.ts, packages/cadre-cli/src/commands/status.ts, packages/cadre-cli/test/config-validation.spec.ts (new), packages/cadre-cli/test/entrypoint.spec.ts, packages/cadre-cli/test/identity-key.spec.ts, packages/cadre-cli/test/env-override-empty.spec.ts, packages/cadre-cli/test/push-config.spec.ts, packages/cadre-cli/test/strand-filter.spec.ts, packages/cadre-cli/test/one-shot-node.spec.ts, packages/cadre-cli/example.cadre.yaml, packages/cadre-cli/README.md, packages/cadre-host/src/orchestrator/host-process-orchestrator.ts, packages/integration-tests/src/harness/provider-process-orchestrator.ts
difficulty: hard
----

# Strict validation of the cadre-cli config file — implemented, ready for review

## What was built

The config pipeline is now `loadConfigFile` (parse only, returns `unknown`) → `applyEnvironmentOverrides(raw, env)` (returns `{ tree, provenance }`) → `validateConfig(tree, provenance, configPath)` (returns a complete `CliConfig` or throws one `Error` listing every problem). `loadValidatedConfig(path, env = process.env)` runs the three; `resolveConfig(path, env)` runs it and then does what it did before (push completeness via cadre-core's `validatePushCredentials`, identity key load, node-state directory, strand filter parse). `cadre status` reads through `loadValidatedConfig`, so an invalid file shows its validation message in the existing warning.

**`config/schema.ts` (new).** Hand-written checkers, no schema library. `Checker<T>` returns the typed value or `undefined` after recording a problem on a `ValidationContext`. `FieldTable<T>` is one checker per key of `T`, so a key added to `CliConfig` (or to cadre-core's `FcmCredentials` / `ApnsCredentials` / `PushCredentials`) without a checker, or a checker for a key the type lacks, is a compile error. `objectOf(table, { required, retired })` rejects unknown keys with a suggestion (case-insensitive match, else within two edits), gives retired keys their pointed message, treats `null` under an object-typed key as absent (YAML `network:` with no children, which the Docker entrypoint writes), and reports a required key as missing naming the environment variable that could supply it. Closed string sets are written as `oneOf<NodeProfile>({ transaction: true, storage: true })`, so the set is checked against the union type too. Each problem is attributed to the environment variable whose written path is the longest prefix of the offending key, else to the file:

```
Config /etc/cadre/cadre.yaml: unknown key network.listenAddr (did you mean 'listenAddrs'?)
Environment variable CADRE_STORAGE_TYPE: storage.type must be one of 'memory', 'file', got "fs"
Config /etc/cadre/cadre.yaml: storage.path is required when storage.type is 'file' (or set CADRE_STORAGE_PATH)
```

**`config/strand-filter.ts` (new).** `parseStrandFilter` moved here from the loader (the schema calls it, and the loader imports the schema — keeping it in the loader would have made a cycle). `parseStrandFilterEnv` is renamed `parseStrandFilterText(value, label)`, and `strandFilterConfigFromText(text)` is the text-to-config-form conversion for writers that receive a filter as text.

**`config/types.ts`.** `CliConfig` is the validated shape (formerly `CliConfigFile`'s contents). `CliConfigFile = DeepPartial<CliConfig>` (recurses into plain objects only, arrays kept whole) is what a file may contain on its own. `ResolvedConfig` now extends `Omit<CliConfig, 'identity' | 'nodeState' | 'strandFilter'>` instead of re-declaring the node-facing blocks; `resolveConfig` carries those blocks over with a rest spread, so a key added to `CliConfig` reaches the node without being listed.

**Loader.** `cloneBranch` throws when an override must descend through a scalar or list (`storage: file` in the file plus `CADRE_STORAGE_PATH`), naming the key and the variable, instead of replacing it with `{}`. `validateIdentityBlock` and its two helpers are deleted; the identity table with its `retired` map covers them, messages unchanged. The debug log line for env overrides now redacts `CADRE_PUSH`'s value (it carried private keys into `DEBUG=cadre:*` output before — a pre-existing leak fixed in passing because the line was being rewritten).

**Writers typed against the schema.** cadre-host's `buildChildConfig` / `buildOwnerChildConfig` return `CliConfig` (type-only import from `@serfab/cadre-cli`, which cadre-host already depends on). `req.strandFilter` is `string | undefined` on the provider's request type, so it is narrowed with `strandFilterConfigFromText` — before, a JSON filter such as `{"sAppId":"x"}` arriving on a provision request would have been written into `cadre.json` as a string and rejected by the node at start; now it becomes the object form, or fails at provision time. Nothing in cadre-host sets `strandFilter` today, so this path has no scenario behind it. The integration harness's `ensureConfigFile` builds a `CliConfigFile`.

**Docs.** `example.cadre.yaml` gained a header stating every key is checked, and its identity comment no longer claims the identity block alone rejects unknown keys. README → Configuration has a paragraph on the strict check and what an error names.

## Behaviour changes a reviewer should weigh

- **`strandFilter:` with no value (`null`) is now rejected.** `parseStrandFilter(null)` still returns `all` (the `resolveConfig` path relies on `undefined`/`null` there), but the schema's leaf checker follows the ticket's "a `null` leaf is ill-typed" rule. No launcher writes an empty `strandFilter:` line.
- **Keys cadre-core supports but the CLI type never exposed** (`hibernation.customTimeouts`, `hibernation.checkInWindowMs`) are rejected as unknown. They were silently dropped before, which is the decided behaviour, but a deployment that wrote them will now fail to start.
- **A required block that is absent is reported through its required children** when it has any: a file with no `controlNetwork` reports `controlNetwork.partyId is required (or set CADRE_PARTY_ID)` and `controlNetwork.bootstrapNodes is required (or set CADRE_BOOTSTRAP_NODES)`, not `controlNetwork is required`. This goes slightly beyond the ticket text; it seemed more actionable, and it is what makes the "names the variable that could supply it" rule work for `controlNetwork`.
- **Two message wordings changed** and their tests were adjusted: an `identity` block that is a scalar now reads `identity must be a mapping of keys, got "..."` (was `Invalid identity block`), and file storage with no path reads `storage.path is required when storage.type is 'file' (or set CADRE_STORAGE_PATH)` (was `resolveStorageConfig`'s `Storage path is required for file storage type`, which is still there and still unreachable-first). Retired-key and empty-`keyFile` messages are verbatim.

## Known gaps

- **Value echo in messages.** `describeValue` shows scalar strings in full and containers by kind only; `privateKey` fields go through `secretString`, which never shows the value. A secret pasted where a mapping belongs (`push.fcm: "-----BEGIN..."`) would be echoed by the "must be a mapping" message. A `NOTE:` at `describeValue` in `schema.ts` records this with the revisit condition (push blocks becoming hand-written).
- **Leaf checkers are not exported from the package root** — only `validateConfig`, `parseStrandFilter`, `parseStrandFilterText`, `strandFilterConfigFromText`, and the types. Tests import `../src/config/index.js`; none needs the leaf checkers. The `nearestKey` helper is module-private.
- **Not run:** the integration-tests suite (real network, long) — its only change is a type annotation, verified by `yarn typecheck` in that package. The root `yarn test` was not run either; the three affected packages were checked individually (below).
- **`docs/architecture.md`** still describes `applyEnvironmentOverrides` re-applying `CADRE_KEY_FILE` over the loaded config, which remains true; no doc edit was needed there.

## For the follow-up ticket `cli-env-strict-names`

That ticket's text names `parseStrandFilterEnv` (now `parseStrandFilterText`, in `config/strand-filter.ts`) and says it will reuse "the nearest-key helper the config validator uses" (`nearestKey` in `schema.ts`, currently not exported — export it there). `rejectRetiredIdentityEnv` still exists in `loader.ts`, now taking `env`, for that ticket to delete. `ENV_MAPPINGS` is still in `types.ts`.

## Tests

Added, each with what it pins:

- `config-validation.spec.ts` "rejects a misspelled key, naming it, the file, and the key it probably meant" — the ticket's reproduction: `network.listenAddr` is named with the file path and `listenAddrs` is suggested.
- `config-validation.spec.ts` "rejects a value outside the accepted set" — `storage.type: fs`, the case that used to start a node with no storage.
- `config-validation.spec.ts` "attributes a bad value to the environment variable that wrote it" — valid file, `CADRE_STORAGE_TYPE=fs` in `env`; the message names the variable and not the file path.
- `config-validation.spec.ts` "reports every problem in one error" — two independent problems both appear in one message. Not on the ticket's list; it pins the stated one-run requirement and a refactor to early-return would break it.
- `config-validation.spec.ts` "accepts the shipped example.cadre.yaml with no environment".
- `entrypoint.spec.ts` (first test) — the `cadre.yaml` the real `entrypoint.sh` generates validates under the two variables the test started it with (`CADRE_PARTY_ID`, `CADRE_BOOTSTRAP_NODES`), which also covers `network:` written with no children parsing to `null`.

Adjusted: `env-override-empty.spec.ts`, `push-config.spec.ts`, `strand-filter.spec.ts` now pass `env` explicitly and validate the merged tree (no more `process.env` mutation or `afterEach` cleanup); `identity-key.spec.ts` one regex and one stale comment; `one-shot-node.spec.ts` the storage-path message.

## Validation run

| Command | Result |
|---|---|
| `yarn workspace @serfab/cadre-cli test` at HEAD (baseline) | 17 files, 245 tests passed |
| `yarn workspace @serfab/cadre-cli build` | ok |
| `yarn workspace @serfab/cadre-cli typecheck` | ok |
| `yarn workspace @serfab/cadre-cli test` | 18 files, 250 tests passed |
| `yarn workspace @serfab/cadre-host typecheck` | ok |
| `yarn workspace @serfab/cadre-host test` | 69 files, 663 passed, 4 skipped (pre-existing `skipIf` on win32 / missing dist) |
| `yarn typecheck` in `packages/integration-tests` | ok |
| `yarn lint` | ok |

Logs: `tickets/.logs/9-cli-config-strict-validation.baseline.log`, `.test.log`, `.host.test.log`.

## Review checklist suggestions

- Read `schema.ts` top to bottom; it is the whole mechanism. Check the `null`-as-absent rule only applies under `objectOf`-built checkers (`nullIsAbsent`), and that `refine` preserves it for `storage`.
- Try the two-problem file by hand against `dist/bin/cadre.js strand list -c <file>` if you want to see the multi-line error as an operator would.
- Confirm no `privateKey` value can reach a message: `secretString` for the four fields, containers described by kind, and the unknown-key path names keys only.
- Decide whether the "required block reported through its children" behaviour should stay.
