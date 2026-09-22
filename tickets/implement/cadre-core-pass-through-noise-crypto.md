description: Let an app give a Cadre node native crypto for its encrypted connections, so a phone stops running slow pure-JavaScript crypto. Optimystic has added the option; sereus only needs to pass it through. Waits on optimystic publishing it.
files:
  - packages/cadre-core/src/types.ts (node config: add the option)
  - packages/cadre-core/src/cadre-node.ts (`buildControlNodeOptions`, ~line 1606)
  - packages/cadre-core/src/strand-network-config.ts and strand-instance-manager.ts (strand node options)
  - ../optimystic/packages/db-p2p/src/libp2p-node-base.ts (`NodeOptions.noiseCrypto`, ~line 422; used ~line 638)
  - ../optimystic/packages/db-p2p/src/noise-crypto.ts (`NoiseCryptoInterface`, `noisePureJsCrypto`)
----

# cadre-core: pass `noiseCrypto` through to every node it builds

## Unblocked

Optimystic 1.3.0 (db-core and db-p2p included) is on npm and exports `NoiseCryptoInterface` and `noisePureJsCrypto` from `@optimystic/db-p2p` and `/rn`. Sereus floors are already `^1.3.0`.

## Why

gotchoices/sereus#13: React Native resolves `@chainsafe/libp2p-noise`'s browser build, which is pure-JS crypto on Hermes, with no JIT. At the Galaxy S7's measured cost this dominates connection setup. See `backlog/bug-slow-peer-crypto-cost-diverges-into-retry-amplification`.

## Do

- Add `noiseCrypto?: NoiseCryptoInterface` to the Cadre node config (types re-exported from `@optimystic/db-p2p`, including `/rn`), with a doc comment. It must be a complete implementation. The usual pattern is to spread `noisePureJsCrypto` and override hashing and ChaCha20-Poly1305. When it is unset, nothing changes.
- Pass it to the control node (`buildControlNodeOptions`) and to every strand node. One setting should cover all of a party's nodes, because every node pays the handshake.
- Tests: extend `cadre-node-control-node-options.spec.ts` (the option reaches the control node's options, and is absent when unset) and the equivalent for strand node options.
- Docs: a line in the RN reference app or cadre-core docs on plugging in native crypto. Wiring an actual native library into `reference-app-rn` is a separate decision; don't do it here.
