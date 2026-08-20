----
description: Operators can set a public address for a node to advertise, but the setting is silently ignored and the node prints a warning saying so. The library it depends on gained support for this months ago, so the setting can now be made to work.
files: packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/strand-instance-manager.ts, packages/cadre-core/src/types.ts, packages/cadre-core/test/cadre-node-announce-addrs-warning.spec.ts, packages/cadre-core/test/cadre-node-control-node-options.spec.ts, packages/cadre-cli/src/config/types.ts, docs/architecture.md
repro: verified
----

# `network.announceAddrs` is dropped on the floor, and its "not supported" warning is stale

## Background

`NetworkConfig.announceAddrs` (`packages/cadre-core/src/types.ts:196`) lets an operator
name the addresses a node should advertise to peers, for the case where the node binds
one address and is reachable at another — a reverse proxy, a DNS front, a port-forwarded
NAT. It is settable three ways: in `cadre.yaml`, via the `CADRE_ANNOUNCE_ADDRS`
environment variable, and through the Docker entrypoint.

It has never done anything. `CadreNode.start()` prints a warning and moves on
(`packages/cadre-core/src/cadre-node.ts:637`):

```
network.announceAddrs is set but not yet supported (no upstream db-p2p option to apply it)
— this node will keep advertising its listen/relay addresses instead.
```

The doc comment on the field states the unblocking condition explicitly: *"Unblocked by
the `announce-addrs-option` request filed against `@optimystic/db-p2p`; wiring lands here
once this repo's dependency range moves to a version carrying it."*

**That condition has been met and nobody noticed.** `@optimystic/db-p2p` v0.24.0 ships
both `NodeOptions.announceAddrs` and `NodeOptions.appendAnnounceAddrs`
(`src/libp2p-node-base.ts`, declared around line 186 and applied to libp2p's
`addresses.announce` around line 488). Verified present at the v0.24.0 release commit
(`162a532`), and `packages/cadre-core/package.json:84` already depends on `^0.24.0`.

So the warning now tells operators something untrue, and a supported configuration
option stays inert.

## What to build

### 1. Wire the option through, on both node kinds

`buildControlNodeOptions` (`cadre-node.ts`, around line 1079) and the strand node's
`createLibp2pNode` call (`strand-instance-manager.ts`, around line 339) already forward
`listenAddrs`, `transports`, and `connectionGater` from `NetworkConfig` in the same
spread-when-present style. Add `announceAddrs` alongside them, on **both** paths — a
strand node behind a reverse proxy has the same need as the control node, and the two
already receive identical resolved listen addresses.

### 2. Add `appendAnnounceAddrs` to `NetworkConfig`

Upstream exposes two distinct fields and the difference matters here (see the footgun
below). Add `appendAnnounceAddrs?: string[]` to `NetworkConfig` and forward it the same
way. This is the field most operators actually want — it adds a publicly reachable
address *without* discarding everything else the node advertises.

### 3. Replace the warning with a narrower one

Delete the blanket warning. Replace it with one that fires **only** when `announceAddrs`
and `relayAddrs` are both non-empty, naming the consequence: a non-empty `announce` set
**replaces** the advertised set entirely in libp2p, so observed addresses and the
`/p2p-circuit` address earned from a relay reservation are dropped from it. A node
configured with both will stop being reachable through its relay — which is the exact
class of failure tracked in `control-node-circuit-address-not-learned`. Point the
operator at `appendAnnounceAddrs` in the warning text.

Keep it at exactly one `console.warn` in this library: the existing comment above the
current warning states that a *second* one must be routed through a `CadreNodeEvents`
entry instead. Replacing the one that exists honours that; adding a second does not.

### 4. Update every place that documents the field as unsupported

- `packages/cadre-core/src/types.ts` — the `announceAddrs` doc comment is a long paragraph
  about why this cannot work yet. Rewrite it: what it does, that a non-empty value replaces
  rather than extends, and when to reach for `appendAnnounceAddrs` or `relayAddrs` instead.
- `packages/cadre-cli/src/config/types.ts:54` and `:144` — both say "Accepted but not yet
  applied".
- `docs/architecture.md:956` — inline comment reads "accepted but NOT YET APPLIED (no
  upstream db-p2p option; warns at start)".

Do not hand-edit `dist/` — the stale copies under `packages/*/dist` are build output.

## Edge cases & interactions

- **Empty array means unset.** Upstream treats `announceAddrs: []` as "no announce
  override" (libp2p's own semantics). Forward `undefined` rather than `[]` so an empty
  config value cannot land as an explicit empty announce set.
- **`announceAddrs` + `relayAddrs` together.** The silent-reachability-loss case above.
  Warn; do not throw. An operator who genuinely wants only the announced address (a node
  whose relay slot is decorative) is expressing a valid, if unusual, intent.
- **`appendAnnounceAddrs` is ignored while `announceAddrs` is non-empty** — that is
  upstream's precedence, not ours. Say so in the doc comment; do not attempt to merge them
  locally.
- **Strand nodes inherit the same `NetworkConfig` as the control node**, exactly as they
  already do for `listenAddrs`. If both node kinds announce the same host address on
  different ports this is fine; if a deployment ever needs per-node announce addresses,
  that is a separate ticket, not a knob to invent here.
- **Malformed multiaddrs.** libp2p validates at construction and throws, so a typo becomes
  a node that fails to start rather than one that silently misbehaves. Confirm which of the
  two it is and state it in the doc comment.

## Tests

`packages/cadre-core/test/cadre-node-announce-addrs-warning.spec.ts` currently pins the
stale behaviour ("warns once at start when network.announceAddrs is set") and must be
rewritten, not deleted — the warning still exists, its trigger just narrows:

- `announceAddrs` alone → **no** warning.
- `announceAddrs` + `relayAddrs` → exactly one warning, naming both fields.
- `appendAnnounceAddrs` alone → no warning.

`packages/cadre-core/test/cadre-node-control-node-options.spec.ts` already asserts the
config-to-node-options mapping against a bare `new CadreNode`, without standing up libp2p.
Extend it: `announceAddrs` and `appendAnnounceAddrs` present in, and absent from, the
returned options as the config dictates — including the empty-array-means-unset case.

For the strand path, assert the same mapping wherever `strand-instance-manager`'s option
building is already covered; if it is only reachable through a real node start, say so in
the handoff rather than standing up a libp2p node for a field-forwarding assertion.

## Validation

```
yarn workspace @serfab/cadre-core test
yarn lint
```

## TODO

- [ ] Forward `announceAddrs` in `buildControlNodeOptions`
- [ ] Forward `announceAddrs` in the strand node's `createLibp2pNode` call
- [ ] Add `appendAnnounceAddrs` to `NetworkConfig` and forward it on both paths
- [ ] Narrow the `CadreNode.start()` warning to the `announceAddrs` + `relayAddrs` case
- [ ] Rewrite the `announceAddrs` doc comment in `cadre-core/src/types.ts`
- [ ] Update the two `cadre-cli/src/config/types.ts` doc comments
- [ ] Update `docs/architecture.md:956`
- [ ] Rewrite `cadre-node-announce-addrs-warning.spec.ts` for the narrowed trigger
- [ ] Extend `cadre-node-control-node-options.spec.ts` for both new fields
- [ ] `yarn lint` + `yarn workspace @serfab/cadre-core test` green
