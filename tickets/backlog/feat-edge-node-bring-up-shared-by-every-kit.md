description: The phone kit's node bring-up (lifecycle queue, edge config, bounded owner genesis, node-local slots, strand re-attach) is platform-neutral but lives in `@serfab/cadre-rn`, so the web and NativeScript reference apps re-implement it and have drifted. Move it into one shared `createEdgeNode(platform)` that all three use (GitHub #45).
architecture: docs/architecture.md
files: packages/cadre-rn/src/phone-node/node.ts, packages/cadre-rn/src/phone-node/config.ts, packages/cadre-rn/src/phone-node/options.ts, packages/reference-app-web/src/lib/cadre-web.ts, packages/reference-app-web/src/lib/store.svelte.ts, packages/reference-app-ns/src/cadre-phone.ts, packages/reference-app-ns/src/start-options.ts, packages/reference-app-ns/src/node-local-slots.ts
tradeoffs: A storage-neutral platform interface (KeyStore, `rawStorage(scope)`, a node-local slot factory) replaces `rn-leveldb`'s constructors as the one React Native tie; `createPhoneNode` stays as a thin wrapper so RN apps see no API change.
----

# One edge-node bring-up for every kit

Proposed by kjeib in gotchoices/sereus#45, with a table of the three copies. Verified at 70b2dc1d:

- **cadre-rn** (`phone-node/node.ts`, `config.ts`): transition queue (`inTurn`, `trackStop`, `trackStart` ~568-600), failed-start cleanup (`buildAndStart` ~604-625), subscriptions re-attached to each rebuilt node before `start()` (~534-545, 628-638), relays through `network.relayAddrs` with `requireRelay: false` (~70-84), owner genesis bounded at 60 s (~113-194, with a NOTE that the bound belongs in cadre-core).
- **reference-app-web** (`cadre-web.ts`): no in-flight start tracking (`node` is assigned before `start()` resolves, ~531-533); `reserveRelays` reaches the control node only (~488-541); owner genesis unbounded (~605-631). Failed-start cleanup does exist (~365-371, `stopCadre`), and `store.svelte.ts` re-subscribes to each new node, but only after its start resolves, so events during a start are missed.
- **reference-app-ns** (`cadre-phone.ts`): no owner genesis; dials out through relays (`circuitRelayTransport`) but reserves none, so it is not reachable through one; plaintext identity in SQLite; no failed-start cleanup (~265-266, NOTE ~328-333); a start during a stop is unhandled (NOTE ~310-314).

## Sequencing

`implement/1.08-phone-and-web-kits-hold-a-separate-owner-key` rewrites owner genesis in the kit and the web app (a shared `owner-key-flows.ts`). Do this after the owner-key series, so it moves the new genesis rather than the one being replaced. It also covers `backlog/debt-web-app-repeats-the-phone-kit-join-sequence` (join, move and dissolve); fold that ticket in.

## Shape

As #45 proposes: the platform supplies identity (`KeyStore`), storage (`rawStorage(scope)` plus a node-local slot factory), transports (given the relays), optional Noise crypto, `dataVersion` and `configure`. Parameters, not flattening, for: the web tab's `/p2p-circuit` + `/webrtc` listen addresses and WebRTC transports; no secure store in browsers (and NativeScript, for now). The owner-genesis bound moves into cadre-core.
