# Cadre Provider Service Units

Host the Cadre Provider as a system service. All three units are configured
so that **a clean exit (code 0) is final** — when a client provisions or
terminates a container with `shutdownAfter: true`, the provider exits and
stays exited. Crashes still trigger a restart.

| Platform | File | Service host |
| -------- | ---- | ------------ |
| Linux    | [`cadre-provider.service`](./cadre-provider.service)         | systemd |
| macOS    | [`com.serfab.cadre-provider.plist`](./com.serfab.cadre-provider.plist) | launchd |
| Windows  | [`install-service.ps1`](./install-service.ps1) / [`uninstall-service.ps1`](./uninstall-service.ps1) | NSSM    |

## Linux (systemd)

```bash
sudo cp cadre-provider.service /etc/systemd/system/
sudo useradd --system --no-create-home --shell /usr/sbin/nologin cadre-provider
sudo usermod -aG docker cadre-provider
sudo mkdir -p /var/lib/cadre-provider /var/log/cadre-provider /etc/cadre-provider
sudo cp /path/to/provider.yaml /etc/cadre-provider/provider.yaml
sudo systemctl daemon-reload
sudo systemctl enable --now cadre-provider
```

`Restart=on-failure` + `RestartPreventExitStatus=0` make exit 0 final.

## macOS (launchd)

```bash
sudo cp com.serfab.cadre-provider.plist /Library/LaunchDaemons/
sudo mkdir -p /usr/local/var/log/cadre-provider /usr/local/etc/cadre-provider
sudo cp /path/to/provider.yaml /usr/local/etc/cadre-provider/provider.yaml
sudo launchctl load /Library/LaunchDaemons/com.serfab.cadre-provider.plist
```

`KeepAlive.SuccessfulExit = false` plus `KeepAlive.Crashed = true` mean a
clean exit stays down while a crash is relaunched.

## Windows (NSSM)

Install [NSSM](https://nssm.cc/download) and put `nssm.exe` on PATH, then:

```powershell
.\install-service.ps1 -ConfigPath C:\ProgramData\CadreProvider\provider.yaml
nssm start CadreProvider
```

To remove:

```powershell
.\uninstall-service.ps1
```

`AppExit 0 Exit` tells NSSM not to restart on a clean exit; other exit
codes are handled by `AppExit Default Restart` with a 5-second delay and
10-second throttle.
