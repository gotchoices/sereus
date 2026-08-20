---
description: A node's identity key file has no way to prove it wasn't corrupted. If a single byte inside it changes, the node still starts, but as a different node — and nothing notices until other machines stop recognising it.
files: packages/cadre-cli/src/config/loader.ts, packages/cadre-cli/src/commands/enroll.ts, packages/cadre-host/src/installer/identity.ts, packages/cadre-host/src/orchestrator/node-identity.ts
prereq: collapse-cli-identity-key-file-formats
severity: wrong-result
likelihood: unusual
tradeoffs: Bit-rot on a small file is rare, and the fix means either a second file to keep in sync or a format change to the key file itself — a maintainer could reasonably decide the failure is too unlikely to be worth either.
---

# An identity key file cannot be told apart from a corrupted one

## What this is about

Every node has a private key file that determines its network identity — the `PeerId` that other
machines know it by. The file is a small binary blob: a short header saying "this is an Ed25519
key", then 64 bytes of key material.

The header is checked. **The 64 bytes are not.** There is no checksum over them, and no copy of the
expected `PeerId` to compare against. So if one byte inside that payload changes — bit rot, a bad
sector, a truncated copy that happens to land on the right length, a half-finished write — the file
still parses, the node still starts, and it comes up as a *different node*. The operator sees no
error. What they eventually see is peers no longer recognising the machine, membership rows pointing
at an identity that no longer exists, and relay reservations going stale.

## Why it is filed separately

`collapse-cli-identity-key-file-formats` removes a much bigger version of this problem: a decoder
that would fall back to accepting *any* 64 bytes as a key, so even a plainly truncated file produced
a working-but-wrong identity. After that change every kind of *structural* damage is rejected —
measured, with the resulting errors recorded in that ticket.

What survives is the narrow case: damage confined to the payload, which is opaque by construction.
That is a real gap, not a hypothetical one, but closing it needs a design decision rather than a
deletion, which is why it is not folded into that ticket.

There is a `NOTE:` at the decode site in `config/loader.ts` recording this and pointing here, so a
future reader meets the limitation where it lives rather than rediscovering it.

## The material already exists to fix this

`cadre enroll create` already writes a second file next to the key — `<name>.id`, containing the
`PeerId` in text. cadre-host's `IdentityRecord` already carries `peerId` alongside the private key.
Nothing currently *checks* the loaded key against either.

Rough shapes, in increasing order of intrusiveness:

- **Verify against the companion `.id` file when one is present.** Cheapest, no format change,
  degrades gracefully when the file is absent. Weakness: two files to keep together, and a copy
  operation that grabs only the key silently loses the check.
- **Have the operator pin the expected `PeerId` in config** (`identity.expectedPeerId`). Explicit,
  survives file moves, and doubles as a guard against pointing a node at the wrong key file
  entirely. Weakness: another config key — and reducing the number of identity config keys is
  precisely what the prerequisite ticket is for, so this needs a good argument.
- **Wrap the key file in an envelope carrying a checksum.** Strongest, but it is a format change to
  a file three separate writers produce, immediately after a ticket that just unified that format.

The first two are additive and could ship together. The third should not be attempted without a
reason the first two are insufficient.

## What a fix needs to establish

- A node whose key file has one flipped payload byte refuses to start, naming the file and the
  mismatch, rather than starting under a different identity.
- A node whose key file is intact starts exactly as before, with no new required configuration.
- Whatever check is added does not itself become a new way to fail: a missing or stale companion
  record must not brick a node that has a perfectly good key.
- All three identity writers stay consistent — `enroll create`, cadre-host's installer, and the
  per-node identity the orchestrator writes for donated nodes.
