# cadre-host service files

The files `cadre-host install` uses to register cadre-host as a service on each platform, and how to inspect the result. For installing and running cadre-host see the [package README](../README.md).

| Platform | File | Service manager | Registered as |
|---|---|---|---|
| Linux | [`cadre-host.service.tmpl`](./cadre-host.service.tmpl) | systemd, user unit | `cadre-host` at `~/.config/systemd/user/cadre-host.service` |
| macOS | [`com.serfab.cadre-host.plist.tmpl`](./com.serfab.cadre-host.plist.tmpl) | launchd, LaunchAgent | `com.serfab.cadre-host` at `~/Library/LaunchAgents/com.serfab.cadre-host.plist` |
| Windows | [`install-service.ps1`](./install-service.ps1), [`uninstall-service.ps1`](./uninstall-service.ps1) | [NSSM](https://nssm.cc/download) | `CadreHost`, configuration in the registry |

Each service runs `node <package>/dist/bin/host.js start --no-tui --data-dir <dataDir>`.

## How the files are used

The two `.tmpl` files contain `@NODE_PATH@`, `@HOST_JS@` and `@DATA_DIR@`. The installer replaces them with the Node.js binary (`--node-path`, default the one running the installer), the installed `dist/bin/host.js` and the data directory, writes the result to the path in the table, and starts the service. On Windows the installer runs `install-service.ps1` with the same three values as parameters and then starts the service.

On every platform a clean exit (code 0) is final and a crash is restarted, so that `cadre-host uninstall` or a manual stop leaves the service stopped.

| Platform | Setting that makes exit 0 final | Restart after a crash |
|---|---|---|
| Linux | `Restart=on-failure` with `RestartPreventExitStatus=0` | after 5 seconds |
| macOS | `KeepAlive.SuccessfulExit = false` with `KeepAlive.Crashed = true` | by launchd |
| Windows | `AppExit 0 Exit` with `AppExit Default Restart` | after 5 seconds, throttled to 10 seconds |

## Linux (systemd)

```bash
systemctl --user status cadre-host
journalctl --user -u cadre-host -f
```

A user unit runs only while the user has a session unless lingering is enabled. The installer runs `loginctl enable-linger <user>` and continues if that fails, for example because it needs root or `loginctl` is missing. Enable it yourself, before or after installing, so that the service starts at boot and survives logout:

```bash
sudo loginctl enable-linger "$USER"
```

## macOS (launchd)

```bash
launchctl print gui/$(id -u)/com.serfab.cadre-host
tail -f "$HOME/Library/Application Support/CadreHost/logs/out.log"
```

The LaunchAgent starts at login (`RunAtLoad`) and writes its output to `logs/out.log` and `logs/err.log` in the data directory.

## Windows (NSSM)

Install NSSM and put `nssm.exe` on `PATH` before running `cadre-host install`, from an Administrator PowerShell, because creating a Windows service requires administrator rights.

```powershell
nssm.exe status CadreHost
Get-Service CadreHost
Get-Content $env:LocalAppData\CadreHost\logs\out.log -Tail 30 -Wait
```

The service starts automatically at boot and writes its output to `logs\out.log` and `logs\err.log` in the data directory, with log rotation on. `install-service.ps1` removes an existing `CadreHost` service first, so it can be run again. It sets no service account, so the service runs under NSSM's default account, LocalSystem, unless you change it with `nssm set CadreHost ObjectName`.

## Limits

- **Per-user install only.** The Linux unit is a user unit and the macOS unit is a LaunchAgent, not a LaunchDaemon. `cadre-host install --system` fails.
- **NSSM is not bundled** with the npm package. (ticket `cadre-host-standalone-binary`)
- **Service registration is checked by hand.** The automated tests cover rendering the unit files. They do not run `systemctl --user enable`, `launchctl bootstrap` or `nssm install`, so a change to these files needs a manual install on each platform, checked with the commands in this file.
