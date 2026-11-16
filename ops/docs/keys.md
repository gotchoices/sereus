# The relay's identity key

A relay's peer ID is derived from its private key, and the key file is the only state a relay keeps. This page says where the key is, why it must not change, and how to back it up and restore it.

Related: [relay runbook](../docker/README.md) · [DNSADDR records](dnsaddr.md)

## Why the peer ID must stay the same

Every address for the relay ends in `/p2p/<PEER_ID>`: the DNSADDR records, the relay address each node is configured with, and the `/p2p-circuit` addresses that nodes behind NAT hand to their peers. A relay that starts with a different key has a different peer ID, and none of those addresses reach it until the records and every node's configuration are changed.

## Where the key is

The relay stores an Ed25519 private key in `libp2p-private.key.pb` under its data directory (`DATA_DIR`, `/data` in the container). With the Docker stack, `/data` is the instance directory's `data/` on the host (`HOST_DATA_DIR`).

The file holds the private key unencrypted. Restrict access to the data directory and to its backups.

## When a key is generated

The relay generates a key only when the key file does not exist, which is the case on first start. It logs `generated a new identity key` with the file's path.

A key file that exists but cannot be read or decoded stops the relay with an error that names the file. Causes include a volume that did not mount, a changed permission and a truncated copy. The relay does not start under a new peer ID in that case, because no operator would be told that the peer ID had changed. Restore the file from backup; do not delete it.

Deleting the data directory gives the relay a new peer ID on its next start. Do that only when a new peer ID is intended.

## Backup and restore

- **Back up** the data directory, or the key file alone, with the server's normal backups.
- **Restore** by putting the file back at the same path before starting the relay. The peer ID then matches the one already published.

`./svc down`, rebuilding the image and updating the clone do not touch the key.
