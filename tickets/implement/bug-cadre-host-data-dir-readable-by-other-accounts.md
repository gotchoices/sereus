description: On a shared Linux machine, other user accounts may be able to read cadre-host's data folder, which holds the one-time codes for nodes waiting to be claimed, pasted cadre invitations, push-service private keys and each node's copy of its cadre's data; the folder should be readable by the cadre-host user alone.
architecture: docs/cadre-host.md#security-posture
files: packages/cadre-host/src/installer/paths.ts, packages/cadre-host/src/installer/index.ts, packages/cadre-host/src/bin/host.ts, packages/cadre-host/src/installer/__tests__/installer.smoke.test.ts, packages/cadre-host/src/__tests__/cli.smoke.test.ts, packages/cadre-host/README.md, docs/cadre-host.md
repro: static
difficulty: easy
----
# Make cadre-host's data folder private to its user

## Cause

Nothing sets the data folder's mode. `Installer.install` (`installer/index.ts`, step 2) and every store's constructor call `mkdirSync(…, { recursive: true })` with no mode, so with a umask of 022 the folder is 0755. Inside it, only `identity.key` and `nat-secrets.json` are 0600. `hosted-nodes.json` (claim secrets and invitations), each node's `cadre.json` (push private keys) and each node's `storage/` take the default mode, so another account can read them whenever the folders above allow it.

The fix belongs at the folder, not at each file. A folder at 0700 blocks other accounts from everything below it, however it was written, including what the node child processes write. So `hosted-node-store.ts`, `host-process-orchestrator.ts`, the other stores and the child need no change, and the per-file 0600 writes stay.

## Evidence

Read from the code, not observed. A mode test needs POSIX mode bits, this development machine is Windows, and WSL does not start on it (`Wsl/Service/CreateInstance/CreateVm/MountDisk/HCS/ERROR_NOT_SUPPORTED`).

To confirm on a Linux host whose home folder is 0755, run a default install, then `sudo -u <other user> cat ~<cadre-host user>/.local/share/cadre-host/hosted-nodes.json`. The read succeeds before the fix and is refused after it.

## Design

One helper, `ensurePrivateDataDir(dataDir: string): void`, in `installer/paths.ts`. It runs `mkdirSync(dataDir, { recursive: true })`, then `chmodSync(dataDir, 0o700)` unless `process.platform === 'win32'`, the same guard `identity-file.ts` uses.

- **Why `chmodSync` is needed.** A mode passed to `mkdirSync` is ignored when the folder already exists and is reduced by the umask when it does not. An existing install is only narrowed by `chmodSync`.
- **The gap between the two calls is harmless.** Nothing has been written into the folder at that point, because the helper runs before any store is built.
- **The platform check uses `process.platform`, not the installer's injected `platform`.** The mode is a property of the real filesystem, and specs construct `new Installer({ platform: 'linux' })` on Windows.

Call sites:

- **`Installer.install`:** replaces `mkdirSync(answers.dataDir, …)` in step 2, before the logs folder and the config are written. A repeat install on an existing folder is narrowed the same way.
- **`cadre-host start` (`bin/host.ts`):** immediately after `readHostConfig(cfgPath)`, before `UpdateService` or any store is built, on `cfg.dataDir`. Use `cfg.dataDir`, not the resolved `dataDir`: it is where the host writes, and the two differ if `host.config.json` was edited by hand.

The `cadre-host push` commands and other direct-on-disk commands are not call sites. They refuse to run without an install, which has already narrowed the folder.

**A failed `chmodSync` stops the command.** It fails when the folder belongs to another account, or on a filesystem that refuses mode changes. The error propagates to the existing handlers (`start failed: EPERM … chmod '<path>'`), which name the path. A logged warning would not do: the host would then write a claim secret into a folder it knows other accounts can read, and a service's logs are rarely read. The cost is that a host on such a volume cannot start until the admin moves the folder.

**The data folder must be dedicated to cadre-host.** A `--data-dir` pointing at a shared folder would have that folder narrowed to 0700. `uninstall --remove-data` already treats the folder as cadre-host's alone and deletes it, so this is not a new assumption. It needs saying in the docs. Do not add a check that refuses particular paths.

Nothing else reads the folder as another account. The systemd unit and launchd agent are per-user and run as the installing user (`service/README.md`), and `--system` is refused.

Windows has no mode bits. `%LocalAppData%` is per-user, and a custom `--data-dir` there is the admin's responsibility, which the docs must say.

## Tests

Two specs, one per path, each `it.runIf(process.platform !== 'win32')` as in `node-identity.test.ts`. Each starts from a folder set to 0755, so it fails without the narrowing, and asserts `statSync(dir).mode & 0o777` is `0o700`.

- **Install path:** in `installer.smoke.test.ts`, `chmodSync(tmp, 0o755)`, then `install` with `noService: true`. `tmp` already exists there, so this is the case the `chmodSync` is for.
- **Start path:** in `cli.smoke.test.ts`, run the built CLI's `install --non-interactive --no-service --no-upnp --no-browser --data-dir <tmp>`, `chmodSync(tmp, 0o755)`, then spawn `start --data-dir <tmp>`, wait for the stdout line `cadre-host local UI:` (`bin/host.ts`), assert the mode, and stop the child. No port handling is needed: `start` moves to the next free port if the configured one is taken (`docs/reference-app-rn.md`).

The repo has no CI workflow and these specs skip on Windows, so they do not run on this development machine. Say so in the review handoff, and run them on a Linux machine if one is available. Do not report them as passing from a Windows run.

## TODO

- Add `ensurePrivateDataDir` to `packages/cadre-host/src/installer/paths.ts` with a one-line comment stating the invariant
- Call it from `Installer.install` in place of the data-folder `mkdirSync`, keeping the `logsDir` `mkdirSync`
- Call it from the `start` action in `packages/cadre-host/src/bin/host.ts` on `cfg.dataDir`, right after `readHostConfig`
- Add the install-path and start-path specs described above
- In `docs/cadre-host.md` → Security posture, add a third numbered consequence: other local accounts are outside the trust boundary on POSIX because `install` and `start` set the data folder to 0700 and refuse to continue if they cannot; the folder must be dedicated to cadre-host; on Windows the protection is `%LocalAppData%` being per-user, and a custom `--data-dir` is the admin's responsibility
- In `docs/cadre-host.md` → Where the credentials go, delete the paragraph that names this ticket (`hosted-nodes.json` is written with the process's default file mode…)
- In `packages/cadre-host/README.md` → Root requirements (the paragraph on where the data dir lives), say in one sentence that the data dir is set to 0700 and must be a folder dedicated to cadre-host, linking to Security posture
- Run `yarn workspace @serfab/cadre-host build`, then its `test`, and `yarn lint`
