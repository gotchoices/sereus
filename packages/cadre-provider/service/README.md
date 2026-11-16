# Running cadre-provider as a service

Service definitions that run `cadre-provider start` under systemd, launchd or Windows (through NSSM). Each restarts the provider after a crash and treats exit code 0 as final, so a provider that shut down on request, including after a `shutdownAfter: true` request ([One-shot mode](../README.md#one-shot-mode)), stays down.

| Platform | File | Runs |
|---|---|---|
| Linux (systemd) | [`cadre-provider.service`](./cadre-provider.service) | `/usr/bin/node /opt/cadre-provider/dist/bin/provider.js start -c /etc/cadre-provider/provider.yaml` |
| macOS (launchd) | [`com.serfab.cadre-provider.plist`](./com.serfab.cadre-provider.plist) | `/usr/local/bin/node /usr/local/lib/cadre-provider/dist/bin/provider.js start -c /usr/local/etc/cadre-provider/provider.yaml` |
| Windows (NSSM) | [`install-service.ps1`](./install-service.ps1), [`uninstall-service.ps1`](./uninstall-service.ps1) | `node <InstallDir>\dist\bin\provider.js start -c <ConfigPath>` |

## What to install first

None of these files installs the provider. Before enabling one:

- Meet the provider's [prerequisites](../README.md#prerequisites): Docker, the node image and the Docker network.
- Install the `@serfab/cadre-provider` package so that the path in the table exists. The Linux and macOS definitions name a fixed directory; the steps for each platform put the package there. If Node.js or the package is somewhere else on your machine, edit the path in the definition instead.
- Write a `provider.yaml` ([Configuration](../README.md#configuration)) with `storage.type: file`.

## Linux (systemd)

Install the package and link it to the directory the unit names:

```bash
sudo npm install --prefix /opt/cadre-provider-pkg @serfab/cadre-provider
sudo ln -s /opt/cadre-provider-pkg/node_modules/@serfab/cadre-provider /opt/cadre-provider
```

Create the service user and its directories, install the configuration and the unit, and start it:

```bash
sudo useradd --system --no-create-home --shell /usr/sbin/nologin cadre-provider
sudo mkdir -p /var/lib/cadre-provider /var/log/cadre-provider /etc/cadre-provider
sudo chown cadre-provider:cadre-provider /var/lib/cadre-provider /var/log/cadre-provider
sudo install -m 640 -g cadre-provider provider.yaml /etc/cadre-provider/provider.yaml
sudo cp /opt/cadre-provider/service/cadre-provider.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now cadre-provider
```

- **Set `storage.path` to `/var/lib/cadre-provider`.** The unit makes the file system read-only for the provider (`ProtectSystem=strict`) except `/var/lib/cadre-provider` and `/var/log/cadre-provider`.
- **Both directories must exist**, or systemd refuses to start the unit. The provider writes no log file; its output goes to the journal (`journalctl -u cadre-provider`).
- **The unit runs as user `cadre-provider` with the supplementary group `docker`**, which is what lets it use the Docker socket. The `docker` group must exist.
- **Restart behaviour:** `Restart=on-failure` with `RestartPreventExitStatus=0`, five seconds between attempts.

## macOS (launchd)

```bash
sudo npm install --prefix /usr/local/lib/cadre-provider-pkg @serfab/cadre-provider
sudo ln -s /usr/local/lib/cadre-provider-pkg/node_modules/@serfab/cadre-provider /usr/local/lib/cadre-provider
sudo mkdir -p /usr/local/var/log/cadre-provider /usr/local/etc/cadre-provider
sudo cp provider.yaml /usr/local/etc/cadre-provider/provider.yaml
sudo cp /usr/local/lib/cadre-provider/service/com.serfab.cadre-provider.plist /Library/LaunchDaemons/
sudo launchctl load /Library/LaunchDaemons/com.serfab.cadre-provider.plist
```

- **The daemon runs as root**, since the property list names no user, and its working directory is `/`. Give `storage.path` as an absolute path.
- **Output goes to** `/usr/local/var/log/cadre-provider/out.log` and `err.log`.
- **Set `docker.socketPath`** to where your Docker installation puts its socket if that is not `/var/run/docker.sock`.
- **Restart behaviour:** `KeepAlive` with `SuccessfulExit` false and `Crashed` true, so a crash is relaunched and a clean exit is not.

## Windows (NSSM)

Install [NSSM](https://nssm.cc/download) with `nssm.exe` on `PATH`. Then, in an Administrator PowerShell that is allowed to run scripts, install the package and run the script from the package's `service` directory:

```powershell
npm install -g @serfab/cadre-provider
cd "$(npm root -g)\@serfab\cadre-provider\service"
.\install-service.ps1 -ConfigPath C:\ProgramData\CadreProvider\provider.yaml
nssm start CadreProvider
```

| Parameter | Default |
|---|---|
| `-NodePath` | `node.exe` found on `PATH` |
| `-InstallDir` | The package directory that contains the script; it must hold `dist\bin\provider.js` |
| `-ConfigPath` | `<InstallDir>\provider.yaml` |
| `-LogDir` | `C:\ProgramData\CadreProvider\logs`, created if missing; receives `out.log` and `err.log` |

- **The script replaces an existing `CadreProvider` service**, so it can be run again after an upgrade.
- **Set `docker.socketPath`** to your Docker engine's named pipe; the default is a Unix socket path.
- **A relative `storage.path`** resolves against `-InstallDir`, the service's working directory.
- **Restart behaviour:** exit 0 is not restarted (`AppExit 0 Exit`); any other exit restarts after 5 seconds.

To remove the service:

```powershell
.\uninstall-service.ps1
```
