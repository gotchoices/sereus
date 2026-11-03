description: On a shared Linux machine, other user accounts could read cadre-host's data folder, which holds one-time claim codes, cadre invitations, push-service private keys and each node's copy of its cadre's data; install and start now make the folder private to the cadre-host user.
architecture: docs/cadre-host.md#security-posture
files: packages/cadre-host/src/installer/paths.ts, packages/cadre-host/src/installer/index.ts, packages/cadre-host/src/bin/host.ts, packages/cadre-host/src/installer/__tests__/installer.smoke.test.ts, packages/cadre-host/src/__tests__/cli.smoke.test.ts, packages/cadre-host/README.md, docs/cadre-host.md
repro: static
difficulty: easy
----
# Make cadre-host's data folder private to its user

## What changed

`ensurePrivateDataDir(dataDir)` in `installer/paths.ts` creates the folder and, unless `process.platform === 'win32'`, sets it to 0700. `Installer.install` calls it at step 2, and the `start` action in `bin/host.ts` calls it on `cfg.dataDir` before any store is built. A failed `chmodSync` stops the command, and the error names the path. No store, the orchestrator or the node child processes changed, and the existing per-file 0600 writes stay.

`docs/cadre-host.md` → Security posture and `packages/cadre-host/README.md` → Root requirements describe the 0700 mode and that the folder must be dedicated to cadre-host.

## Not verified

**The 0700 result has not been observed on any machine.** Both specs that check it are `it.runIf(process.platform !== 'win32')` and were skipped here: this machine is Windows, WSL fails to start (`Wsl/Service/CreateInstance/CreateVm/MountDisk/HCS/ERROR_NOT_SUPPORTED`), Docker is not installed, and the repo has no CI workflow. The review checked them by reading only.

To confirm on Linux:

- Run `yarn workspace @serfab/cadre-host test`. `install narrows an existing data dir to 0700 on POSIX` and `start narrows the data dir to 0700 on POSIX` should run and pass.
- On a host whose home folder is 0755, run a default install, then `sudo -u <other user> cat ~<cadre-host user>/.local/share/cadre-host/hosted-nodes.json`. The read should be refused.
- With an install made before this change, run `start` once. The existing folder should be 0700.

## Validation

On Windows, at the end of the review:

- `yarn workspace @serfab/cadre-host build`: passes.
- `yarn workspace @serfab/cadre-host test`: 54 files passed, 444 tests passed, 6 skipped, including the two specs above. The first attempt stopped at the stale-build guard because this repo's `@serfab/cadre-core` `dist` was out of date. Rebuilding that package cleared it. This was unrelated to the ticket.
- `yarn lint`: exit 0.

## Review findings

Read the diff of `ticket(implement): bug-cadre-host-data-dir-readable-by-other-accounts` first, then the code around each call site. A first review run was interrupted, and its edits were salvaged in commit `ticket(review): bug-cadre-host-data-dir-readable-by-other-accounts (partial — salvaged from interrupted run)`. This pass checked those edits and finished the work.

**Major, sent to a person:** the management API is still open to other local accounts. A loopback listener with no credential check does not look at who connected, and the claim route returns the claim secret, so the 0700 mode does not protect a pending claim secret. Same-account requests were observed by the first run. A request from a different account is inferred and has not been tried. The docs contradicted each other on whether other accounts are a threat (Security posture against No login), so this is `decide-cadre-host-management-api-open-to-other-local-accounts` in `blocked/`, with proposed text.

**Minor, fixed:**

- `docs/cadre-host.md` → Security posture said other accounts are "outside the trust boundary", which the API contradicts. It now says they cannot read the data directory, and has a labelled paragraph saying the API is not covered.
- The same item said the folder holds push private keys without qualification. Those keys are in the OS keychain, and reach the folder only through the fallback file, so the item now says so.
- `packages/cadre-host/README.md` called the trust boundary "same machine, same user" for the UI. It now says any account on the machine can reach it.
- The header comment of `cli.smoke.test.ts` described only the help output. It now covers `start`.
- The blocked ticket said the docs describe a family machine with several accounts. They describe only a VPS, so the ticket now says that.

**Checked, nothing to change:**

- Ordering: `install` narrows before writing the config, and `start` narrows before the first store, inside the `try` whose handler prints `start failed: …`. `install` has the same kind of handler.
- Direct-on-disk commands (`cadre-host push`, through `resolveHostPaths`) exit if `host.config.json` is missing, so they cannot create an unprotected folder.
- Files outside the folder: no non-test source under `packages/cadre-host/src` uses a temp directory, and the service-unit generators set no environment holding secrets.
- CLI spec: it installs on the default UI port, which looked like a collision risk on a machine already running cadre-host, but the server tries the next 9 ports on `EADDRINUSE`. Its 30-second timeout is set for the whole file, and it stops the child before deleting the folder.
- Tests: both specs stay. They are the reproduction of this bug, and each covers a different call site. No test was added or cut.
- Lint and source hygiene: no comments narrate statements, and `paths.ts` doing one filesystem call is acceptable next to its path helpers.

**Conditional, not ticketed or parked:**

- `start` narrows `cfg.dataDir`, not the folder from `--data-dir`, so a hand-edited config could leave the folder holding the config unnarrowed. `host.config.json` holds no private keys by its type's documentation, and every store follows `cfg.dataDir`, so nothing secret is exposed. Considered and left as is, with no `NOTE:` because no action would follow.
- A filesystem that refuses mode changes stops `install` and `start`, and a `--data-dir` pointing at a shared folder has that folder narrowed. Both are documented behaviour in Security posture; the first is the deliberate failure mode.

**Other categories:**

- Performance and resource cleanup: one `mkdir` and one `chmod` per command, with no resources held, so there is nothing to find.
- Type safety: the change adds one `(dataDir: string): void` function, with no casts.
- Windows: no protection is added, by design. `%LocalAppData%` is per-user, and a custom `--data-dir` is the admin's responsibility, as documented.
