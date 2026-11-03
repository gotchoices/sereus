description: On a shared Linux machine, other user accounts could read cadre-host's data folder, which holds one-time claim codes, cadre invitations, push-service private keys and each node's copy of its cadre's data; install and start now make the folder private to the cadre-host user.
architecture: docs/cadre-host.md#security-posture
files: packages/cadre-host/src/installer/paths.ts, packages/cadre-host/src/installer/index.ts, packages/cadre-host/src/bin/host.ts, packages/cadre-host/src/installer/__tests__/installer.smoke.test.ts, packages/cadre-host/src/__tests__/cli.smoke.test.ts, packages/cadre-host/README.md, docs/cadre-host.md
repro: static
difficulty: easy
----
<!-- resume-note -->
RESUME: A prior agent run on this ticket did not complete.
  Prior run: 2026-11-03T17:53:36.786Z (agent: claude)
  Log file: C:\projects\sereus\tickets\.logs\bug-cadre-host-data-dir-readable-by-other-accounts.review.2026-11-03T17-53-36-785Z.log
Read the log to see what was done. Resume where it left off.
If the prior run hit a timeout or repeated error, be cautious not to rush into the same situation.
<!-- /resume-note -->
# Make cadre-host's data folder private to its user

## What changed

`ensurePrivateDataDir(dataDir)` in `installer/paths.ts` creates the folder and, unless `process.platform === 'win32'`, sets it to 0700. A folder at 0700 keeps other accounts out of everything below it, whoever wrote it, so no store, the orchestrator or the node child processes changed, and the existing per-file 0600 writes stay.

It is called from two places:

- `Installer.install`, step 2, in place of the data-folder `mkdirSync`. The `logsDir` `mkdirSync` stays.
- The `start` action in `bin/host.ts`, right after `readHostConfig`, on `cfg.dataDir`, before `UpdateService` or any store is built.

A failed `chmodSync` stops the command. The error reaches the existing handler (`start failed: …`) and names the path. The host does not continue with a warning, because it would then write claim secrets into a folder it knows others can read.

Docs: `docs/cadre-host.md` has a third Security posture consequence, and the paragraph naming this ticket is gone from "Where the credentials go". `packages/cadre-host/README.md` → Root requirements says the folder is 0700 and must be dedicated to cadre-host.

## Tests added

Neither spec has run. Both are `it.runIf(process.platform !== 'win32')`, this machine is Windows, WSL fails to start here (`Wsl/Service/CreateInstance/CreateVm/MountDisk/HCS/ERROR_NOT_SUPPORTED`, retried in this run), Docker is not installed, and the repo has no CI workflow. They show as skipped in the Windows run. Please run them on Linux if you can.

- `installer.smoke.test.ts`, `install narrows an existing data dir to 0700 on POSIX`: an existing folder at 0755 is 0700 after `install` with `noService`.
- `cli.smoke.test.ts`, `start narrows the data dir to 0700 on POSIX`: installs through the built CLI, sets the folder to 0755, spawns `start`, waits for the `cadre-host local UI:` line, asserts 0700, then stops the child and waits for it to exit before deleting the folder.

## Validation

- `yarn workspace @serfab/cadre-host build`: passes.
- `yarn workspace @serfab/cadre-host test` on Windows: 54 files passed, 444 tests passed, 6 skipped. The skips include the two specs above.
- `yarn lint`: exit 0.
- `tsc --noEmit -p tsconfig.json` in the package: only `TS6059` errors (test-harness files outside `rootDir`), none in this change. I did not check whether they also appear at HEAD; the package's build uses `tsconfig.build.json` and passes.
- By hand on Windows: the CLI spec's `install` flags and `start --data-dir` were run, and `start` reached the `cadre-host local UI:` line. This confirms the spec's commands and its wait line, not the mode.

The 0700 result has not been observed on any machine. To confirm on a Linux host whose home folder is 0755: run a default install, then `sudo -u <other user> cat ~<cadre-host user>/.local/share/cadre-host/hosted-nodes.json`. The read should be refused. Also check an install made before this change: after one `start`, the existing folder should be 0700.

## Known limits for the reviewer

- `start` narrows `cfg.dataDir`, not the folder resolved from `--data-dir`. As the ticket specified, this covers where the host writes. If `host.config.json` was edited by hand so the two differ, the folder holding the config is not narrowed.
- Direct-on-disk commands such as `cadre-host push` do not call the helper. They need an existing install, which has already narrowed the folder.
- A filesystem that refuses mode changes stops `install` and `start` until the admin moves the folder.
- A `--data-dir` pointing at a shared folder has that folder narrowed to 0700. This is documented and deliberately not checked.
- Windows has no equivalent: `%LocalAppData%` is per-user and a custom `--data-dir` is the admin's responsibility, as documented.
