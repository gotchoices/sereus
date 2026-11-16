description: The Linux server install script that ships in the command-line node's source folder copies two files out of the installed package that the published package does not contain, so the script stops halfway, and the next step it prints tells the operator to write a key into a folder the service account cannot write.
architecture: packages/cadre-cli/README.md#linux-server-deployment
files: packages/cadre-cli/contrib/cadre-install.sh, packages/cadre-cli/contrib/cadre-node.service, packages/cadre-cli/package.json, packages/cadre-cli/example.cadre.yaml, packages/cadre-cli/README.md, packages/cadre-cli/src/config/loader.ts, packages/cadre-cli/test/env-names.spec.ts
repro: static
severity: edge-case
likelihood: unusual
tradeoffs: The README no longer mentions the script and gives a manual procedure that does not have these faults, so the cheapest fix is deleting the script, and few operators will find it on their own.
----

# `contrib/cadre-install.sh` fails on the package it installs

## What is wrong

`packages/cadre-cli/contrib/cadre-install.sh` sets up a dedicated `cadre` account, `/opt/cadre`, `/etc/cadre` and `/var/lib/cadre`, runs `npm install @serfab/cadre-cli @serfab/cadre-core` in `/opt/cadre`, and then copies two files from the installed package:

- `node_modules/@serfab/cadre-cli/example.cadre.yaml` to `/etc/cadre/cadre.yaml`
- `node_modules/@serfab/cadre-cli/contrib/cadre-node.service` to `/etc/systemd/system/`

The package's `files` list publishes `src` and `dist` only. `npm pack --dry-run` in `packages/cadre-cli` lists `README.md`, `package.json`, `dist` and `src` at the top level, with no `example.cadre.yaml` and no `contrib/`. The script runs under `set -e`, so the first copy fails and the script exits after creating the account and the folders and before installing the systemd unit.

The script was not run. The missing files were confirmed with the dry-run pack.

## The printed next step also fails

Were the copies to succeed, the script prints:

```
sudo -u cadre cadre enroll create --output /etc/cadre --name cadre-peer
```

Three things in that line do not hold, each read from the script and the unit file:

- **`cadre` is not on `PATH`.** The script installs the package locally in `/opt/cadre`, so the binary is `/opt/cadre/node_modules/.bin/cadre`.
- **The `cadre` account cannot write `/etc/cadre`.** The script sets that folder to `root:root`, mode 755.
- **The key ends up where the unit forbids writes.** The script rewrites the config's `identity.keyFile` to `/etc/cadre/cadre-peer.key`, and `cadre-node.service` marks `/etc/cadre` read-only. Reading the key still works, so this is a layout that only root can maintain, not a failure by itself.

## Expected behaviour

One Linux server procedure, and it works on the published package. `packages/cadre-cli/README.md` → "Linux server deployment" is that procedure today: it fetches the unit from the repository with `curl`, writes the config inline, and keeps the key in `/var/lib/cadre`. The README states that the npm package holds `dist` and `src` only, so shipping the two files is not the intended fix.

Either the script is deleted, or it is rewritten to do what the README section does. If it is deleted, two references go with it: the `LAUNCHER_FILES` entry in `test/env-names.spec.ts`, and the `NOTE:` in `loadIdentityKey` (`src/config/loader.ts`) that names the script's `sed` as one of the launchers passing an absolute key path.

## To confirm at run time

On a Linux machine with systemd, as root, run the script as fetched from the repository. Expect `cp: cannot stat '/opt/cadre/node_modules/@serfab/cadre-cli/example.cadre.yaml'` and a non-zero exit, with no `cadre-node.service` in `/etc/systemd/system`.
