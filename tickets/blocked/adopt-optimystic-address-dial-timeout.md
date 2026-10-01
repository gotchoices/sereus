description: Raise the @optimystic/* floor to the release that sizes libp2p's per-address dial timeout from linkRoundTripMs, so relayed dials at the supported 3 s round trip stop timing out after 6 s (gotchoices/sereus#13).
files: package.json and packages/*/package.json (@optimystic/* ranges), .release-notes.pending.md
----
# Adopt optimystic's link-sized addressDialTimeout

**Blocked on:** an optimystic release (upstream ticket `fix/1-a-relayed-dial-is-cut-off-by-libp2ps-per-address-timeout`, tended by optimystic-ec, cd174d58).

## Why

kjeib measured on #13 that a relayed formation at 1500 ms per-frame delay times out 6.0 s into the dial. The cause is libp2p's fixed per-address `addressDialTimeout` of 6000 ms.
- Optimystic sizes `dialTimeout` and `inboundUpgradeTimeout` from `linkRoundTripMs`, but not this limit.
- Sereus can't pass it through, because optimystic's `connectionManager` option accepts only those two fields.
- With the limit raised to 30 s, the test passed end to end.

Upstream also found two related points:
- Its RPC clients' own dials are capped at 6 s per address as well, because libp2p's dial queue combines the per-address timer with the caller's signal.
- The fix raises optimystic's libp2p range to ^3.3.11.

## Upstream design (optimystic main 8f073cb0, green, not yet released)

- **Default.** `addressDialTimeoutMs = max(6000, 5 × linkRoundTripMs)`, which is 15 s at sereus's 3 s round trip. A relayed open measured about 12.1 s at 1500 ms one-way.
- **Override.** It can be set through `connectionManager.addressDialTimeout`.
- **The release moves db-p2p's whole libp2p family to the 3.3 line:** libp2p ^3.3.11, @libp2p/interface ^3.3, uint8arraylist 3, it-length-prefixed 11, circuit-relay-v2 4.2. Adopting it means moving sereus's libp2p family too, not just libp2p.
- **A pinning test.** A spec pins libp2p's per-address cutoff, so a lockfile that slides back to 3.1 fails it.
- **Upstream tripwire: a relay the dialer isn't connected to yet.** A relayed dial through such a relay pays both connection opens inside one per-address limit, which can exceed five round trips. Sereus runs this topology: phones keep reservations on several relays, and party-run relays are common. This was reported back upstream; it is the same gap as `backlog/23-bug-relayed-dial-budget-omits-opening-the-relay-connection`.

## TODO

- [ ] When optimystic releases the fix, raise the `@optimystic/*` floors to that version.
  - The other half, raising sereus's own libp2p family to the 3.3 line (`libp2p` ^3.3.11, `@libp2p/interface` ^3.3.0, `@multiformats/multiaddr` ^13.0.3), is done by `typecheck-fails-on-libp2p-interface-3-1-against-linked-optimystic-3-3`. Sereus's lockfile now resolves libp2p 3.3.11, so its tests and `check:published` run the libp2p embedders install, per-address timeout included.
- [ ] Check whether any libp2p node that sereus builds itself (outside optimystic) should set `addressDialTimeout` too. See `backlog/debt-libp2p-nodes-built-outside-cadre-core-miss-the-ping-defaults`.
- [ ] Check the strand-formation dial against the new per-address limit. It passes the invitation's whole address list to one `dialProtocol` call under `formationDeadlines().dialMs` (`5L + 2 s`, 19.5 s at the default declaration), so a first address that never answers costs one per-address timeout and the next address gets what is left. With optimystic's `max(6000, 5L)` that is 17.5 s of 19.5 s at the default, about 2 s for the next address, which is too short for a relayed dial. Decide whether `dialMs` should cover more than one per-address timeout (see the `NOTE:` at `openFormationStream` in `strand-formation-protocol.ts`).
- [ ] Pass explicit values to optimystic, computed in `link-budget.ts`: `connectionManager.addressDialTimeout`, `dialTimeout`, and its RPC `dialTimeoutMs`.
  - Agreed with optimystic (2026-10-01): its default per-address limit is sized for the cold path (opening the relay leg, then the circuit) with no allowance for gates.
  - Sereus adds its own gate cost of up to 2 × `ADMISSION_DECISION_TIMEOUT_MS`, one decision at the relay and one at the target.
  - Upstream tickets:
    - `fix/1-a-relayed-dial-through-an-unconnected-relay-outruns-its-deadlines`.
    - `fix/1.5-the-rpc-dial-deadline-cannot-be-set-per-node`, which adds the node-level `dialTimeoutMs` override. Until that lands, only optimystic's own code could set it.
    - `addressDialTimeout` and `dialTimeout` are already used as given through `connectionManager`. Do this together with `backlog/23-bug-relayed-dial-budget-omits-opening-the-relay-connection`.
- [ ] Shape of the upstream release (optimystic main 7da08dc2, green, unreleased). With r = `linkRoundTripMs`:
  - **Connection limits:** `connectionManager.addressDialTimeout` and `dialTimeout` default to max(6000 or 10000, 10 r). That covers the cold open (relay leg, circuit, relayed upgrade, about 8.6 r over WebSocket) plus a margin. `inboundUpgradeTimeout` is now separate, at max(10000, 5 r).
  - **RPC dial deadline:** max(3000, 11 r) by default. It is set exactly with the new `NodeOptions.rpcDeadlines { dialTimeoutMs?, responseTimeoutMs? }`, with no floor.
  - **Transaction timeout:** the NetworkTransactor timeout that the Quereus plugin uses is now derived as max(30000, 4 × the RPC dial deadline), and it follows an explicit `rpcDeadlines.dialTimeoutMs`.
- [ ] Pass sereus's totals for all three limits: optimystic's cold open + 2 × `ADMISSION_DECISION_TIMEOUT_MS`. Check that the derived transaction timeout still fits inside sereus's write and cohort budgets.
  - Answered by `degraded-cohort-stalled-write-outruns-120s-cap`, measured 2026-10-01. A silent cohort member never reaches the transaction budget: a failing control write pays one pend round plus the cancel discharge's rounds, each about 2 × the response deadline (21 s). The cancel discharge runs until `abortOrCancelTimeoutMs` = max(5 s, RPC dial) has passed. At the default that is 2 cancel rounds, so a failing write takes about 63 s, and it holds the control write lock for that long. `docs/cadre-consistency.md` → "Deadlines Over Optimystic's Reads and Commits" records this.
  - What a larger dial changes: the cancel budget grows with it. At a dial above 42 s, `ceil(dial / 21 s)` becomes 3 cancel rounds, and a failing write becomes about 84 s. `control-write-degraded-cohort-member.integration.ts` derives its stalled bounds from `resolveLinkDeadlines(DECLARED_LINK_ROUND_TRIP_MS)`. **Once sereus passes `rpcDeadlines`, pass the same override there** (`LINK_DEADLINES`), or the test derives from the wrong dial.
- [ ] `MAX_LINK_ROUND_TRIP_MS` drops from about 1.66 days to about 13 h. Update the `types.ts` doc (~501) and say so in the release note.
- [ ] Add a release note for the floor change.
- [ ] Run `yarn check:published` after the floor bump; it fails at master today. Sereus tests were adapted to the linked, unreleased optimystic, so they don't typecheck against npm 1.8.1. For example, `cadre-core/test/link-budget.spec.ts:75` uses `inboundUpgradeTimeoutMs`, and `relayed-dial-cost-by-latency.integration.ts:158` uses the same field. Sereus master is not releasable until this ticket lands.
- [ ] Ask kjeib on #13 to re-run 1500 ms without their `node_modules` patch, and close #13 on a pass.
