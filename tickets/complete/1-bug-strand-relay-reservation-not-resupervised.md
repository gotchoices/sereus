description: A shared workspace's node used to lose its relay address for good whenever the relay connection dropped, and also about two hours after reserving with no network change at all; workspace nodes now run the same keep-it-alive loop the main node has, one per configured relay, so they stay reachable without an app restart. Reaches every node whose network config names its relays (the CLI, host and provider runtimes); the phone and browser reference apps do not name relays that way yet, so their workspace nodes are not covered.
files: packages/cadre-core/src/relay-reservation.ts, packages/cadre-core/src/relay-addrs.ts, packages/cadre-core/src/strand-network-config.ts, packages/cadre-core/src/strand-instance-manager.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/types.ts, packages/cadre-core/test/relay-reservation.spec.ts, packages/cadre-core/test/strand-instance-manager-relay.spec.ts, packages/cadre-core/test/strand-network-config.spec.ts, packages/cadre-core/test/relay-addrs.spec.ts, packages/cadre-core/test/strand-instance-manager-network-addrs.spec.ts, packages/cadre-core/test/strand-listen-port-collision.spec.ts, packages/integration-tests/src/scenarios/strand-circuit-same-party-e2e.integration.ts, packages/integration-tests/src/scenarios/blind-relay-phone-to-phone-e2e.integration.ts, packages/reference-app-web/src/lib/cadre-web.ts, docs/architecture.md, docs/strands.md, tickets/backlog/bug-relay-drive-not-cancellable.md, tickets/backlog/debt-cadre-node-single-file-size.md, tickets/backlog/debt-strand-relay-redrive-on-party-run-relay-unscenarioed.md, tickets/plan/phone-reachable-for-strand-invitations.md
difficulty: hard
repro: verified
----

# Strand nodes re-acquire a lost relay slot on their own

## What landed

A strand node (one libp2p node per shared workspace) used to inherit libp2p's CONFIGURED circuit listener shape, `<relay>/p2p-circuit`, which reserves once from inside `libp2p.start()` and never again. It lost its `/p2p-circuit` address on a relay restart, on either side hanging up the relay connection, and, with no network event at all, on libp2p's own reservation refresh (about 1 h 55 min after reserving against the production relay's 2 h TTL). Strand nodes now take the control node's route: a bare `/p2p-circuit` SEARCH listener plus an explicit reservation supervisor, one listener and one supervisor PER configured relay.

- `relay-addrs.ts`: the configured route is gone. `resolveListenAddrs(network)` is the control node's resolution only (one bare search entry for the whole relay list; a hand-written `<relay>/p2p-circuit` listen entry is rejected). `relayCircuitAddrs` remains the validated form of `relayAddrs`; nothing listens on it.
- `strand-network-config.ts`: `strandNodeAddrs` emits one bare `/p2p-circuit` per relay (appended after the string dedupe, since each identical entry must be its own listener) and returns the relay DIAL addrs in `StrandNodeAddrs.relayAddrs`, deduplicated by relay peer id. A hand-written `<relay>/p2p-circuit` listen entry counts as a relay; a hand-written bare `/p2p-circuit` passes through when no relay is named (the browser shape) and is absorbed when one is.
- `strand-instance-manager.ts`: `buildStrandRuntime` starts one `superviseRelayReservation(node, [relayAddr], { beforeRedrive })` per relay right after `createLibp2pNode` and awaits every first attempt before the strand goes `active`. Fail-soft: a first attempt that lands nothing is logged and the strand still comes up. `releaseRuntime` stops the supervisors FIRST, which covers quiesce, stop, the failed-launch rollback and removal after revocation. `StartStrandConfig.announceDelegateToRelay` is retained with the launch config so a hibernation wake's rebuilt supervisors carry it.
- `relay-reservation.ts`: "held" is judged per relay through `circuitMultiaddrsVia(node, addrs)`, in the loop and in the drive's wait. New `beforeRedrive` option, awaited before every drive after the first; a throwing hook is logged and the drive still runs; a `stop()` that lands while the hook runs skips the drive.
- `cadre-node.ts`: `launchStrand` passes `announceDelegateToRelay`, which announces one strand's delegate peer id to one relay unthrottled and records it so the periodic pass does not repeat it at once. `warnIfAnnounceAddrsDiscardRelay` reads the raw config.

Measured during implement: libp2p 3.1.3 records every protocol our own outbound stream negotiated into the peer store, so after the first explicit reservation libp2p's own discovery CAN refill a freed slot while the relay is up (about 25 ms after a hangup). A relay that is down when the slot frees poisons the store's relay filter and nothing in libp2p tries again, so a relay restart still needs the supervisor. The specs strip the recorded protocol so they prove the supervisor, not discovery.

## Review findings

This review ran twice. The first run (2026-09-15 05:43 UTC) was killed by a machine freeze after making its edits and while its test run was in progress; those edits were salvaged into commit e6910b7 and are listed under "fixed inline" below. The second run re-read the implement diff from scratch, verified the salvaged edits, and completed validation.

**Checked.**

- The implement diff (commit c33bbe4) across all five source files, read against the current files, and every spec it added or rewrote.
- libp2p's own `@libp2p/circuit-relay-v2` 4.1.3 listener and reservation store, to verify the claim the whole design rests on: each bare `/p2p-circuit` listener registers its own pending reservation id, a discovered reservation pops one id, a removed reservation pushes its id back, and there is no reservation cap. So two listeners on one node hold two reservations, and a lost one re-queues its own slot. `reserveQueue.clear()` on a full slot set only splices queued jobs, never the running one. `@optimystic/db-p2p` builds strand nodes with the same default `circuitRelayTransport()` the unit spec uses, so the two-relay spec over plain `createLibp2p` is representative of a db-p2p-built node.
- Concurrent first attempts of two supervisors on one node: the two-relay spec starts both before awaiting either. Both land because the store's per-peer queue serialises the two requests and each pops its own pending id.
- Reservation refresh: `addRelay` removes the existing reservation (re-queuing the id and withdrawing the listener's addr) before re-creating it, and a supervisor tick that fires inside that window joins the in-flight queue job rather than starting a second request.
- Teardown ordering, failed-launch rollback, resume after hibernation, and the manager's map hygiene, all pinned by the manager spec over a supervisor double.
- Who the fix reaches. `network.relayAddrs` is what produces a strand supervisor. The CLI, host and provider runtimes feed it from their configs. The React Native reference app configures `listenAddrs: []` and names no relay at all, and the web reference app reserves through `CadreNode.reserveRelays()`, which reaches the control node only. So neither reference app's strand nodes get a supervisor from this change. The source ticket's description overstated this ("a phone's shared workspaces"); the description above is corrected, and the gap is already the subject of `tickets/plan/phone-reachable-for-strand-invitations` (its relevant bullet was updated by this review).
- Docs and comments in every touched file plus the ones the change should have touched: `types.ts`, `docs/architecture.md`, `docs/strands.md`, the CLI config types, the web and RN app configs, and the four open tickets that referenced the old shape.
- Remaining callers of the changed API across the repo: no `RelayListenRoute` or two-argument `resolveListenAddrs` survives outside the source and spec files in the diff.

**Fixed inline (first run, salvaged in e6910b7).**

- Stale prose that still described strand nodes as inheriting the configured listener: `types.ts` (`NetworkConfig.relayAddrs` doc), `docs/architecture.md` (the config comment block), `cadre-node.ts` (`recordDelegateAnnounces` doc, which said a failed initial announce was fatal at start), `relay-reservation.ts` (module doc referenced the removed `RelayListenRoute`), the blind-relay scenario's comment on why the circuit addr is present at found time, `reference-app-web/src/lib/cadre-web.ts`, and `tickets/plan/phone-reachable-for-strand-invitations.md`.
- A pure unit spec for `circuitMultiaddrsVia` (four cases: only the named relays, empty when the only addr is another relay's, matched by peer id regardless of spelling, fallback to every addr when an entry names no peer id). The implementer had covered it only indirectly through live-relay specs.

**Fixed inline (second run).**

- The web app's comment and the plan ticket said the web tab's strand nodes' bare listener is one "nothing fills". Given the measured discovery behaviour that is too strong; reworded to "nothing drives", and the web comment's claim that those nodes are "reachable over `/webrtc` alone" was replaced, since a WebRTC listener with no circuit addr has no signalling path and is not dialable inbound.

**Major findings.** None that warranted a ticket against the change itself. The one risk the design depends on (libp2p's per-listener pending id) was verified against the dependency's source rather than inferred.

**Filed.**

- `tickets/backlog/debt-strand-relay-redrive-on-party-run-relay-unscenarioed.md`: the re-announce-then-re-reserve sequence against a party-run relay (delegate admission) after that relay restarts has no scenario; both relay scenarios use the dedicated ungated relay, where the announce folds to an empty result. The chain is pinned piecewise; the ticket names the two questions only a scenario would settle. No open ticket claimed the site.
- Appended a dated measurement to `tickets/backlog/debt-cadre-node-single-file-size.md`: `cadre-node.ts` is at 6828 lines and `strand-instance-manager.ts` at 1194 (up from the 535 that ticket opened with), with the relay-supervisor work's share and the pattern producing the growth.

**Tripwires (recorded as `NOTE:` at the site).**

- `strand-instance-manager.ts`, above `awaitFirstRelayAttempts`: a relay that is down costs each launch one full 10 s drive, and `StrandWatcher` launches strands one at a time, so N strands cost N x 10 s of bring-up during an outage. Fix by not awaiting there, not by shortening the drive.
- `cadre-node.ts`, `announceDelegateToRelay`: against a relay that is down the hook can cost up to two 10 s strand-addr timeouts before the 10 s drive starts, holding the supervisor in `driving` for about 30 s per failed re-drive. Bounded and harmless while the relay is unreachable anyway.
- From implement, unchanged: `strand-network-config.ts` at the per-relay listen entries (each bare entry starts relay discovery whenever its slot is empty; cap it if strand nodes ever get a peer router) and the `relay-reservation.ts` module doc (discovery can refill a freed slot after the first explicit reservation; the supervisor remains the guarantee for a relay that is down when the slot frees).

**Considered and declined.** The in-flight drive not being cancellable at teardown is already `tickets/backlog/bug-relay-drive-not-cancellable.md`, which the implementer extended; not re-filed. The fail-soft launch is pinned over a supervisor double only, by choice: a real-node variant costs a 10 s drive per test and the double pins the manager-level claim exactly.

**Validation (second run).**

- `yarn lint`: clean.
- `tsc` typecheck for `@serfab/cadre-core`, `@serfab/integration-tests` and `@serfab/reference-app-web`: clean.
- `yarn workspace @serfab/cadre-core test`: 123 files passed, 2051 tests passed, 1 skipped. The two storage-op budget failures the implement run reported were triaged separately (commit d3f71a2) and no longer fail.
- `yarn workspace @serfab/integration-tests test` over the same-party circuit scenario and the blind-relay phone-to-phone scenario: both pass. The first attempt tripped the stale-build guard for `@serfab/cadre-core` (its `dist` predated the salvaged review edits); rebuilt and re-run. That is the second consecutive pass of the new reconnect assertion (B's strand node reaching A's again through the restarted relay), still too few runs to call it stable.
- `../optimystic` is at `1ae87282` with the uncommitted block-transfer edits the garden note describes; the stale-build guard accepted the existing `@optimystic/db-p2p` build (made by the first review run at 23:52 on 2026-09-14) so it was not rebuilt this pass.

## Tests worth reading first

`packages/cadre-core/test/relay-reservation.spec.ts`, describe `superviseRelayReservation — the strand-node shapes`: client-side and relay-side hangup recovery gated on the supervisor re-driving, the 40 s TTL refresh with the addr still present at 45 s, two relays with two listeners and two supervisors where only the lost relay re-drives, the per-relay held check in isolation, and the `beforeRedrive` contract. `packages/cadre-core/test/strand-instance-manager-relay.spec.ts` pins the manager's wiring and lifecycle over a double. `strand-circuit-same-party-e2e.integration.ts` pins the relay restart end to end: the relay's reservation count returns to 4 from 0 and the strand mesh reconnects through it.

## Docs updated

`docs/architecture.md` (strand relay shape, fail-soft launch, "Reservation loss recovers on every node", the strand-node inheritance table, the config comment block) and `docs/strands.md` (scenario pointer, delegate-grant-on-relay-restart bullet). Module docs in `relay-reservation.ts`, `relay-addrs.ts`, `strand-network-config.ts`, `strand-instance-manager.ts`, `types.ts`.
