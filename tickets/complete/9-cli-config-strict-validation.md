description: The node's configuration file is now strictly checked at startup — a misspelled, retired, or wrongly-typed setting stops the node with an error naming the setting and its source (file or environment variable), instead of being silently ignored. Implemented and reviewed.
architecture: packages/cadre-cli/README.md#configuration
files: packages/cadre-cli/src/config/schema.ts, packages/cadre-cli/src/config/strand-filter.ts, packages/cadre-cli/src/config/loader.ts, packages/cadre-cli/src/config/types.ts, packages/cadre-cli/src/config/index.ts, packages/cadre-cli/src/commands/status.ts, packages/cadre-cli/test/config-validation.spec.ts, packages/cadre-cli/test/strand-filter.spec.ts, packages/cadre-cli/test/entrypoint.spec.ts, packages/cadre-cli/example.cadre.yaml, packages/cadre-cli/README.md, packages/cadre-host/src/orchestrator/host-process-orchestrator.ts, packages/integration-tests/src/harness/provider-process-orchestrator.ts
----

# Strict validation of the cadre-cli config file — complete

## What landed

Implementation is `ticket(implement): cli-config-strict-validation`; the review pass is the commit that lands this ticket.

The config pipeline is `loadConfigFile` (parse only) → `applyEnvironmentOverrides(raw, env)` (merged tree plus a record of which variable wrote which key) → `validateConfig(tree, provenance, configPath)` (a complete `CliConfig`, or one `Error` listing every problem). `loadValidatedConfig` runs the three; `resolveConfig` and `cadre status` go through it.

`config/schema.ts` holds the mechanism: hand-written checkers, one `FieldTable<T>` per object level typed against the config type (and cadre-core's push credential types), so a key added to a type without a checker, or a checker for a key the type lacks, fails to compile. Unknown keys get a nearest-key suggestion, retired keys their pointed message, `null` under an object-typed key counts as absent (YAML `network:` with no children), a `null` leaf is ill-typed. Each problem is attributed to the environment variable whose written path is the longest prefix of the offending key, else to the file.

`CliConfig` is the validated shape, `CliConfigFile = DeepPartial<CliConfig>` is what a file may contain alone, `ResolvedConfig` derives from `CliConfig`. cadre-host's child config builders return `CliConfig`; the integration harness writes a `CliConfigFile`.

## Review findings

**Read first, then compared to the handoff:** the full implement diff, `schema.ts` top to bottom, `loader.ts`, `strand-filter.ts`, `types.ts`, both orchestrator writers, the Docker entrypoint, README and example config, and every changed test.

**Behaviour checked by running the built package** (a probe script against `dist`, not committed): the three shipped configs (`example.cadre.yaml`, reference-app-rn's `drone.cadre.yaml` and `test-fixture/drone.fixture.yaml`) all validate with an empty environment; an empty file filled entirely from variables; a file missing everything (reports all three required keys, each naming its variable); root that is a list; `controlNetwork:` with no children (reported through its required children); identity typo, retired key, `keyFile:` with no value, the same rescued by `CADRE_KEY_FILE`, identity as a scalar; `storage: file` plus `CADRE_STORAGE_PATH` (refused, naming key and variable); file storage with no path, and with the path from the environment; a bad `CADRE_STORAGE_TYPE` attributed to the variable; bad types and an unknown key inside `CADRE_PUSH` attributed to that variable, with `privateKey` described by kind only; `hibernation: {}`, `hibernation: null`, `network: null`, `listenAddrs: null`; an empty bootstrap entry; a fractional quota; a YAML date; two independent problems in one message; root-level typo with and without a near match. All matched the design. The two-problem file was also run through `dist/bin/cadre.js strand list -c`, which prints both lines and exits 1.

**Found and fixed in this pass (minor):**

- `parseStrandFilter` accepted an object with keys beside the discriminant (`{ sAppId: "x", sappid: "y" }`) and dropped the extra key silently — exactly the class this ticket closes, at the one key the schema delegates. It also accepted `null` as "all" while the schema special-cased `null` to reject it, so two sites encoded opposite rules. Fixed at the single parse point: an object must carry exactly one key, and only `undefined` (key absent) means `all`. The schema's special case is gone; `strand-filter.spec.ts` gained one assertion for each (the extra-key case is the defect, the `null` case pins the now-single rule).
- `describeValue` echoed a rejected string in full. A pasted file's contents in a wrong place would have been echoed whole. Strings are now cut at 120 characters with the total length appended.
- The follow-up ticket `cli-env-strict-names` named `parseStrandFilterEnv` (now `parseStrandFilterText` in `config/strand-filter.ts`) and "the nearest-key helper" without saying it is module-private. Its text and `files:` were updated so the next agent does not re-discover this.

**Decided, kept as implemented:** a required block that is absent is reported through its own required children (`controlNetwork.partyId is required (or set CADRE_PARTY_ID)`) rather than as `controlNetwork is required`. It goes slightly beyond the ticket text, but it is what makes the "names the variable that could supply it" rule reach `controlNetwork`, and the probe output reads better for it. `strandFilter:` with no value stays rejected — it is an empty leaf like `keyFile:` with no value, and no launcher writes one.

**Considered, not filed:**

- `hibernation.customTimeouts` and `hibernation.checkInWindowMs` are cadre-core settings the CLI type never exposed; they are now rejected as unknown. They never did anything from a config file, so no deployment can have relied on them. Exposing them is a feature question with no anchor in this ticket.
- cadre-host now converts a text `strandFilter` at provision time, where an empty string is refused, while cadre-provider's container environment treats an empty string as unset. Nothing in cadre-host populates that field today, so the path is unreachable. Recorded as a `NOTE:` tripwire at the site in `host-process-orchestrator.ts`.
- The typo suggestion can name a key that is also present in the same block (`listenAddr` beside `listenAddrs`). Harmless and rare.
- `DeepPartial` makes `CliConfigFile.strandFilter` accept `{}` at the type level. The validator rejects it at runtime; tightening the type is not worth a special case.
- One adjusted test in `env-override-empty.spec.ts` added a `storage.path` that the overridden `memory` type does not require. Harmless.

**Tests:** none cut. Each of the five new tests in `config-validation.spec.ts` pins a distinct contract (typo with suggestion and file attribution, a closed value set, attribution to a variable, every problem in one run, the shipped example validating), and the entrypoint test now validates the file the real `entrypoint.sh` writes. The per-field checkers are one-liners guarded by the compile-time field tables, so they have no tests, which is right.

**Docs:** `README.md` → Configuration and `example.cadre.yaml` describe the strict check; the identity comment no longer claims the identity block alone rejects unknown keys. `docs/architecture.md` still describes the environment being re-applied over the loaded config, which remains true. No other doc describes the config loader.

**Tripwires:** one new `NOTE:` in `host-process-orchestrator.ts` (empty-string strand filter, above). The pre-existing `NOTE:` at `describeValue` (a secret pasted where a mapping belongs is echoed by the "must be a mapping" message; revisit if push blocks become hand-written) stands.

**Pre-existing failures:** none seen.

**Source hygiene:** `schema.ts` is 490 lines, the whole mechanism plus every field table in one place; comments state constraints and reasons, not the statements. Left whole.

## Validation run

| Command | Result |
|---|---|
| `yarn workspace @serfab/cadre-cli typecheck` | ok |
| `yarn workspace @serfab/cadre-cli build` | ok |
| `yarn workspace @serfab/cadre-cli test` | 18 files, 250 tests passed |
| `yarn workspace @serfab/cadre-host typecheck` | ok |
| `yarn typecheck` in `packages/integration-tests` | ok |
| `yarn lint` | ok |
| `yarn workspace @serfab/cadre-host test` | 69 files, 663 passed, 4 skipped (pre-existing `skipIf` on win32 / missing dist) |

Not run: the integration-tests suite (real network, long); its only change is a type annotation, covered by its typecheck.

Logs: `tickets/.logs/9-cli-config-strict-validation.review.cli.log`, `.review.host.log`.
