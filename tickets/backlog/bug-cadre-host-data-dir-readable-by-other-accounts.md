description: On a shared Linux machine, other user accounts may be able to read cadre-host's data folder, which holds the one-time codes for nodes waiting to be claimed, pasted cadre invitations, push-service private keys and each node's copy of its cadre's data; the folder should be readable by the cadre-host user alone.
architecture: docs/cadre-host.md#security-posture
files: packages/cadre-host/src/installer/index.ts, packages/cadre-host/src/bin/host.ts, packages/cadre-host/src/hosted/hosted-node-store.ts, packages/cadre-host/src/orchestrator/host-process-orchestrator.ts, packages/cadre-host/src/nat/secrets/file-store.ts, packages/cadre-host/src/orchestrator/identity-file.ts, docs/cadre-host.md
repro: static
severity: wrong-result
likelihood: unusual
tradeoffs: macOS (`~/Library` is 0700) and Windows (`%LocalAppData%` is per-user) already keep the default data folder private, and many Linux distributions now create home folders 0750 or 0700, so the exposure is limited to Linux hosts with a world-readable home or a custom `--data-dir`, where a second local account also exists.
----
# cadre-host's data folder is not private to its user

## What is exposed

cadre-host writes everything under one data folder (`defaultDataDir` in `installer/paths.ts`: `~/.local/share/cadre-host` on Linux unless `XDG_DATA_HOME` or `--data-dir` says otherwise). Only two files in it are written owner-only (mode 0600): each node's `identity.key` (`orchestrator/identity-file.ts`) and the keychain fallback `nat-secrets.json` (`nat/secrets/file-store.ts`). Everything else is created with the process's default mode, which on a typical umask of 022 is readable by every account on the machine:

- `hosted-nodes.json` (`hosted/hosted-node-store.ts`, `writeFileSync` with no mode): the claim secret of every node, including ones still waiting to be claimed, and the full text of every pasted cadre invitation, which carries the invitation's private key. Anyone who reads a pending claim secret can claim that node into their own cadre ahead of its intended owner.
- Each node's `cadre.json` in its working folder (`host-process-orchestrator.ts`, `writeFileSync(configPath, …)`): the FCM / APNs private keys when push credentials are configured.
- Each node's storage folder: its replica of the cadre's control database and the strands it stores.

The folders themselves are created with `mkdirSync(…, { recursive: true })` and no mode (`installer/index.ts`, the stores' constructors), so whether another account can reach any of this depends only on the permissions of the folders above the data folder.

Found by reading the code during the review of `cadre-host-join-docs`; not reproduced on a multi-user machine. Confirm with a default install on a Linux host whose home folder is 0755, then `sudo -u <other user> cat ~<cadre-host user>/.local/share/cadre-host/hosted-nodes.json`.

## Expected behaviour

The cadre-host user's data is readable by that user alone, whatever the umask and whatever the parent folders allow. [cadre-host.md → Security posture](../../docs/cadre-host.md#security-posture) defends against nothing that runs as the cadre-host user, but the package already treats other local accounts as outside the trust boundary (the 0600 identity keys and secrets fallback); the rest of the data folder should follow the same rule.

The invariant that covers every file at once, rather than a mode per file: the data folder is created 0700 and narrowed to 0700 on every `cadre-host start` (an existing install keeps its folder), so nothing below it is reachable by another account however it was written. The per-file 0600 writes can stay as defence in depth. Windows has no mode bits; `%LocalAppData%` is already per-user, and a custom `--data-dir` there is the admin's responsibility, which the docs should say.

When this lands, drop the sentence in [cadre-host.md → Where the credentials go](../../docs/cadre-host.md#where-the-credentials-go) that points here.
