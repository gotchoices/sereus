description: Make the node's configuration file strictly checked at startup, so a misspelled, retired, or wrongly-typed setting stops the node with an error naming the setting and the file, instead of being silently ignored.
architecture: packages/cadre-cli/README.md#configuration
files: packages/cadre-cli/src/config/loader.ts, packages/cadre-cli/src/config/types.ts, packages/cadre-cli/src/config/schema.ts (new), packages/cadre-cli/src/config/index.ts, packages/cadre-cli/src/commands/status.ts, packages/cadre-cli/src/commands/node-session.ts, packages/cadre-cli/src/commands/start.ts, packages/cadre-cli/example.cadre.yaml, packages/cadre-cli/README.md, packages/cadre-cli/test/identity-key.spec.ts, packages/cadre-cli/test/entrypoint.spec.ts, packages/cadre-host/src/orchestrator/host-process-orchestrator.ts, packages/integration-tests/src/harness/provider-process-orchestrator.ts
difficulty: hard
----

# Strict validation of the cadre-cli config file

## Decision (settled)

Maintainer decision 2026-09-28: **strict**. An unknown key or an ill-typed value fails start with an error naming the key and the file. No warn-only mode, no escape-hatch namespace.

Mechanism: a hand-written validator in cadre-cli, no schema library. The repo has no schema library as a direct dependency anywhere, and its existing request validators (cadre-host `provision-request-validation.ts`, cadre-provider `create-request-validation.ts`) are hand-written. Drift between the TypeScript type and the validator is closed at compile time instead (see *Field tables* below), which is the property a schema library would have bought.

Environment-variable *names* (unknown or retired `CADRE_*` variables) are the follow-up ticket `cli-env-strict-names`. This ticket validates the *values* that environment overrides write, because those land in the same tree.

## Today

`loadConfigFile` (`config/loader.ts`) returns `yaml.load(content) as CliConfigFile` — a cast, no check. `applyEnvironmentOverrides` writes `CADRE_*` values into that object at dotted paths. `resolveConfig` then checks only three things: the `identity` block (allowlist of one key plus a pointed message for two retired names — `validateIdentityBlock`), the push block (`validatePushCredentials` from cadre-core), and the strand filter (`parseStrandFilter`). Everything else is trusted. Examples of what passes silently today:

- `network: { listenAddr: [...] }` — never read; node listens on defaults.
- `storage: { type: fs }` — `resolveStorageConfig` (`commands/node-session.ts`) falls through its `if`s and returns `undefined`: the node runs with no storage configured.
- `hibernation: { enabled: "yes" }` — truthy string reaches cadre-core as if it were `true`.
- `storage: file` (a scalar where a block belongs) plus `CADRE_STORAGE_PATH` — `cloneBranch` replaces the scalar with `{}` without a word.

## Design

### One validation pass, after environment overrides

```
raw = loadConfigFile(path)            // parse only; returns unknown
{ tree, provenance } = applyEnvironmentOverrides(raw, env)
config: CliConfig = validateConfig(tree, provenance, path)   // throws listing every problem
```

Validation runs once, on the merged tree. Two reasons it must be after the merge rather than on the file alone:

- Required fields are supplied by the environment in real deployments: the integration harness's `cadre.json` (`ensureConfigFile` in `provider-process-orchestrator.ts`) has no `controlNetwork` or `profile` — `CADRE_PARTY_ID` / `CADRE_PROFILE` supply them.
- `identity-key.spec.ts` pins "lets CADRE_KEY_FILE rescue a config whose keyFile has no value": an environment value replacing a bad file value is accepted behaviour.

**Provenance.** `applyEnvironmentOverrides` returns, alongside the tree, the map of dotted paths it wrote → the variable that wrote them (e.g. `network.listenAddrs → CADRE_LISTEN_ADDRS`, `push → CADRE_PUSH`). A problem at key path `P` is attributed to the variable whose written path is the longest prefix of `P`; with none, to the file. So:

```
Config /etc/cadre/cadre.yaml: unknown key network.listenAddr (did you mean 'listenAddrs'?)
Environment variable CADRE_PUSH: push.apns.production must be a boolean, got "yes"
```

`applyEnvironmentOverrides` should take `env: NodeJS.ProcessEnv = process.env` as a parameter so tests do not mutate `process.env`; the whole pipeline (`loadValidatedConfig`, below) takes it through.

**`cloneBranch` must not discard a scalar.** When an override descends through a path whose existing value is neither absent, `null`, nor a plain object (e.g. file `storage: file`, variable `CADRE_STORAGE_PATH`), throw, naming the file key and the variable, instead of replacing it with `{}`.

### Rules

- **Unknown key** at any object level → error naming the full dotted key path and the file. Suggest the nearest accepted key at that level when one matches case-insensitively or within edit distance 2 (`listenAddr` → `listenAddrs`, `keyfile` → `keyFile`).
- **Retired key** → error naming its replacement. Each object's field table may carry a `retired` map (key → message). The identity block's `RETIRED_IDENTITY_KEYS` (`protobufKeyFile`, `privateKeyHex`) moves into it with its messages unchanged, and `validateIdentityBlock` / `rejectUnknownIdentityKeys` / `rejectUnusableKeyFile` are deleted — the general mechanism covers them. Keep the transitional `NOTE:` on the retired map.
- **Ill-typed value** → error naming the key, the expected type, and the value received (`JSON.stringify`, except push `privateKey` fields, which are secrets and must never appear in a message — say "a non-string" / the type instead).
- **`null`.** An object-typed key whose value is `null` counts as absent: YAML `network:` with every child commented out parses to `null`, and the Docker entrypoint emits exactly that when no address variables are set. A `null` leaf is ill-typed. `identity.keyFile:` (null) with no rescuing `CADRE_KEY_FILE` must still fail with a message that says what `rejectUnusableKeyFile`'s says today — leaving it empty would start the node under a new peer id; remove the block to run without a stable one. An empty or whitespace-only `keyFile` string fails the same way.
- **Root.** A file that parses to `null`/`undefined` (empty file) is an empty mapping; a root that is a scalar or an array is an error.
- **Required** (checked on the merged tree; the message names the environment variable that could supply it, found by reverse lookup in `ENV_MAPPINGS`): `controlNetwork`, `controlNetwork.partyId`, `controlNetwork.bootstrapNodes`, `profile`; `storage.type` when `storage` is present; `hibernation.enabled` when `hibernation` is present; `storage.path` when `storage.type` is `file` (cross-field; today only `resolveStorageConfig` catches it, without naming the file — leave that check in place, the validator reaches it first).
- **Report every problem**, one per line in a single thrown `Error`, rather than stopping at the first — an operator fixing a hand-edited file should not have to restart once per typo.

### Field types

The validator owns *shape*: which keys exist, their JSON types, enums, integer-ness, non-emptiness of identifiers and paths. Range checks that already fail loudly downstream stay where they are and are not duplicated (multiaddr syntax and listen-address transport support in cadre-core; `cohortQueryTimeoutMs` / `linkRoundTripMs` > 0 in cadre-core; push credential completeness in `validatePushCredentials`).

| Key | Accepts |
|---|---|
| `identity.keyFile` | non-empty (after trim) string |
| `controlNetwork.partyId` | non-empty string |
| `controlNetwork.bootstrapNodes` | array of non-empty strings (may be empty — cadre-host's owner node writes `[]`) |
| `profile` | `'transaction'` \| `'storage'` |
| `strandFilter` | whatever `parseStrandFilter` accepts — call it, wrap its message with the source |
| `storage.type` | `'memory'` \| `'file'` |
| `storage.path` | non-empty string |
| `storage.quotaBytes` | non-negative safe integer |
| `network.listenAddrs`, `announceAddrs`, `appendAnnounceAddrs`, `relayAddrs` | array of strings |
| `network.enableRelay` | boolean |
| `network.unauthorizedRelayReservationCap` | non-negative safe integer (0 is meaningful: refuse every unauthorized reservation) |
| `network.cohortQueryTimeoutMs`, `network.linkRoundTripMs` | finite number |
| `hibernation.enabled` | boolean |
| `hibernation.defaultLatencyHint` | `'realtime'` \| `'interactive'` \| `'background'` \| `'archive'` |
| `strandWatchInterval` | finite number > 0 |
| `nodeState.dir` | non-empty string |
| `push.fcm` | object: `projectId`, `clientEmail`, `privateKey` — strings |
| `push.apns` | object: `keyId`, `teamId`, `bundleId`, `privateKey` — strings; `production` — boolean |
| `push.cooldownMs`, `push.debounceMs` | finite number ≥ 0 |

Push sub-fields are type-checked only; their presence stays with `validatePushCredentials` (the shared cadre-core validator host and provider also use), which `resolveConfig` keeps calling.

### Field tables (compile-time drift guard)

New module `config/schema.ts`. Each object level is a table from key to a checker, typed so the compiler rejects a table that misses a field of the TypeScript type or names one it lacks:

```ts
/** Checks one value at `keyPath`; records problems on `ctx` and returns undefined when it fails. */
type Checker<T> = (value: unknown, keyPath: string, ctx: ValidationContext) => T | undefined;

/** One checker per key of T — adding a field to the type without a checker is a compile error. */
type FieldTable<T> = { [K in keyof Required<T>]-?: Checker<NonNullable<T[K]>> };

function objectOf<T>(fields: FieldTable<T>, opts?: {
  required?: readonly (keyof T)[];
  retired?: ReadonlyMap<string, string>;
}): Checker<T>;
```

The table is written as an object literal annotated with (or `satisfies`) `FieldTable<X>`, so excess-property checking catches a checker for a key the type does not have. The accepted-key set at runtime is `Object.keys(table)` — one source for both "unknown key" and the typo suggestion. Push tables are typed against cadre-core's `FcmCredentials` / `ApnsCredentials` / `PushCredentials`, so a field cadre-core adds becomes a compile error here rather than a runtime rejection of configs cadre-host starts writing.

Leaf checkers (`string`, `nonEmptyString`, `boolean`, `finiteNumber`, `nonNegativeInteger`, `oneOf(...)`, `arrayOf(...)`) are small single-purpose functions. No generic JSON-Schema interpreter.

### Types

In `config/types.ts`:

- `CliConfig` — the validated, complete shape (today's `CliConfigFile` contents: `controlNetwork` and `profile` required, `storage.type` and `hibernation.enabled` required within their blocks). This is what `validateConfig` returns.
- `CliConfigFile` — what a file may contain on its own: `CliConfigFile = DeepPartial<CliConfig>` with a local `DeepPartial` that recurses into plain objects only (not arrays). Writers that produce a partial file type against this.
- `ResolvedConfig` — derive from `CliConfig` (`Omit<CliConfig, 'identity' | 'nodeState' | 'strandFilter'> & { privateKey?; nodeStateDir; strandFilter: StrandFilter }`) instead of re-declaring the `network` / `storage` / `hibernation` blocks a second time. Keep the field doc comments on `CliConfig` (they are the operator-facing documentation of each key).

### Loader surface

- `loadConfigFile(path): Promise<unknown>` — parse only.
- `loadValidatedConfig(path, env = process.env): Promise<CliConfig>` — load, override, validate. New export.
- `resolveConfig(path, env = process.env)` — `loadValidatedConfig`, then `validateResolvedPush`, identity key load, `nodeStateDir`, `parseStrandFilter` (its result, not a second validation).
- `commands/status.ts` switches from `loadConfigFile` to `loadValidatedConfig`. It already catches, warns, and skips the summary on error, so an invalid file shows the validation message in that warning. It no longer needs to guard `controlNetwork` being absent — the type says it is present.

### Config writers typed against the schema

The repo's own generated configs must keep validating; make that a compile-time fact where the writer is TypeScript:

- cadre-host `buildChildConfig` / `buildOwnerChildConfig` (`host-process-orchestrator.ts`) return `CliConfig` instead of `Record<string, unknown>` (cadre-host already depends on `@serfab/cadre-cli`). Check what `req.strandFilter`'s type is and narrow if needed.
- Integration harness `ensureConfigFile` builds a `CliConfigFile` (it depends on `@serfab/cadre-cli` too).

The shell writer (Docker `entrypoint.sh`) and `example.cadre.yaml` are covered by the two tests below.

## Edge cases & interactions

- **Entrypoint `network:` with no children** — parses to `null`, must count as absent. Verified by the entrypoint test below when no address variables are set (the stub harness's env decides; if it always sets `CADRE_LISTEN_ADDRS`, verify by inspection of the null rule instead).
- **Entrypoint `hibernation.enabled: ${CADRE_HIBERNATION_ENABLED:-true}`** — if the variable is `1`, YAML parses a number; the environment override replaces it with a boolean before validation, so it passes. Inspection.
- **Entrypoint `strandFilter: {"sAppId":"x"}`** — JSON flow mapping, valid YAML; goes through `parseStrandFilter`. Inspection.
- **Empty environment value** — still "unspecified" (existing `env-override-empty.spec.ts`); provenance must not record a path for a skipped variable. Existing test.
- **`cadre start --identity-file`** sets `process.env.CADRE_KEY_FILE` before `resolveConfig` (`start.ts`); with `env` now a parameter defaulting to `process.env`, confirm the default is read at call time, not captured at module load. Inspection.
- **`start --ws-port`** pushes into `config.network.listenAddrs` after resolution — unaffected, but `ResolvedConfig.network` must stay mutable (not `readonly`). Type check.
- **Push secrets in messages** — no `privateKey` value in any error string, including the typo-suggestion path. Inspection.
- **Attribution through a whole-object variable** — `CADRE_PUSH` writes `push`; a bad `push.fcm.clientEmail` type is attributed to `CADRE_PUSH`, not the file. Covered by the provenance rule; inspection.
- **cadre-provider's push block** is forwarded verbatim from the provider's own (unvalidated) config into `CADRE_PUSH`. An extra key there now makes each tenant's node refuse to start — loud, which is the decided behaviour, but late. Out of scope; filed as `backlog/debt-provider-config-file-has-no-schema-validation`.
- **Keys cadre-core supports but the CLI type does not expose** (`hibernation.customTimeouts`, `hibernation.checkInWindowMs`) — rejected as unknown. That is correct under strict; they were silently dropped before.

## Tests

Default is no new test; these pay for themselves:

- **Typo is caught, with suggestion** (the ticket's reproduction): a file with `network.listenAddr` → `loadValidatedConfig` rejects naming `network.listenAddr`, the file path, and `listenAddrs`.
- **Ill-typed value is caught**: `storage.type: fs` → rejected naming `storage.type` and the accepted values (this is the case that today yields a node with no storage).
- **Attribution to an environment variable**: file valid, `env` carries `CADRE_STORAGE_TYPE=fs` → the message names `CADRE_STORAGE_TYPE`, not the file.
- **example.cadre.yaml validates** — `loadValidatedConfig` on the shipped example with an empty `env` succeeds. Guards the ticket's "the CLI must not reject its own shipped configs" requirement.
- **Entrypoint-generated file validates** — in `entrypoint.spec.ts`'s first test, add an assertion that `loadValidatedConfig(<generated cadre.yaml>, <the env the test passed to the entrypoint>)` resolves.
- Existing identity tests (`identity-key.spec.ts` "rejects the retired identity.protobufKeyFile", "rejects a misspelled identity key", "rejects an identity block that is not an object", "accepts an empty identity block", "lets CADRE_KEY_FILE rescue...") must pass unchanged in intent; adjust only the expected message text where the general mechanism words it differently, keeping the retired-key messages verbatim.

No per-field type tests — the field table is compile-checked and the checkers are one-liners.

## TODO

- Add `config/schema.ts`: `ValidationContext` (collects problems with key paths), leaf checkers, `objectOf` with unknown-key rejection, nearest-key suggestion, `retired` map, `required` list, and the `null`-object rule.
- Restructure `config/types.ts`: `CliConfig`, `CliConfigFile = DeepPartial<CliConfig>`, `ResolvedConfig` derived from `CliConfig`.
- Write the field tables for every block, typed against `CliConfig` and cadre-core's push credential types; fold the identity retired-key map in; delete `validateIdentityBlock` and its helpers.
- `applyEnvironmentOverrides(raw, env)`: return `{ tree, provenance }`; make `cloneBranch` throw on a scalar or array in the way.
- `validateConfig(tree, provenance, configPath)`: run the root table, attribute each problem to file or variable, throw one `Error` listing all.
- Add `loadValidatedConfig`; make `loadConfigFile` return `unknown`; route `resolveConfig` and `status.ts` through it.
- Type cadre-host's `buildChildConfig` / `buildOwnerChildConfig` as returning `CliConfig`, and the integration harness's `ensureConfigFile` as `CliConfigFile`.
- Tests listed above; update `identity-key.spec.ts` message expectations only as needed.
- Update the `identity` comment in `example.cadre.yaml` (it says the identity block alone rejects unknown keys) and add a one-paragraph note to `packages/cadre-cli/README.md` → Configuration: every key is checked at start, an unknown / retired / ill-typed key fails start naming the key and its source.
- `yarn workspace @serfab/cadre-cli typecheck`, `yarn workspace @serfab/cadre-cli test`, `yarn workspace @serfab/cadre-host typecheck`, `yarn workspace @serfab/cadre-host test`, `yarn lint`.
