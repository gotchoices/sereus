# Cadre Host Service Units

Host cadre-host as a per-user system service. All three units are configured
so that **a clean exit (code 0) is final** — `cadre-host uninstall` (or any
explicit `systemctl stop` / `nssm stop`) leaves the service stopped. Crashes
still trigger a restart.

| Platform | File | Service host |
| -------- | ---- | ------------ |
| Linux    | [`cadre-host.service.tmpl`](./cadre-host.service.tmpl)             | systemd (user) |
| macOS    | [`com.serfab.cadre-host.plist.tmpl`](./com.serfab.cadre-host.plist.tmpl) | launchd (LaunchAgent) |
| Windows  | [`install-service.ps1`](./install-service.ps1) / [`uninstall-service.ps1`](./uninstall-service.ps1) | NSSM |

The `.tmpl` files contain `@TOKEN@` placeholders that the installer
substitutes at install time (`@NODE_PATH@`, `@HOST_JS@`, `@DATA_DIR@`).
Inspect the rendered files under `~/.config/systemd/user/cadre-host.service`
or `~/Library/LaunchAgents/com.serfab.cadre-host.plist` after running
`cadre-host install`.

## Scope (v1)

**Per-user install only.** The systemd unit is installed under the user's
control (`systemctl --user`), the launchd unit is a `LaunchAgent` (not a
`LaunchDaemon`), and NSSM runs as the current user.

A `--system` flag is accepted by `cadre-host install` but currently errors
out — running cadre-host as a dedicated system user requires more work
around data-dir ownership and capability dropping. Tracked separately.

## Linux (systemd) — manual smoke

```bash
# Render + install + enable + start in one go:
cadre-host install --non-interactive --data-dir ~/.local/share/cadre-host

# After install, the unit lives at:
#   ~/.config/systemd/user/cadre-host.service
# Inspect status:
systemctl --user status cadre-host
journalctl --user -u cadre-host -f
```

`Restart=on-failure` + `RestartPreventExitStatus=0` make exit 0 final.

The installer also runs `loginctl enable-linger <user>` so the unit survives
logout / reboot.

## macOS (launchd) — manual smoke

```bash
cadre-host install --non-interactive --data-dir "$HOME/Library/Application Support/CadreHost"

# After install, the plist lives at:
#   ~/Library/LaunchAgents/com.serfab.cadre-host.plist
launchctl print gui/$(id -u)/com.serfab.cadre-host
tail -f "$HOME/Library/Application Support/CadreHost/logs/out.log"
```

`KeepAlive.SuccessfulExit = false` plus `KeepAlive.Crashed = true` mean a
clean exit stays down while a crash is relaunched.

## Windows (NSSM) — manual smoke

Install [NSSM](https://nssm.cc/download) and put `nssm.exe` on PATH first.

```powershell
cadre-host install --non-interactive --data-dir $env:LocalAppData\CadreHost

# After install, inspect the service:
nssm.exe status CadreHost
Get-Service CadreHost
Get-Content $env:LocalAppData\CadreHost\logs\out.log -Tail 30 -Wait
```

`AppExit 0 Exit` tells NSSM not to restart on clean exit; other exit codes
are handled by `AppExit Default Restart` with a 5-second delay and a
10-second throttle. NSSM is **not** bundled with the npm package; the
standalone-binary distribution (see `tickets/backlog/cadre-host-standalone-binary.md`)
will ship it.

## CI gap

Cross-platform CI does **not** invoke `systemctl --user enable`,
`launchctl bootstrap`, or `nssm install`. The installer's unit-rendering
logic is covered by unit tests; the actual service-host registration must
be smoke-tested manually on each platform before tagging a release.
