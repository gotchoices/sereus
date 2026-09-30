# @serfab/cadre-cli

CLI wrapper for Sereus cadre nodes - start, monitor, and manage cadre node instances.

## Quick Start

```bash
# Install
npm install -g @serfab/cadre-cli

# Create identity
cadre enroll create --output . --name my-node

# Start (after configuring cadre.yaml)
cadre start -c cadre.yaml
```

## Installation

Choose **one** installation method. Both produce the same CLI; npm is simpler, git gives you bleeding-edge updates.

### Option A: npm (stable releases)

```bash
npm install -g @serfab/cadre-cli
```

For server deployments (non-global):

```bash
cd /opt/cadre
npm init -y
npm install @serfab/cadre-cli @serfab/cadre-core
```

**Paths (npm):**
| Item | Location |
|------|----------|
| CLI binary | `node_modules/.bin/cadre` or global `cadre` |
| Example config | `node_modules/@serfab/cadre-cli/example.cadre.yaml` |
| Systemd service | `node_modules/@serfab/cadre-cli/contrib/cadre-node.service` |
| Install script | `node_modules/@serfab/cadre-cli/contrib/cadre-install.sh` |

### Option B: Git clone (bleeding edge)

```bash
git clone https://github.com/gotchoices/sereus.git /opt/sereus
cd /opt/sereus
yarn install
yarn workspaces foreach -Rt --from '@serfab/cadre-cli' run build
```

**Paths (git):**
| Item | Location |
|------|----------|
| CLI binary | `packages/cadre-cli/dist/bin/cadre.js` |
| Example config | `packages/cadre-cli/example.cadre.yaml` |
| Systemd service | `packages/cadre-cli/contrib/cadre-node.service` |
| Install script | `packages/cadre-cli/contrib/cadre-install.sh` |

**Updating (git):**

```bash
cd /opt/sereus
git pull
yarn install
yarn workspaces foreach -Rt --from '@serfab/cadre-cli' run build
sudo systemctl restart cadre-node  # if running as service
```

## Usage

### Start a Node

```bash
cadre start -c cadre.yaml
cadre start -c cadre.yaml --debug
```

### Check Status

`cadre status` reads **live runtime** from a running node's health `/status`
endpoint and reports it alongside the static config summary. A missing config
file is non-fatal (the live query still runs); when no node is reachable it
says so and exits with code `3` (rather than reporting a bare `running: false`).

```bash
cadre status -c cadre.yaml
cadre status --json
# point at a node on another host/port (env CADRE_HEALTH_PORT also honored):
cadre status --health-host 10.0.0.5 --health-port 8080 --timeout 2000
```

### Enroll New Peers

Create a new peer identity:

```bash
cadre enroll create --output ./keys --name my-node
```

Writes `<name>.key` (the private key, mode 600) and `<name>.id` (the Peer ID). The key file is
the libp2p protobuf format — the one identity format `identity.keyFile` accepts. The command
**refuses to overwrite an existing `<name>.key`**: that file is the node's identity, and
replacing it changes the node's Peer ID irrecoverably. Move or delete it first if you really
mean to re-key.

Verify an owner's signature over a peer ID. This is an **offline check**:
it confirms the signature is valid but does **not** contact the control network
or register the peer. Membership is granted by the running owner node — see
[Add a Machine to the Cadre](#add-a-machine-to-the-cadre).

```bash
cadre enroll register \
  --peer-id 12D3KooW... \
  --bootstrap /ip4/.../tcp/4001/p2p/12D3KooW... \
  --owner-key <public-key> \
  --signature <signature>
```

### Add a Machine to the Cadre

A new machine joins in three steps: it makes an identity, the owner admits it and prints a seed, and it starts with that seed.

```bash
# 1. On the new machine B: prints B's peer ID, writes node-b.key and node-b.id
cadre enroll create --output . --name node-b

# 2. On the owner machine A, which is already running as:
#      CADRE_STARTUP_TOKEN=<token> cadre start --owner --admin-port 7070 -c cadre.yaml
CADRE_STARTUP_TOKEN=<token> cadre enroll add "$(cat node-b.id)" --admin-port 7070 > node-b.seed

# 3. On machine B, whose config names the same controlNetwork.partyId as A's
cadre start -c cadre.yaml --identity-file node-b.key --pin-owner-key <owner key> --seed "$(cat node-b.seed)"
```

`cadre enroll add` asks the running owner node, over its loopback admin channel, to authorize the new machine and mint a seed for it. The owner therefore has to be running with `--owner --admin-port <port>` and `CADRE_STARTUP_TOKEN` set; `enroll add` takes the same port (`--admin-port` or `CADRE_ADMIN_PORT`) and the same token (`--token-file <path>`, the file `cadre start --startup-token-file` writes, or `CADRE_STARTUP_TOKEN`). The token is never accepted as a flag value, since it would show in the process list.

Only the seed goes to stdout, so `>` and `$(…)` capture exactly what `--seed` takes. Stderr names the party ID the new machine's config must carry, the owner key it pins with `--pin-owner-key`, and the owner addresses the seed carries. `--json` prints `{ peerId, partyId, signerKey, ownerAddrs, encodedSeed, warnings }` on stdout instead. Every failure exits 1 with a message that names the fix: no admin channel on that port, a token that does not match the owner's, or a node not started with `--owner`. On the new machine, `cadre start` refuses to start when the seed does not decode or was minted for a different party than its config names.

The seed carries whatever addresses the owner advertises; `enroll add` does not choose them. Which setup works depends on the network between the machines:

- **Same LAN:** the owner's listen addresses are enough.
- **Owner behind NAT:** set `network.appendAnnounceAddrs` on the owner to a forwarded public address, or give it a relay (`network.relayAddrs`), and restart it before running `enroll add`.
- **New machine reachable, owner not:** pass `--addr <the new machine's multiaddr>` (repeatable) and the owner dials out to it instead, from its control-cohort reconcile pass (every 15 s by default; a pass already under way when the machine was added does not include it, so allow up to two passes).

When the seed carries no owner address and no `--addr` was given, neither machine can dial the other; `enroll add` warns and names these fixes. Running `enroll add` again for a peer that is already authorized leaves its authorization as it is and mints a fresh seed, so it is the way to pick up changed owner addresses; any `--addr` given on the re-run replaces the address the owner dials.

[docs/architecture.md → Which Side Dials](../../docs/architecture.md#which-side-dials-the-add-a-node-flows-compared) compares this flow with the other ways to add a machine to a cadre, by which machine opens the connection.

### Strands

List the strands this node is running (`cadre strands` is an alias for `cadre strand list`):

```bash
cadre strand list -c cadre.yaml
cadre strand list --json          # payload on stdout, progress on stderr — pipes into jq
```

Remove a strand. This deletes **this party's** `Strand` row, so every cadre node in the party
stops running the strand on its next watcher poll. Other *parties* in that strand are
unaffected — removal withdraws our participation, it does not destroy the network. The write
is owner-signed, so the config's identity key must be an enrolled owner key.

```bash
cadre strand remove <strandId>
cadre strand remove <strandId> --yes      # required for a closed strand
cadre strand remove <strandId> --json
```

Removing a **closed** strand is irreversible and requires `--yes`: the row carries this
party's membership key for that network, the key is stored nowhere else, and once it is gone
the party can never admit another member to that strand. Without `--yes` the command refuses
and exits non-zero (under `--json` it prints a structured refusal rather than removing).
`--yes` is not needed for an open strand.

A strand that was never published is not an error — the command reports "nothing to do" and
exits 0.

One caveat the CLI cannot paper over: a removal that commits while this node has **no**
control-network connections is local-only, and a physical delete cannot be re-issued the way
an insert can, so siblings may keep running the strand when they come back. Remove while the
node is connected. See "Deletes made while alone" in
[`docs/architecture.md`](../../docs/architecture.md#deletes-made-while-alone).

### Approver Keys

An invitation may carry a validation URL: a web hook an outside approver operates, which has
to sign off before the invitation can be redeemed. `validation-key` is how the party says
which approvers it trusts — a party with none enrolled cannot use such invitations at all.

The config's identity key must be an enrolled owner key; these writes are owner-signed.

```bash
cadre validation-key list -c cadre.yaml
cadre validation-key list --json            # ["<key>", ...]
cadre validation-key add <base64url-public-key>
cadre validation-key remove <base64url-public-key>
```

Rotate by adding the new key **before** removing the old one: removing the last enrolled key
leaves every outstanding validation-gated invitation unredeemable until a key is enrolled.
Removal only narrows who may approve *future* redemptions — joins already approved by the
removed key stay valid.

## Configuration

See [example.cadre.yaml](./example.cadre.yaml) for a complete configuration example.

Every key in the file is checked at start, after the environment variables below have been
applied. An unknown or misspelled key (`network.listenAddr` — the error suggests
`listenAddrs`), a retired key (`identity.protobufKeyFile`), a value of the wrong type
(`hibernation.enabled: "yes"`, `storage.type: fs`), or a missing required key
(`controlNetwork.partyId`) stops the node with an error naming the key and its source — the
config file, or the `CADRE_*` variable that supplied the value. Every problem in the file is
reported in one run, one per line, so a hand-edited file is fixed in one pass. There is no
warn-only mode: a setting the node does not recognise was never doing anything, and the node
says so rather than starting without it.

### Environment Variables

| Variable | Config Path | Description |
|----------|-------------|-------------|
| `CADRE_PARTY_ID` | `controlNetwork.partyId` | Party/control network UUID |
| `CADRE_BOOTSTRAP_NODES` | `controlNetwork.bootstrapNodes` | Comma-separated multiaddrs |
| `CADRE_PROFILE` | `profile` | Node profile (transaction/storage) |
| `CADRE_KEY_FILE` | `identity.keyFile` | Path to the node's private key file — a libp2p protobuf-encoded private key, the one accepted identity format (written by `cadre enroll create` and by cadre-host's installer as `identity.key`). A file in any other shape fails startup rather than being guessed at. `cadre start --identity-file <path>` sets this, so the flag outranks the config file |
| `CADRE_STORAGE_PATH` | `storage.path` | Data storage directory |
| `CADRE_STORAGE_TYPE` | `storage.type` | Storage type (memory/file) |
| `CADRE_STORAGE_QUOTA` | `storage.quotaBytes` | Storage quota in bytes (a whole number) |
| `CADRE_LISTEN_ADDRS` | `network.listenAddrs` | Comma-separated multiaddrs to listen on. An entry naming a relay (`<relay addr>/p2p-circuit`) fails startup — use `CADRE_RELAY_ADDRS`, which reserves the slot after the control database is up. Only the **control node** binds these as written: a machine also runs one node per strand, and each of those binds the same entries with the port rewritten to `0`, since one port cannot be held twice. A port forwarded through NAT therefore reaches the control node only. Only TCP, WebSocket (`/ws`, `/wss`) and circuit-relay entries are bindable from config — anything else (`/quic-v1`, `/webrtc`, `/webtransport`) fails startup naming the address and the libp2p package it would need, since a config file cannot supply a transport factory |
| `CADRE_ANNOUNCE_ADDRS` | `network.announceAddrs` | Comma-separated multiaddrs to advertise **instead of** `listenAddrs`. A non-empty value replaces everything the node advertises, including the `/p2p-circuit` address a `relayAddrs` reservation earns it — the node warns at start when both are set. **Control node only**: any entry names a port, and that port is the control node's, so strand nodes drop it rather than advertise an address that reaches the wrong node. A malformed entry fails startup |
| `CADRE_APPEND_ANNOUNCE_ADDRS` | `network.appendAnnounceAddrs` | Comma-separated multiaddrs to advertise **in addition to** `listenAddrs` — the usual way to publish a reachable address without discarding the rest. Ignored while `announceAddrs` is non-empty. **Control node only**, on the same terms as `CADRE_ANNOUNCE_ADDRS`. A malformed entry fails startup |
| `CADRE_ENABLE_RELAY` | `network.enableRelay` | `true`/`1` enables this node's circuit-relay server, `false`/`0` disables it; any other value fails startup. Unset ⇒ profile default (on for storage, off for transaction) |
| `CADRE_STRAND_FILTER` | `strandFilter` | `all`, `none`, or a JSON object — `{"sAppId":"myapp"}` / `{"strandId":"<id>"}`. A malformed value fails startup rather than degrading to `all` |
| `CADRE_PUSH` | `push` | FCM/APNs credentials as a JSON object (e.g. `{"fcm":{…},"apns":{…}}`), injected per node by an orchestrator. A malformed or partial value fails startup |
| `CADRE_RELAY_ADDRS` | `network.relayAddrs` | Comma-separated circuit-relay dial multiaddrs (each ending in the relay's peer id) to reserve a slot on, so peers can reach this node from behind NAT. The node listens on a bare `/p2p-circuit` alongside `listenAddrs` and reserves at the end of startup, once its control database is up. A malformed entry fails startup, and so does a relay that grants no reservation on the first attempt (~10 s) — naming a relay means the node does not come up without one |
| `CADRE_HIBERNATION_ENABLED` | `hibernation.enabled` | Enable strand hibernation (`true`/`false`/`1`/`0`) |
| `CADRE_LATENCY_HINT` | `hibernation.defaultLatencyHint` | Default latency hint: `realtime`, `interactive`, `background` or `archive` |
| `CADRE_STRAND_WATCH_INTERVAL` | `strandWatchInterval` | Strand watcher polling interval in milliseconds |
| `CADRE_NODE_STATE_DIR` | `nodeState.dir` | Directory for this node's durable node-local state (trusted-owner anchor, retained cold-start dial targets). Defaults to the directory holding the config file — override when that directory is not writable by the node's user |
| `CADRE_HEALTH_PORT` | _(env only)_ | Health server port for `cadre start`, and the port `cadre status` queries; the env value wins over `--health-port` |
| `CADRE_METRICS_PORT` | _(env only)_ | Metrics server port for `cadre start`; the env value wins over `--metrics-port` |
| `CADRE_SEED_TOKEN` | _(env only)_ | Bearer token gating `POST /seed`. **Unset = seed endpoint disabled**; when set, `POST /seed` requires `Authorization: Bearer <token>` |
| `CADRE_STARTUP_TOKEN` | _(env only)_ | Bearer token for the loopback admin channel. `cadre start --admin-port` refuses to bind the channel without it; `cadre enroll add` presents it (or reads it from `--token-file`). `cadre start --startup-token-file <path>` writes it to that file |
| `CADRE_ADMIN_PORT` | _(env only)_ | Admin channel port: what `cadre start` binds on `127.0.0.1` (the env value wins over `--admin-port`), and the port `cadre enroll add` connects to when it is not given `--admin-port` |
| `CADRE_OWNER_KEYS` | _(env only)_ | Comma-separated base64url owner keys pinned as cold-start seed-trust anchors (unions with repeatable `--pin-owner-key`). A cold node (empty `OwnerKey` table) **rejects** `--seed` / `POST /seed` unless the seed's signer is pinned here or already DB-known. Independent of `CADRE_SEED_TOKEN`: bearer is the *delivery* gate, this is the *trust* anchor. Each entry must be a base64url 32-byte Ed25519 public key; a malformed entry fails startup naming the bad value, rather than sitting in the anchor and silently matching no signer |

Environment variables override config file values. A variable that is **set but
empty** (or whitespace-only) counts as unspecified and is ignored — this is what
`docker-compose.yml`'s `${CADRE_ENABLE_RELAY:-}`-style defaults produce for an
optional variable the operator never set, and it must not clobber what the
config file says. To force a value off, set it explicitly (e.g.
`CADRE_ENABLE_RELAY=false`).

A set `CADRE_*` variable the node does not recognise **fails startup**, naming it
and suggesting the nearest known name — a misspelled variable is otherwise a
setting silently not applied. Recognised are the variables in the table above,
plus three read by the launchers around the CLI rather than by the CLI itself:
`CADRE_CONFIG` (the systemd unit's config path), and `CADRE_CONFIG_FILE` and
`CADRE_DEBUG` (the Docker entrypoint's). Names beginning `CADRE_HOST_` belong to
cadre-host and are skipped. The retired `CADRE_IDENTITY_PROTOBUF` fails startup
with a pointer to `CADRE_KEY_FILE`.

## Linux Server Deployment

This section covers production deployment on Linux using systemd. Works with either installation method.

### Prerequisites

You will need:
- **Party ID**: UUID identifying your control network
- **Bootstrap nodes**: Multiaddr(s) of existing nodes to connect to

### Port Requirements

All ports are unprivileged (>1024) — no root or special capabilities needed:

| Port | Purpose |
|------|---------|
| 4001 | libp2p P2P networking |
| 8080 | Health probes (`/health`, `/ready`, `/status`) — read-only by default. `POST /seed` is authenticated and **off unless `CADRE_SEED_TOKEN` is set** (then requires `Authorization: Bearer <token>`) |
| 9090 | Prometheus metrics (`/metrics`) — read-only; keep off the public internet |

Only port **4001** should be reachable from the public internet:

```bash
sudo ufw allow 4001/tcp comment "Sereus libp2p"
```

**Do not** open 8080 (health/seed) or 9090 (metrics) to the public internet —
keep them on loopback or a trusted management network. The Docker Compose
template binds both to `127.0.0.1` by default (override per port with
`HOST_HEALTH_BIND` / `HOST_METRICS_BIND`, e.g. `0.0.0.0`, only behind a
firewall). `POST /seed` is additionally bearer-gated and is not registered at
all unless `CADRE_SEED_TOKEN` is set, so the health port carries no
remotely-mutable surface in the default configuration.

### Dedicated User vs Regular User

**Dedicated `cadre` user (recommended for production):**
- Security isolation — compromise is contained
- Systemd hardening features work effectively
- Standard practice for long-running services

**Regular login user (fine for development):**
- Simpler setup and debugging
- Direct file access
- Run interactively in tmux/screen

### Data Locations

| Deployment | Config | Keys | Strand Data | Node State |
|------------|--------|------|-------------|------------|
| Systemd (dedicated user) | `/etc/cadre/cadre.yaml` | `/etc/cadre/cadre-peer.key` | `/var/lib/cadre/` | `/var/lib/cadre/` (unit sets `CADRE_NODE_STATE_DIR`) |
| Development (regular user) | `./cadre.yaml` | `./cadre-peer.key` | `./data/` | `./` (config file's directory) |
| Docker | Volume `/data/cadre.yaml` | Volume `/data/cadre-peer.key` | Volume `/data/storage/` | Volume `/data/` (config file's directory) |

**Node State** holds the trusted-owner anchor (`trusted-owners.<partyId>.json`)
and the retained cold-start dial targets (`bootstrap-peers.<partyId>.json`) —
non-replicated, per-party, and required for the node to keep its out-of-band
trust and its way back into the party across restarts. It must be writable by
the node's user, and it belongs in backups alongside the identity key.

### Installation Steps

The steps below use variables for paths. Set them based on your installation method:

```bash
# === Choose ONE block ===

# For npm install:
CADRE_ROOT="/opt/cadre"
CADRE_BIN="$CADRE_ROOT/node_modules/.bin/cadre"
CADRE_PKG="$CADRE_ROOT/node_modules/@serfab/cadre-cli"

# For git clone:
CADRE_ROOT="/opt/sereus"
CADRE_BIN="node $CADRE_ROOT/packages/cadre-cli/dist/bin/cadre.js"
CADRE_PKG="$CADRE_ROOT/packages/cadre-cli"
```

#### 1. Create service user and directories

```bash
sudo useradd --system --no-create-home --shell /usr/sbin/nologin cadre
sudo mkdir -p "$CADRE_ROOT" /etc/cadre /var/lib/cadre
sudo chown cadre:cadre /var/lib/cadre
```

#### 2. Install the package

**npm method:**

```bash
cd /opt/cadre
sudo npm init -y
sudo npm install @serfab/cadre-cli @serfab/cadre-core
```

**git method:**

```bash
sudo git clone https://github.com/gotchoices/sereus.git /opt/sereus
cd /opt/sereus
sudo corepack enable
sudo yarn install
sudo yarn workspaces foreach -Rt --from '@serfab/cadre-cli' run build
sudo chown -R root:root /opt/sereus
```

#### 3. Copy and edit configuration

```bash
sudo cp "$CADRE_PKG/example.cadre.yaml" /etc/cadre/cadre.yaml

# Update paths for production layout
sudo sed -i 's|path: ./data|path: /var/lib/cadre|' /etc/cadre/cadre.yaml
sudo sed -i 's|keyFile: ./cadre-peer.key|keyFile: /etc/cadre/cadre-peer.key|' /etc/cadre/cadre.yaml

sudo chmod 640 /etc/cadre/cadre.yaml
sudo chown root:cadre /etc/cadre/cadre.yaml

# Edit with your party ID and bootstrap nodes
sudo nano /etc/cadre/cadre.yaml
```

#### 4. Generate peer identity

```bash
sudo -u cadre $CADRE_BIN enroll create --output /etc/cadre --name cadre-peer
```

#### 5. Install systemd service

```bash
sudo cp "$CADRE_PKG/contrib/cadre-node.service" /etc/systemd/system/

# For git installs, update the ExecStart path:
# sudo sed -i 's|/opt/cadre/node_modules/@serfab/cadre-cli|/opt/sereus/packages/cadre-cli|' \
#   /etc/systemd/system/cadre-node.service
# sudo sed -i 's|WorkingDirectory=/opt/cadre|WorkingDirectory=/opt/sereus|' \
#   /etc/systemd/system/cadre-node.service

sudo systemctl daemon-reload
sudo systemctl enable cadre-node
sudo systemctl start cadre-node
```

### Service Management

```bash
# Check status
systemctl status cadre-node

# View logs
journalctl -u cadre-node -f

# Restart
sudo systemctl restart cadre-node

# Stop
sudo systemctl stop cadre-node
```

### Service Security Hardening

The systemd service includes:

- Runs as unprivileged `cadre` user
- `ProtectSystem=strict` — read-only filesystem except `/var/lib/cadre`
- `ProtectHome=true` — no access to `/home`
- `PrivateTmp=true` — isolated `/tmp`
- `NoNewPrivileges=true` — cannot escalate privileges
- Memory limit (8GB default, adjustable)

Edit `/etc/systemd/system/cadre-node.service` to customize resource limits.

## Docker Deployment

See the [`docker/`](./docker/) directory (`Dockerfile`, `docker-compose.yml`, `env.example`) for Docker Compose deployment, or use:

```bash
cd packages/cadre-cli/docker  # or node_modules/@serfab/cadre-cli/docker
cp env.example .env
# Edit .env with CADRE_PARTY_ID and CADRE_BOOTSTRAP_NODES
docker compose up -d
```

Node state (peer key, storage) lives in the `sereus_cadre_data` volume. Back up
the peer identity — losing it changes the node's PeerID. The key file is **binary**
(a libp2p protobuf private key), so copy it as a file rather than piping it through
a TTY, which would mangle the bytes:

```bash
docker compose cp cadre-node:/data/cadre-peer.key ./cadre-peer.key.bak
# to restore, stop the node first so it re-reads the key on its next start:
docker compose stop cadre-node
docker compose cp ./cadre-peer.key.bak cadre-node:/data/cadre-peer.key
docker compose start cadre-node
```

## Programmatic Usage

```typescript
import { resolveConfig } from '@serfab/cadre-cli';
import { CadreNode } from '@serfab/cadre-core';

const config = await resolveConfig('cadre.yaml');
const node = new CadreNode(config);

node.on('control:connected', () => console.log('Connected'));
node.on('strand:started', ({ strandId }) => console.log(`Strand ${strandId} started`));

await node.start();
```

## License

MIT

