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

Verify an owner's signature over a peer ID. This is an **offline check**:
it confirms the signature is valid but does **not** contact the control network
or register the peer. Membership is granted by the running owner node
(`cadre start --owner`), which self-registers and authorizes peers.

```bash
cadre enroll register \
  --peer-id 12D3KooW... \
  --bootstrap /ip4/.../tcp/4001/p2p/12D3KooW... \
  --owner-key <public-key> \
  --signature <signature>
```

### List Strands

```bash
cadre strands -c cadre.yaml
cadre strands --json
```

## Configuration

See [example.cadre.yaml](./example.cadre.yaml) for a complete configuration example.

### Environment Variables

| Variable | Config Path | Description |
|----------|-------------|-------------|
| `CADRE_PARTY_ID` | `controlNetwork.partyId` | Party/control network UUID |
| `CADRE_BOOTSTRAP_NODES` | `controlNetwork.bootstrapNodes` | Comma-separated multiaddrs |
| `CADRE_PROFILE` | `profile` | Node profile (transaction/storage) |
| `CADRE_KEY_FILE` | `identity.keyFile` | Path to private key file |
| `CADRE_STORAGE_PATH` | `storage.path` | Data storage directory |
| `CADRE_STORAGE_TYPE` | `storage.type` | Storage type (memory/file) |
| `CADRE_HIBERNATION_ENABLED` | `hibernation.enabled` | Enable strand hibernation |
| `CADRE_SEED_TOKEN` | _(env only)_ | Bearer token gating `POST /seed`. **Unset = seed endpoint disabled**; when set, `POST /seed` requires `Authorization: Bearer <token>` |
| `CADRE_OWNER_KEYS` | _(env only)_ | Comma-separated base64url owner keys pinned as cold-start seed-trust anchors (unions with repeatable `--pin-owner-key`). A cold node (empty `OwnerKey` table) **rejects** `--seed` / `POST /seed` unless the seed's signer is pinned here or already DB-known. Independent of `CADRE_SEED_TOKEN`: bearer is the *delivery* gate, this is the *trust* anchor |

Environment variables override config file values.

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

| Deployment | Config | Keys | Strand Data |
|------------|--------|------|-------------|
| Systemd (dedicated user) | `/etc/cadre/cadre.yaml` | `/etc/cadre/cadre-peer.key` | `/var/lib/cadre/` |
| Development (regular user) | `./cadre.yaml` | `./cadre-peer.key` | `./data/` |
| Docker | Volume `/data/cadre.yaml` | Volume `/data/cadre-peer.key` | Volume `/data/storage/` |

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

