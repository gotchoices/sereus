description: A Cadre node's config now accepts native crypto for its encrypted connections and hands it to every libp2p node the Cadre node builds, so a phone can stop running slow pure-JavaScript crypto. Review the pass-through, its tests and its docs.
files:
  - packages/cadre-core/src/types.ts (`NetworkConfig.noiseCrypto`, after `transports`)
  - packages/cadre-core/src/cadre-node.ts (`buildControlNodeOptions`, spread beside `transports`)
  - packages/cadre-core/src/strand-instance-manager.ts (`buildStrandRuntime`'s `createLibp2pNode` call, spread beside `transports`)
  - packages/cadre-core/src/strand-network-config.ts (module comment: list of inherited fields)
  - packages/cadre-core/test/cadre-node-control-node-options.spec.ts
  - packages/cadre-core/test/strand-instance-manager-network-addrs.spec.ts
  - docs/reference-app-rn.md ("Phone (RN app) Configuration")
  - docs/architecture.md (`NetworkConfig` listing)
  - ../optimystic/packages/db-p2p/src/noise-crypto.ts, libp2p-node-base.ts (`NodeOptions.noiseCrypto`)
----

# cadre-core: `network.noiseCrypto` pass-through

## What changed

Context: gotchoices/sereus#13. React Native resolves `@chainsafe/libp2p-noise`'s browser build, which uses pure-JS crypto. On Hermes, which has no JIT compiler, that crypto dominates connection setup on a slow phone. Optimystic 1.3.0 added `NodeOptions.noiseCrypto` and re-exports `NoiseCryptoInterface` and `noisePureJsCrypto` from `@optimystic/db-p2p` and `/rn`.

- `NetworkConfig.noiseCrypto?: NoiseCryptoInterface` is a type-only import from `@optimystic/db-p2p`. It sits in `NetworkConfig` beside `transports` and `connectionGater`, the other fields cadre-core already passes to both kinds of node, so one setting covers all of a party's nodes on that machine. The doc comment gives the spread-and-override usage and says the wire protocol does not change.
- Control node: `...(network?.noiseCrypto && { noiseCrypto: network.noiseCrypto })` in `buildControlNodeOptions`.
- Strand nodes: the same spread in `buildStrandRuntime`. The value comes from the machine's `NetworkConfig` as-is, not through the `strandNodeAddrs` derivation.
- When unset, the key is absent from both option objects, so db-p2p passes `noise({ crypto: undefined })` and behaviour does not change.
- cadre-core does **not** re-export `NoiseCryptoInterface` / `noisePureJsCrypto`. Apps import them from `@optimystic/db-p2p`, which `reference-app-rn` already depends on directly (`^1.3.0`). A reviewer who wants them on cadre-core's surface can add a one-line re-export in `src/index.ts`.

## Tests added

- `cadre-node-control-node-options.spec.ts` → "forwards a configured noiseCrypto": `{ ...noisePureJsCrypto }` (the documented usage) reaches `buildControlNodeOptions()` by identity. The existing "network is entirely absent" test was extended to assert that `noiseCrypto` is absent too.
- `strand-instance-manager-network-addrs.spec.ts` → "hands the strand node the configured noiseCrypto, and omits the key when unset": a sentinel object reaches the mocked `createLibp2pNode` by identity, and a second start without it has no `noiseCrypto` key. That file mocks `@optimystic/db-p2p`, so it uses a cast sentinel rather than the real `noisePureJsCrypto`. The file's doc comment now notes that this field is inherited as-is, unlike the address fields the file otherwise covers.

These tests cover plumbing, which the testing rules would usually leave untested. The ticket asked for them, and a dropped spread fails silently: the phone would still work, just slowly.

## Validation run

- `yarn typecheck`, `yarn build` in `packages/cadre-core`: clean.
- `npx eslint` over the six touched source and test files: clean.
- `yarn test` in `packages/cadre-core`: 136 files, 2240 passed, 1 skipped (the skip was already there).

## Known gaps / for the reviewer

- **No real-handshake test in sereus.** Nothing here starts two nodes where one uses a custom `noiseCrypto` and checks that they connect. That behaviour belongs to optimystic's `libp2p-node-base` (`noise({ crypto: options.noiseCrypto })`), and the claim that the two sides interoperate rests on Noise itself. It could be added to `integration-tests` if the reviewer wants an end-to-end check.
- **Other node builders outside cadre-core do not take the option:** `packages/quereus-plugin-sereus/src/connect.ts` and `connect-browser.ts` call `createLibp2pNode` directly, and so does `packages/integration-tests/src/harness/test-party.ts`. The ticket was scoped to cadre-core. If the plugin's connect path runs on a phone, it would still use pure-JS crypto.
- **No app sets it.** Choosing and linking a native crypto library in `reference-app-rn` is a separate decision, as the ticket required. `docs/reference-app-rn.md` says the option is "not wired yet" and explains how to plug it in.
- The value is not validated. A partial object (for example one missing `generateX25519KeyPair`) would fail inside libp2p-noise at handshake time rather than at `start()`. The doc comment says the implementation must be complete, the TypeScript type enforces that for typed callers, and optimystic does not validate it either.
- Also edited: `tickets/backlog/bug-slow-peer-crypto-cost-diverges-into-retry-amplification.md` gained one sentence saying the option has landed on both sides and no app sets it yet, so that ticket no longer describes the pass-through as pending.
