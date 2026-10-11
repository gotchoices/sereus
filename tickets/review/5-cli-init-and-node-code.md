description: Review PR #36 (merged locally): `cadre init` sets up a cadre-cli node folder that waits to be claimed by the owner's phone, `cadre start` reads the claim secret from a file the config names, `cadre code` prints the code the phone scans, and `cadre --version` reads package.json.
architecture: docs/architecture.md, packages/cadre-cli/README.md#waiting-to-be-claimed
files: packages/cadre-cli/src/commands/init.ts, packages/cadre-cli/src/commands/code.ts, packages/cadre-cli/src/commands/claim-secret.ts, packages/cadre-cli/src/commands/start.ts, packages/cadre-cli/src/config/loader.ts, packages/cadre-cli/src/config/schema.ts, packages/cadre-cli/src/config/types.ts, packages/cadre-cli/src/config/env.ts, packages/cadre-cli/src/bin/cadre.ts, packages/cadre-cli/src/index.ts, packages/cadre-cli/test/init.spec.ts, packages/cadre-cli/test/code.spec.ts, packages/cadre-cli/README.md, packages/cadre-cli/example.cadre.yaml, packages/cadre-cli/package.json, .release-notes.pending.md
----
# `cadre init` + `cadre code` (PR #36, kjeib)

External PR, merged locally as `Merge PR #36: cadre-cli `cadre init` and `cadre code` for nodes claimed by a phone`. It was written outside the tess pipeline, so this ticket is its review pass. Read the PR's three commits first (`git log --oneline 'Merge PR #36'^1..'Merge PR #36'^2`, or the merge's second parent), then this summary.

PR #37 (`claim-code-phone-addresses`) later replaced this PR's address selection in `code.ts` (`selectClaimAddresses`, `primaryLocalIp`) with cadre-core's `selectNodeClaimAddresses`; review the selection there, not here.

## What landed

- **`cadre init`** (`init.ts`): writes `cadre-peer.key` (mode 600), `cadre-peer.id`, `claim.secret` (32 random bytes base64url, mode 600), `cadre.yaml` (placeholder party `unclaimed`, TCP 4001 + WS 4002 listeners, `--public host[:port]|multiaddr` as `appendAnnounceAddrs`, `nodeState.dir`, `storage.path`, `claim.secretFile`), and empty `state/`, `data/`. Refuses, writing nothing, when any of the four files exists. Adds `start`/`code` scripts to a `package.json` in the folder without replacing existing ones.
- **`claim.secretFile`** (env `CADRE_CLAIM_SECRET_FILE`): `resolveClaimSecret` (`claim-secret.ts`) refuses both sources at once, refuses a missing or invalid file without echoing it, and warns (POSIX) when other accounts can read it. `resolveConfig` strips `claim` from the node-facing config into `claimSecretFile`, since `CadreNodeConfig.claim` is the claim policy. `cadre start` runs `refuseClaimConflicts` for a file-held secret after the config loads (an environment secret is still checked before).
- **`cadre code`**: reads `/status`, refuses unless `claim === 'awaiting'`, and prints `encodeNodeClaimPayload(...)` on stdout (details on stderr). Output options `--qr`, `--png`/`--svg` (chmod 600 after writing), `--open`, `--link <url>` (code in the URL fragment).
- **`cadre --version`** from `package.json` via `createRequire` (closes GitHub issue #35).
- New runtime dependency `qrcode` (already in the lockfile through cadre-host).

## Follow-up made at merge time

- `fix(cadre-cli): private temp dir for `cadre code --open`; POSIX log paths in launchd plists`: `--open` without `--png`/`--svg` wrote the QR image, which carries the claim secret, to a predictable name in the shared temp dir (`cadre-node-code-<pid>.png`). It now writes into a fresh `mkdtemp` directory.

## Review focus

- **Claim-secret handling end to end.** Confirm the secret never reaches a log line, an error message, the process list, or the node-facing config; that a file secret and a claim record on disk interact the same way the environment secret does (`claim-record.ts`, `refuseClaimConflicts`); and that `CadreNodeConfig.claim` is still built only from the secret (`claimConfigFor`).
- **`--png`/`--svg` files** are created with the default mode and chmodded to 600 afterwards. A short window where the image is world-readable; decide whether to write with `mode: 0o600` from creation (as `writePrivate` in `init.ts` does) or leave it.
- **`addPackageScripts`** silently returns on an unparsable `package.json` (empty `catch`): AGENTS.md asks for at least a log.
- **Strict config check**: the new `claim` block in `schema.ts`; confirm cadre-host and cadre-provider, which share config checking, are unaffected.
- **Tests** (`init.spec.ts`, `code.spec.ts`): cut any that restate the implementation.
- **Docs**: the README's "Waiting to be claimed" and "The node code" sections; `docs/architecture.md` and `docs/cadre-host.md` may want a pointer to the cadre-cli claim flow.

## Verification at merge

`yarn build`, `yarn lint`, `yarn workspace @serfab/cadre-cli test` (280 pass, 1 skipped), `node-claim-by-phone` integration scenario 6/6.
