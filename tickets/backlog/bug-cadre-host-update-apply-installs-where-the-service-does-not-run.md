description: The home-machine manager's "apply update" action always installs the new version into the system-wide package location, even when the running copy lives in a folder of its own, so the action reports success, restarts the service, and the old version keeps running.
architecture: docs/hosting/cadre-host.md#updates
files: packages/cadre-host/src/update/apply.ts, packages/cadre-host/src/update/index.ts, packages/cadre-host/src/bin/host.ts, packages/cadre-host/src/installer/paths.ts, packages/cadre-host/README.md, docs/hosting/cadre-host.md
repro: static
severity: edge-case
likelihood: normal-use
tradeoffs: The README's Limits section already tells folder-install users to update by hand, the worst outcome described here needs the opt-in automatic-update setting, and installing into the right place for every install shape may be judged out of scope until the standalone binary replaces the npm install.
----

# Apply installs a copy the service does not run

## What is wrong

cadre-host has two documented install shapes (`packages/cadre-host/README.md` → Install): a global install (`npm install -g @serfab/cadre-host`) and a folder install (`npm install @serfab/cadre-host` inside a folder such as `~/cadre`). The service definition written by `cadre-host install` names the entry file of whichever copy ran the installer (`defaultHostJs` in `installer/paths.ts`).

`applyUpdate` in `update/apply.ts` runs `npm install -g <package>@<version>` in every case. It does not look at where the running copy is. For a folder install:

1. npm installs a second copy into the global prefix and exits 0.
2. `UpdateService.apply` clears `applyInProgress` and `lastError` and returns success.
3. The restart hook restarts the service, which starts the folder copy again at the old version.
4. The new process runs `check()` at start, finds the same release still newer than itself, and shows the banner again.

The UI's Apply button therefore reports a successful update that did not happen, and leaves an unused global copy behind.

Both docs state the limit ("A folder install is not updated by Apply" in the README's Limits, and the last sentence of `docs/hosting/cadre-host.md` → Updates → Apply). Neither says that Apply reports success.

## Consequences read from the code, not observed

- **A restart cycle with automatic updates on.** `check()` calls `apply()` when `updates.autoApply` is true, and `host.ts` calls `check()` at every start. On a folder install with a newer release published, each start would install globally, restart, and check again. Nothing in `UpdateService` records that the last apply did not change the running version.
- **The same on Windows for a global install.** The Windows service runs as LocalSystem (see ticket `bug-cadre-host-windows-service-runs-as-another-account`). npm's global prefix depends on the account's environment, so the service's `npm install -g` may write to LocalSystem's prefix and not to the installing user's prefix that the service definition points at. Not checked on a Windows machine.

## Expected behaviour

Apply updates the copy the service runs, or refuses with a message that says how to update it. It never reports success when the version that starts after the restart is the version that was running before.

A direction, not a design: after an apply, the next start can compare its own version with the `toVersion` of the apply it was restarted for, and record a failure when they differ. That closes the false success and the restart cycle for every install shape, including ones nobody has listed. Installing into the folder for a folder install is a separate improvement on top.

## Evidence

Read from `update/apply.ts` (`applyUpdate`, the fixed `['install', '-g', …]` arguments), `update/index.ts` (`check`, `apply`) and the `UpdateService` construction in `bin/host.ts`. The specs in `src/update/__tests__` inject the npm executor and do not cover where the package lands.

To confirm at run time: make a folder install, point `updates.manifestUrl` (or `CADRE_HOST_UPDATE_MANIFEST_URL`) at a signed test manifest naming a newer version, press Apply, and compare the version on the Home page before and after. For the restart cycle, repeat with `updates.autoApply` true and count the service starts in the log.
