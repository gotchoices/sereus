## Keys, Peer IDs, and backups

### What matters
- In libp2p, a node’s **Peer ID** is derived from its **private key**.
- If the private key changes, the Peer ID changes.
- For infrastructure peers (relay/bootstrap), you generally want the Peer ID to be **stable**.

### Standard practice for ops
- **Generate on first start**, and **persist to disk**.
- Back up the persisted key material as part of standard server backups.

### In this repo’s reference implementations
The node will:
- create a libp2p private key on first start (if missing)
- write it to a key file under its data directory

As long as the key file persists across restarts/upgrades, the Peer ID is stable.

### Docker (site directory method)
- `./data/` is bind-mounted into the container as `/data`
- default key file is `/data/libp2p-private.key.pb` (inside the container)

Do not delete `./data/` unless you intentionally want a new Peer ID.

### systemd / bare server
Same principle:
- store key material in a durable path (e.g. `/srv/sereus-ops/<service>/data/`)
- (optional) point the service at it via env vars if you aren’t using the default paths

### Backup / restore
- Backup: archive the directory that contains the key file (often the whole `data/` directory).
- Restore: put it back before starting the service; the Peer ID will match.


