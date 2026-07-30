---
description: Add automated tests proving that the settings someone configures for a cadre node — its identity key, storage, listening addresses, relay behaviour and so on — actually reach the networking layer, so a wiring mistake fails a test instead of surfacing as a mysterious runtime problem.
files: packages/cadre-core/src/cadre-node.ts, packages/cadre-core/test/cadre-node-control-replication.spec.ts, packages/cadre-core/test/cadre-node-control-node-options.spec.ts, packages/cadre-core/test/strand-instance-manager-cluster-size.spec.ts, packages/cadre-core/src/types.ts
difficulty: easy
---

# Test coverage: control-network node options

## What already exists (read this first — the plan ticket predates it)

The refactor this ticket's plan anticipated has **already landed**. `CadreNode.createControlNode()`
is now a one-liner over a private, pure mapping method:

```ts
// packages/cadre-core/src/cadre-node.ts:907
private async createControlNode(): Promise<Libp2p> {
  return await createLibp2pNode(this.buildControlNodeOptions());
}

private buildControlNodeOptions(): Parameters<typeof createLibp2pNode>[0] { … }
```

`buildControlNodeOptions` reads only `this.config` and `this.identityKey`. Calling it on a bare
`new CadreNode(config)` starts no libp2p node, opens no database, and touches no filesystem — so
the whole suite below is a pure unit test with no mocking of `@optimystic/db-p2p` at all. (The
strand-side spec, `strand-instance-manager-cluster-size.spec.ts`, has to mock `createLibp2pNode`
because `StrandInstanceManager` has no equivalent split; that's fine, don't change it.)

Four assertions already ride on that seam, but they live in the **wrong file** — the tail of
`packages/cadre-core/test/cadre-node-control-replication.spec.ts` (`describe('CadreNode
control-network node options')`, lines ~374-424), where they landed as a side-effect of the
re-replication ticket. They cover `clusterSize`, `clusterPolicy.allowDownsize`,
`clusterPolicy.assumedClusterSize` and `networkName`, and their header comment explicitly defers
the rest to this ticket's backlog slug.

So this ticket is: **give the seam its own spec file, move those four assertions into it, and
cover every remaining option.** No production change is required.

## The mapping under test

Every branch `buildControlNodeOptions` can take, and what each is for:

| Option | Source | Notes |
| --- | --- | --- |
| `port: 0` | constant | Ephemeral. A fixed port would collide between the control node and every strand node in the same process. |
| `bootstrapNodes` | `controlNetwork.bootstrapNodes` | Verbatim. |
| `networkName` | `` `control-${partyId}` `` | Already covered. |
| `storage` | `storage.provider` | Instance → passed through; factory → called with the literal `'control'`; absent → `undefined`. |
| `fretProfile` | `profile` | `'storage'` → `'core'`, else `'edge'`. |
| `relay` | `network.enableRelay ?? (profile === 'storage')` | `??`, so an explicit `false` on a storage node wins. |
| `clusterSize` | `CONTROL_REPLICATION_BREADTH` | Fixed. Already covered. |
| `clusterPolicy` | `{ allowDownsize: true, sizeTolerance: 0.5 }` | `allowDownsize` covered; `sizeTolerance` is not. |
| `arachnode.enableRingZulu` | `profile === 'storage'` | |
| `privateKey` | `this.identityKey` | Conditionally spread — the key is **absent from the object**, not set to `undefined`, when no identity resolved. |
| `transports` | `network.transports` | Conditionally spread. |
| `listenAddrs` | `network.listenAddrs` | Conditionally spread. `[]` is truthy in JS, so an explicit empty array **is** forwarded — that is the React Native case ("this node cannot listen"), and silently dropping it would fall back to the default TCP listen addr. |
| `connectionGater` | always constructed | `createMembershipConnectionGater(<membership policy>, network.connectionGater)`. |
| `authorizeInboundStream` | always constructed | Closure over the private `authorizeInboundControlStream`. |

`this.identityKey` is populated by the private `async resolveIdentityKey()`, which reads only
`config.keyStore` / `config.privateKey` — no network, no libp2p. A test can therefore
`await resolveIdentityKey()` and then call `buildControlNodeOptions()` and stay pure.

Identity **resolution semantics** (keyStore-vs-privateKey precedence, first-run generation,
corrupt bytes, the mutually-exclusive error) are already thoroughly covered by
`packages/cadre-core/test/cadre-node-identity.spec.ts` — do **not** duplicate them. This ticket
only asks the narrower question: *does the resolved key reach the node options, and is the field
omitted when there is none?*

## Design decisions (settled — do not re-litigate)

- **New file, moved assertions.** Create `packages/cadre-core/test/cadre-node-control-node-options.spec.ts`
  and move the existing `describe('CadreNode control-network node options')` block into it verbatim.
  Delete that block from `cadre-node-control-replication.spec.ts`, along with the imports it leaves
  unused there (the `createLibp2pNode` type-only import, `CONTROL_REPLICATION_BREADTH`,
  `DEFAULT_STRAND_CLUSTER_SIZE`). The replication spec keeps its own `createConfig` helper — the new
  file gets its own; a two-field config factory is not worth a shared test util.
- **Reach the private methods with one typed accessor per method**, following the cast pattern
  already used throughout `cadre-node-*.spec.ts`. Do not widen `buildControlNodeOptions` /
  `resolveIdentityKey` to `public` or add a test-only export; the existing header comment on
  `buildControlNodeOptions` states the split is for assertability and that its only production
  caller is `createControlNode` — keep that true.
- **Don't re-test the gater's internals.** `packages/cadre-core/test/membership-connection-gater.spec.ts`
  owns composition semantics (deny-from-either on inbound, pass-through elsewhere). Here assert only
  that a gater is *always* installed and that a caller-supplied hook survives into it — i.e. the
  wiring, not the policy.
- **Do not pin the dead `announceAddrs` / `relayAddrs` fields.** `NetworkConfig` declares them and
  cadre-cli even plumbs env vars into them, but nothing forwards them and Optimystic's `NodeOptions`
  has no such fields. Writing an assertion that they are ignored would cement the bug. It is filed
  separately as `backlog/bug-cadre-network-announce-relay-addrs-ignored`; reference that slug in the
  new spec file's header comment and move on.

## Edge cases & interactions

Each of these is a test the reviewer will look for:

- **`enableRelay: false` on a `profile: 'storage'` node** → `relay === false`. The mapping uses `??`,
  not `||`; a `||` regression would silently re-enable the relay server on exactly the nodes an
  operator explicitly disabled it for.
- **`enableRelay: true` on a `profile: 'transaction'` node** → `relay === true` (opt-in overrides the
  profile default in the other direction too).
- **`network` object entirely absent** → `relay` still resolves from the profile; `transports` and
  `listenAddrs` are absent from the options object; `connectionGater` and `authorizeInboundStream`
  are still present.
- **`listenAddrs: []`** → forwarded as `[]`, not omitted. Assert `'listenAddrs' in options` is true
  *and* the value is `[]`. This is the RN configuration.
- **`storage.provider` as a factory** → called exactly once, with `'control'`. Assert the argument,
  not just that the result landed: the argument is what keeps control storage from colliding with a
  strand's.
- **`storage.provider` as an instance** → same object identity reaches `options.storage` (no wrapping).
- **`storage` absent** → `options.storage === undefined`.
- **No identity configured** (neither `keyStore` nor `privateKey`, `resolveIdentityKey` already run)
  → `'privateKey' in options` is `false`. libp2p then generates an ephemeral key; an explicit
  `privateKey: undefined` would be equivalent today but the omission is the documented intent.
- **`config.privateKey` set** → after `resolveIdentityKey()`, `options.privateKey` is that same key
  object (identity comparison, not a re-derivation).
- **`keyStore` set** (use `InMemoryKeyStore` from `packages/cadre-core/src/key-store.ts`) → after
  `resolveIdentityKey()`, `options.privateKey` equals `node.identityKey`, and a second
  `buildControlNodeOptions()` returns the *same* key (the mapping must not regenerate per call).
- **Calling `buildControlNodeOptions()` twice** → two distinct objects (it builds fresh each call),
  but equal on every scalar field. Guards against someone caching a mutable object into a field.
- **`bootstrapNodes` non-empty** → forwarded element-for-element. Also assert the *empty* case
  produces `[]` and not `undefined`; `createLibp2pNode` requires the field.
- **`network.connectionGater` supplied** → `options.connectionGater` is defined and is **not** the
  same object the caller passed (it is composed, so a caller gater passed through untouched would
  mean the membership gate was dropped). Then drive one non-inbound hook — e.g.
  `denyDialMultiaddr` — through the composed gater and assert the caller's implementation ran.
- **`network.connectionGater` absent** → `options.connectionGater` is still defined (the membership
  gate is not optional).
- **`authorizeInboundStream` present and delegating** → it is a function; invoking it for an
  arbitrary peer id on a not-yet-started node returns `true` (the "not running / no control DB"
  unconditional admit in `admitControlPeerUnconditionally`). That is enough to prove the closure is
  bound to the node; the gate's real policy is owned by
  `packages/cadre-core/test/control-stream-authorization.spec.ts`.
- **`profile: 'transaction'`** → `fretProfile === 'edge'` and `arachnode.enableRingZulu === false`;
  **`profile: 'storage'`** → `'core'` / `true`. Both directions, so a swapped ternary fails.
- **`sizeTolerance`** → `0.5`. Pair the assertion with a one-line comment on why it exists alongside
  `allowDownsize` (a 16-wide target is never satisfiable by a real 2-7 node party).

## TODO

- Create `packages/cadre-core/test/cadre-node-control-node-options.spec.ts` with a header comment
  explaining the seam (`buildControlNodeOptions` is pure; no libp2p node is started), a local
  `createConfig(overrides)` factory, and typed private accessors for `buildControlNodeOptions` and
  `resolveIdentityKey`.
- Move the four existing assertions out of `cadre-node-control-replication.spec.ts` into the new
  file; delete the block and its now-unused imports from the replication spec, and drop the
  "Partial coverage on purpose … tracked by `backlog/debt-cadre-node-control-network-wiring-test`"
  sentence from the moved comment (the deferral is now discharged).
- Cover the identity branches: `config.privateKey`, `keyStore` (via `InMemoryKeyStore`), and the
  ephemeral path's field omission.
- Cover storage: factory (assert the `'control'` argument), instance passthrough, absent.
- Cover profile-derived options: `fretProfile` and `arachnode.enableRingZulu`, both profiles.
- Cover `relay`: profile default both ways, plus explicit `true`/`false` overriding each default.
- Cover `listenAddrs` (including the empty-array RN case), `transports`, and their omission when
  `network` is absent.
- Cover `bootstrapNodes` (populated and empty), `port`, and `clusterPolicy.sizeTolerance`.
- Cover `connectionGater` (always present, composed, caller hook honored) and
  `authorizeInboundStream` (present, bound, admits on a not-started node).
- Update the doc comment on `buildControlNodeOptions` in `packages/cadre-core/src/cadre-node.ts:911`
  so it names the new spec file instead of `cadre-node-control-replication.spec.ts`.
- Run `yarn workspace @serfab/cadre-core test 2>&1 | tee <scratchpad>/cadre-core-test.log` and
  `yarn lint` from the repo root; both must pass.
