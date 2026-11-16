description: On Windows the home-machine manager is installed as a machine-wide service that runs under the built-in system account, not as the person who installed it, so installing needs an administrator shell and secrets that person stores from the command line may be invisible to the running service. On Linux and macOS the service runs as the installing user.
architecture: docs/hosting/cadre-host.md#security-posture
files: packages/cadre-host/service/install-service.ps1, packages/cadre-host/src/installer/service-host/nssm.ts, packages/cadre-host/src/nat/secrets/index.ts, packages/cadre-host/src/bin/host.ts, packages/cadre-host/src/push/index.ts, packages/cadre-host/service/README.md, packages/cadre-host/README.md, docs/hosting/cadre-host.md
repro: static
severity: edge-case
likelihood: normal-use
tradeoffs: Nothing here was run on Windows, hosted nodes send no push wake today so the stored credentials are not yet used, and running a Windows service as a named user needs that user's password or a different mechanism (a logon task), which is a design choice the standalone installer may be the better place to make.
----

# The Windows service runs as LocalSystem, not as the installing user

## What the code does

`cadre-host install` on Windows runs `service/install-service.ps1` through `NssmServiceHost.install` (`installer/service-host/nssm.ts`). The script calls `nssm.exe install CadreHost <node> <host.js> start --no-tui --data-dir <dataDir>` and then sets the exit, restart, log and start-type options. It never sets `ObjectName`, the option that names the account a service runs under. NSSM's default for a new service is the LocalSystem account.

The data directory is not affected: the installer computes it as the installing user's `%LocalAppData%\CadreHost` and passes it to the service as `--data-dir`.

The cadre-host design assumes one account, "the cadre-host user", who installs it, runs the CLI and owns the service (`docs/hosting/cadre-host.md` → Security posture; the README calls it "a per-user service" and lists "Per-user install only" as a limit). On Linux the service is a `systemctl --user` unit and on macOS a LaunchAgent, so that holds. On Windows it does not. `service/README.md` and the Limits list of `docs/hosting/cadre-host.md` now state that the service runs as LocalSystem.

## Consequences, all read from the code and none run on Windows

- **Install and uninstall need an administrator shell.** Creating or removing a service is an administrator operation. On the other two platforms no step needs elevated rights.
- **Push credentials stored from the CLI may not reach the service.** `cadre-host push fcm`, `push apns`, `push clear` and `push status` do not call the running service. Each opens the secret store itself (`createSecretsStore` in `nat/secrets/index.ts`) as the user who typed the command, and the store is the operating system keychain when the `keytar` module loads. The service opens the same store as LocalSystem when it spawns a node (`pushResolver` in `bin/host.ts`). A Windows keychain entry belongs to the account that wrote it. The expected result is that `push status` prints "configured" while every hosted node is spawned with no push block. Dynamic DNS tokens are not affected: `cadre-host nat ddns set` sends the token to the running service, which stores it itself.
- **The two sides may not even pick the same kind of store.** `createSecretsStore` falls back to `<dataDir>\nat-secrets.json` when a probe write to the keychain fails. If the probe fails under LocalSystem and succeeds for the user, or the reverse, one side reads the file and the other the keychain.
- **Hosted nodes run with the highest local privilege.** The service's children inherit its account, so each hosted node, which accepts connections from the internet, runs as LocalSystem. Security posture point 1 ("anyone who can run code as the cadre-host user controls cadre-host") then means the whole machine.

## What a Windows run needs to show

1. After `cadre-host install` from an Administrator PowerShell: the account of the `CadreHost` service (`nssm get CadreHost ObjectName`, or the `StartName` of `Get-CimInstance Win32_Service -Filter "Name='CadreHost'"`), and the owner of its `node.exe` process and of one hosted node's process.
2. What `cadre-host install` does from a shell that is not elevated: the exit status and the message.
3. With `keytar` installed, as the installing user: run `cadre-host push fcm` with test values, then `cadre-host push status`. Then make the service spawn a node (join, or restart the service with a node present) and read `<dataDir>\orchestrator\<id>\cadre.json`. The question is whether it contains a `push` block.
4. Which store each side chose: whether `logs\out.log` or `logs\err.log` carries the "stored UNENCRYPTED" warning that the file fallback prints, and whether `nat-secrets.json` exists after step 3.

## Expected behaviour

The account that installs cadre-host, the account that runs its CLI and the account the service runs under see the same secrets, on every platform. A hosted node does not run with more privilege than the person who installed it has.

Directions, not a design: run the service under the installing user (NSSM needs that user's password for this, and a per-user logon task does not); or keep LocalSystem and make every secret write go through the running service; or store secrets on Windows in a place both accounts read. The existing ticket `cadre-host-push-credentials-ui-entry` (in `backlog/later/`) adds a management-API route for push credentials, which would remove the push arm by the second route.
