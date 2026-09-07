description: The relay container every phone connects through runs a whole major version of the networking library behind the software that talks to it. It probably works — the wire protocols are versioned separately — but nobody has checked, and a phone reaching a partner has no route except this relay.
files:
  - ops/docker/libp2p-infra/package.json (the container's own dependency set — `libp2p ^2.9.0`)
  - ops/docker/libp2p-infra/src/main.ts (`createLibp2p` call: transports, encrypters, muxers, `circuitRelayServer`)
  - ops/docker/libp2p-infra/src/env.ts (the doc comment that records the skew as a deliberate choice)
  - ops/test/check-node.mjs (the existing node-reachability check — the natural place to hang a real interop assertion)
difficulty: medium
tradeoffs: libp2p's wire protocols are versioned independently of its npm package majors, so this very likely already works and the check may only ever confirm that — a maintainer could reasonably call it ceremony and wait for a failure to justify it.
----

# The relay container is a full libp2p major behind everything that dials it

## The gap

`ops/docker/libp2p-infra` is a standalone deployable with its own dependency tree. It is not built
against the workspace, which is deliberate and right — it is a pure relay/bootstrap with no database
in it, so making it depend on `@optimystic/db-p2p` would drag the whole storage stack into an image
that never uses it. `src/env.ts` says so in a comment, and mirrors the multiaddr validation rules
rather than importing them, for exactly that reason.

The cost of that choice is a version skew nobody is currently watching:

| package | relay container | `@optimystic/db-p2p` (what dials it) |
| --- | --- | --- |
| `libp2p` | `^2.9.0` | **`^3.1.3`** |
| `@libp2p/websockets` | `^9.0.0` | **`^10.1.3`** |
| `@libp2p/circuit-relay-v2` | `^3.0.0` | `^4.1.3` |
| `@libp2p/tcp` | `^10.1.18` | `^11.0.10` |
| `@libp2p/identify` | `^3.0.38` | `^4.0.10` |
| `@chainsafe/libp2p-noise` | `^16.1.4` | `^17.0.0` |
| `@chainsafe/libp2p-yamux` | `^7.0.4` | `^8.0.1` |

The container's set is internally consistent — that is not the concern. The concern is that every
one of those pairs is a major apart from its counterpart on the other end of the connection, and no
test anywhere puts a libp2p-3 client through this libp2p-2 relay and asserts a working circuit.

## Why this is probably fine, stated honestly

libp2p versions its **wire** protocols separately from its npm packages: `/libp2p/circuit/relay/0.2.0`,
`/noise`, `/yamux/1.0.0`, `/ipfs/id/1.0.0` are the negotiated identifiers, and a package major bump
usually reflects a TypeScript API change rather than a protocol change. So the expected outcome of
the check below is "it works". This ticket is not a claim that anything is broken.

## Why it is worth checking anyway

Two reasons, and the second is the one that moved it out of "someday".

**We have already been bitten by exactly this class.** `gotchoices/Optimystic#9`:
`@chainsafe/libp2p-gossipsub@14` paired with `libp2p@3`, where the outbound stream path still assumed
the libp2p-2 duplex `Stream` — so **every** outbound gossipsub stream threw
`fns.shift(...) is not a function`. That is a package-major mismatch producing a runtime failure with
no build-time signal, in this same dependency family, and it was found in the field rather than by a
test.

**This relay is now load-bearing for a topology we have committed to.** Upstream settled the design
question of whether small cadres are supported: they are, and the expected growth path is one phone,
then a second machine as a backup, or pairing directly with another member's cadre — which may itself
be a single phone. **Two phones cannot dial each other. That pairing exists only over a relay.** So a
silent interop failure here does not degrade a corner case; it removes the only route one of the
supported topologies has. See `../optimystic/tickets/plan/1-small-cadres-are-a-first-class-topology`.

## What a useful check looks like

Not a unit test of the container's own config — that would pass regardless. It needs a real
`@optimystic/db-p2p` node, on the workspace's libp2p 3, driven against the built container image:

- A libp2p-3 client **dials** the container over `/ws` and completes identify.
- It **obtains a circuit-relay reservation**, and the reservation is unlimited (this is where
  `RELAY_APPLY_DEFAULT_LIMIT=false` earns its keep — a limited reservation is a different failure and
  must not be mistaken for this one).
- A second libp2p-3 client **reaches the first through that reservation**, and a real optimystic
  protocol stream carries data both ways — not just a connection opening. Optimystic#9's failure was
  on the *outbound stream* path, so a check that stops at "connected" would have passed while the
  thing was broken.
- The same over raw TCP, so a failure can be attributed to the WebSocket path or not.

`ops/test/check-node.mjs` already exists for node reachability and is the obvious host for this.

## The other half of the decision

If the check fails, the fix is not automatically "upgrade the container". Bumping it to libp2p 3
means re-verifying `circuitRelayServer` v4's reservation semantics against what the site stacks
configure, and the whole point of the standalone tree is that it can move on its own schedule. The
alternative — having the container consume the workspace's libp2p through a thin shared package —
trades the skew for a build-time coupling this image was deliberately built to avoid. Whoever picks
this up should decide that deliberately rather than reaching for the version bump.

## Related

- `gotchoices/Optimystic#9` — the same class, found in the field.
- `../optimystic/tickets/backlog/3-debt-libp2p-interface-version-drift-guard` — the upstream guard for
  drift *within* that workspace. It does not and cannot see this container, which is outside it.
- `ws-listener-unreachable-outside-container` (complete) — the work that made this relay reachable
  from a phone at all, and therefore made this skew matter.
