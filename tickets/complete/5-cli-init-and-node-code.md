description: Reviewed PR #36: `cadre init` sets up a node folder that waits to be claimed by the owner's phone, `cadre start` reads the claim secret from a file the config names, `cadre code` prints the code the phone scans, and `cadre --version` reads package.json.
architecture: docs/architecture.md, packages/cadre-cli/README.md#waiting-to-be-claimed
files: packages/cadre-cli/src/commands/init.ts, packages/cadre-cli/src/commands/code.ts, packages/cadre-cli/src/commands/private-file.ts, packages/cadre-cli/src/commands/claim-secret.ts, packages/cadre-cli/src/commands/start.ts, packages/cadre-cli/src/config/loader.ts, packages/cadre-cli/src/config/schema.ts, packages/cadre-cli/src/config/types.ts, packages/cadre-cli/test/init.spec.ts, packages/cadre-cli/test/code.spec.ts, packages/cadre-cli/README.md, docs/architecture.md
----
# `cadre init` + `cadre code` (PR #36)

External PR, merged locally as `Merge PR #36: cadre-cli `cadre init` and `cadre code` for nodes claimed by a phone`, with the merge-time follow-up `fix(cadre-cli): private temp dir for `cadre code --open`; POSIX log paths in launchd plists`. Address selection in `code.ts` was later replaced by PR #37 (cadre-core's `selectNodeClaimAddresses`) and is reviewed there.

## What landed

- **`cadre init`** writes `cadre-peer.key` and `claim.secret` (mode 600), `cadre-peer.id`, `cadre.yaml` (placeholder party `unclaimed`, TCP 4001 + WebSocket 4002 listeners, `--public` entries as `appendAnnounceAddrs`, `nodeState.dir`, `storage.path`, `claim.secretFile`) and empty `state/` and `data/`. It refuses, writing nothing, when any of the four files exists, and adds `start`/`code` scripts to a `package.json` in the folder without replacing existing ones.
- **`claim.secretFile`** (env `CADRE_CLAIM_SECRET_FILE`): `resolveClaimSecret` refuses both sources at once and a missing or invalid file without echoing it, and warns on POSIX when other accounts can read the file. `resolveConfig` moves it out of the node-facing config into `claimSecretFile`.
- **`cadre code`** reads `/status`, refuses unless `claim === 'awaiting'`, prints the `sereus-join:1.…` code on stdout, with `--qr`, `--png`/`--svg`, `--open`, `--link`.
- **`cadre --version`** from `package.json` (GitHub issue #35).

## Review findings

**Checked, no change needed**

- Claim secret end to end: never in a log line, an error message (file read and parse errors name the path only; `parseClaimSecret`'s messages never echo the value), the process list (env or file only, `cadre service` units carry neither), or `/status` (only `secretConfigured`). `resolveConfig` strips `claim` from the node-facing config; `CadreNodeConfig.claim` is still built only by `claimConfigFor` from the resolved secret. A file secret runs `refuseClaimConflicts` right after the config loads, naming the file; a claim on record runs it again with the record as subject, whichever source the secret came from, so the file and environment secrets interact with `claim.json` the same way. An environment secret is validated by the node and, for `cadre code`, by `encodeNodeClaimPayload`.
- Strict config check: the `claim` block is cadre-cli's own `schema.ts`; cadre-provider has its own schema and cadre-host only uses the `CliConfig` type to write child configs, where the new optional field changes nothing. cadre-host children still get their secret only through `CADRE_CLAIM_SECRET`.
- `--version`: `createRequire('../../package.json')` resolves to the package root from both `dist/bin` and `src/bin`; smoke-run prints `1.14.0`.
- `cadre code`'s health-port precedence (env beats flag) matches `cadre start`; not changed.

**Found and fixed in this pass**

- `--png`/`--svg` images were written with the default mode and chmodded afterwards, leaving a window where the QR code (which carries the secret) was readable by other accounts. Both now go through a new shared `writePrivateFile` (`private-file.ts`: open mode 600, `fchmod` before any data, so a pre-existing file is narrowed too); the PNG is built with `QRCode.toBuffer`. `init.ts`'s local `writePrivate` is replaced by the same helper.
- `addPackageScripts` swallowed an unparsable `package.json` silently. It now returns the parse error as `InitResult.packageJsonSkipped`, and `cadre init` prints a warning.
- `--public node.example.com/join` passed the host pattern and produced a `/dns4/node.example.com/join/tcp/…` address that was never validated. The host pattern now excludes `/`, so it is refused with the usual "must be host, host:port…" message (one assertion added to the existing `publicMultiaddr` test).
- `cadre init` with no `--public` told the operator to "re-run with --public", which init then refuses because the files exist. It now points at `network.appendAnnounceAddrs` in the config.
- Docs: the README's "Waiting to be claimed" said a node waits only when started with `CADRE_CLAIM_SECRET` and that the secret is never printed. It now names `claim.secretFile` / `cadre init` first, points to `cadre code`, labels the env example as the by-hand path, and says only `cadre code` prints the secret (inside the code). `docs/architecture.md` (claim-secret entry and the reachability table row) now names `claim.secretFile`, `cadre init` and `cadre code` beside `CADRE_CLAIM_SECRET`. `docs/cadre-host.md` was left alone: it describes the host's own join flow, which still uses only the environment secret.

**Tests**

- Cut `init.spec.ts` "omits appendAnnounceAddrs without --public": it restated a conditional spread.
- Kept the rest: they pin `--public` parsing, init's refuse-to-overwrite and file modes, the resolved config's `claimSecretFile`, secret-source resolution and its non-echo, and `openerFor`'s display rule.
- No test added for `writePrivateFile` or `packageJsonSkipped`: the mode check runs only on POSIX and the existing init test already asserts mode 600 on the key and secret through the same helper; the package.json branch is a single catch.

**Tripwire**

- `cadre code` reads the secret from its own shell's sources, not from the running node, so a node started with a different secret gets a code it refuses. Parked as a `NOTE:` on `claimSecretFor` in `code.ts`.

**Considered and not acted on**

- `initNode` writes its files one by one, so a crash midway leaves a partial folder that the next `cadre init` refuses. The refusal names the files, and removing them is the fix; no change.
- `cadre code` and `resolveConfig` each resolve `claim.secretFile` against the working directory with their own `path.resolve`; two one-line sites with the same rule, left as is.

**Verification**

- `yarn eslint packages/cadre-cli/src packages/cadre-cli/test`: clean.
- `yarn workspace @serfab/cadre-cli build` then `yarn workspace @serfab/cadre-cli test`: 23 files, 284 passed, 1 skipped.
- Smoke: `cadre --version`; `cadre init` into a scratch folder with a broken `package.json` (warning printed, files written); `--public a.example/x` refused; `QRCode.toBuffer` returns a PNG.
