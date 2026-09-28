description: Port the reporter's reproduction of "two phones stop syncing after a restart" into the integration suite, prove it fails without the new address book and passes with it, and run it once as two separate processes.
prereq: cadre-core-remembers-joined-strands, strand-peer-book-swap
architecture: docs/testing.md#topology-coverage-map
files: packages/integration-tests/src/scenarios/strand-relay-only-restart-reconverges.integration.ts, packages/integration-tests/src/harness/dedicated-relay.ts, packages/integration-tests/src/harness/block-store-probe.ts, packages/integration-tests/src/harness/node-fixtures.ts, docs/testing.md, docs/strands.md, docs/architecture.md, .release-notes.pending.md
difficulty: medium
----

## Why

Maintainer decision (2026-09-27), items 5 and 6. gotchoices/sereus#18 is a pure-Node reproduction: two relay-only parties form a closed strand, a control write crosses in about 2.5 s, both `CadreNode`s are destroyed and rebuilt over the same storage, both re-attach and report `active`, and a post-restart write never crosses (3 of 3 runs, 180 to 600 s budgets, cadre-core 1.5.0 and 1.6.0). The suite never had a scenario that restarts over persisted storage on the cross-party relayed shape: `strand-reattach-first-sync-measure` is opt-in and same-node re-attach, `control-offline-read-after-restart` is control-plane only.

## The scenario

`strand-relay-only-restart-reconverges.integration.ts`, built from the pieces `blind-relay-phone-to-phone-e2e` and `strand-reattach-first-sync-measure` already use:

1. `startDedicatedRelay()`; two parties A and B, each `controlNodeConfig({ listenAddrs: [], relayAddrs: [relay.dialAddr], privateKey: <fixed key>, storageProvider: captureRawStorage().provider, … })`. The identity key and the storage capture are created once per party and reused for the rebuilt node; that reuse is the whole point. Each party also gets a persistent `strandPeers.store` (`PersistentStrandPeerBookStore` over an in-memory `DurableSlot` object kept outside the node, or a `FileStrandPeerBookStore` in a temp dir) and a `joinedStrands.store` over an `InMemoryKeyStore` instance kept outside the node, so both survive the rebuild the way a phone's storage does.
2. A founds a closed strand and publishes a bound invitation; B `formStrand`s and attaches (no hand-dial, as in the blind-relay scenario). **Phase 1**: B reads A's first row.
3. **Control**: A writes a second row before any restart; B must read it within the gate. This is what makes phase 2's failure meaningful.
4. Stop both nodes (B first, then A, mirroring the reattach scenario's order), then build two NEW `CadreNode`s over the same keys, storage providers and stores. Subscribe to `strand:discovered` on both and claim with `addStrand` (A's row comes from its control DB; B's from the remembered join, with no app-side list). Both strands must reach `active`.
5. **Phase 2**: A writes a third row; B must read it within the gate. Then B writes and A must read it, so the direction that depends on A's book is covered too.
6. Assert, after phase 2, that each party's peer book holds a signed entry for the other's strand peer id (the swap happened), and that every A↔B strand connection classifies `relayed` (`summarizeConnectionPaths`), as the blind-relay scenario does.

Gate budgets: the blind-relay scenario's 60 s per gate is the starting point; a relayed re-attach measured about 150 s on 1.6.0 (see `DEFAULT_STRAND_FIRST_SYNC_TIMEOUT_MS`), so give the post-restart `active` and phase 2 gates that headroom and log the elapsed times on a `[RESTART]` prefix the way `strand-reattach-first-sync-measure` logs `RESULT` lines.

**It must fail before the fix.** Do not stash or revert. Run the scenario once with both parties' `strandPeers.store` left at the in-memory default (it dies with the rebuilt node, which is exactly the pre-fix state) and `joinedStrands` still persistent, and confirm phase 2 does not converge within its budget; record the run's output shape in the handoff. Then run with the persistent book and it must pass. Keep the negative arm as an opt-in (`RESTART_NEGATIVE_CONTROL=1`) rather than a default test, since it costs the full phase 2 budget to fail.

**Two OS processes.** The reporter's caveat is that a one-process restart keeps module state. Add an opt-in arm (`RESTART_TWO_PROCESS=1`, `describe.runIf`) that runs each party in a child `node` process: the parent starts the relay and a temp dir, spawns a party script per side (an ESM `.mjs` in `packages/integration-tests/src/harness/`, importing the built `@serfab/cadre-core` like the child-process orchestrators' consumers do), coordinates phases over `process.send` IPC, kills both children after the control step, respawns them over the same temp dir, and asserts phase 2 from the parent. `FileStrandPeerBookStore`, a `FileKeyStore`-backed joined-strand store and `FileRawStorage` from `@optimystic/db-p2p-storage-fs` give real on-disk persistence. Run it once locally and report the result in the handoff; if it cannot be made to run inside the runner's idle timeout, keep it opt-in and document how to run it in `docs/testing.md`. Do not leave temp dirs behind.

## Edge cases & interactions

- **Stop order and in-flight writes.** Stopping A while B's write drains can leave a torn commit (`tickets/.pre-existing-known.md` describes the same class on the control plane). Stop B first, wait for the control write to be read, then stop A. Inspection.
- **Storage capture and a strand's warm cache.** `captureRawStorage` returns the same `IRawStorage` per scope for the capture's lifetime; a rebuilt node asks the provider again and gets the same instance, so the "restart" reopens live in-memory stores rather than files. That is a one-process artefact and is why the two-process arm exists; say so in the file header.
- **Relay reservation re-established before the strand dials.** `addStrand` awaits the first relay attempts; the book dial then goes through `/p2p-circuit`. If phase 2 converges only after a minute, check whether the first dial happened before the reservation landed and note it as a finding rather than raising the budget silently.
- **The remembered join carries `Type: 'c'` and the key.** The RN handler change from the sibling ticket is not involved here, because the scenario subscribes to `strand:discovered` itself.
- **Parallel suite load.** A 300 s budget under 6-way parallel vitest can flake; measure five isolated runs and two under `yarn workspace @serfab/integration-tests test`, and report.

## Docs (item 6 of the maintainer decision)

- `docs/testing.md` → "Topology coverage map": add the shape "cross-party, relay-only, restart over persisted storage", naming this scenario and the opt-in arms.
- `docs/strands.md`: the "how a restarted machine re-finds its strand's peers" paragraph should now end with a pointer to this scenario as the proof; check that the paragraphs the two book tickets wrote read as one story.
- `docs/architecture.md` → "Relay Integration" relayed-shapes list: add this scenario beside `blind-relay-phone-to-phone-e2e`.
- `.release-notes.pending.md`: gather the bullets the four preceding tickets added under one heading naming gotchoices/sereus#18, written for the reporter: what a restarted node now does, what an embedder must inject (`strandPeers.store`, and a `keyStore` or `joinedStrands.store`), and that the relay warning is gone.

## TODO

- Scenario file with phases 1, control, restart, 2, and the book/relayed assertions; negative-control opt-in; two-process opt-in with child scripts and temp-dir cleanup.
- Run: the default arm five times isolated and once in the full integration run; the negative arm once; the two-process arm once. Foreground, no redirection; `tee` into `tickets/.logs/` only if you need to grep.
- Docs and the consolidated release note.
