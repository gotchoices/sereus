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
npm install
npm run build -w @serfab/cadre-core -w @serfab/cadre-cli
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
npm install
npm run build -w @serfab/cadre-core -w @serfab/cadre-cli
sudo systemctl restart cadre-node  # if running as service
```

## Usage

### Start a Node

```bash
cadre start -c cadre.yaml
cadre start -c cadre.yaml --debug
```

### Check Status

```bash
cadre status -c cadre.yaml
cadre status --json
```

### Enroll New Peers

Create a new peer identity:

```bash
cadre enroll create --output ./keys --name my-node
```

Register a peer (requires authority signature):

```bash
cadre enroll register \
  --peer-id 12D3KooW... \
  --bootstrap /ip4/.../tcp/4001/p2p/12D3KooW... \
  --authority-key <public-key> \
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
| 8080 | Health endpoint (`/health`, `/ready`, `/status`) |
| 9090 | Prometheus metrics (`/metrics`) |

Open port 4001 in your firewall:

```bash
sudo ufw allow 4001/tcp comment "Sereus libp2p"
```

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
sudo git clone https://github.com/anthropics/sereus.git /opt/sereus
cd /opt/sereus
sudo npm install
sudo npm run build -w @serfab/cadre-core -w @serfab/cadre-cli
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

See [docker/README.md](./docker/) for Docker Compose deployment, or use:

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

