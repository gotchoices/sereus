## systemd: libp2p Relay (bare server, no Docker) — scaffold

This is a **bare-bones scaffold** to preserve the pattern for non-Docker deployments.

Intent:
- A site instance directory (e.g. `/srv/sereus-ops/relay`) holds **env + data**
- The repo clone holds **code**
- `systemd` manages start-on-boot and restarts

Shared ops guidance (applies to Docker and systemd):
- `../../docs/keys.md`
- `../../docs/dnsaddr.md`

### What you would do (high level)
1) Create an ops root (example):
   - `/srv/sereus-ops/repo` (git clone)
   - `/srv/sereus-ops/relay` (instance: `env.local`, `data/`)

2) Build the relay node app from the repo:
   - Current reference implementation lives at `sereus/ops/docker/relay/` (it’s a Node.js libp2p app)

3) Install a systemd unit that:
   - runs the app
   - points at your `env.local`
   - uses `data/` for key persistence

### Files
- `sereus-relay.service.template`: example unit file template

### Not implemented yet
- An installer subcommand (`./sereus/ops/scripts/install systemd relay ...`)
- A stable “node-apps” location shared by docker + systemd (see STATUS TODOs)


