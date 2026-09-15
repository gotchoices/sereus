description: A phone can now reach a node that a self-hosted machine lends it. Lent nodes accept WebSocket connections on ports that stay the same across restarts, and the request for a node may leave out the phone's address so the phone dials in instead. This needs a review pass over the change and its tests.
files: packages/cadre-host/src/orchestrator/host-process-orchestrator.ts, packages/cadre-host/src/orchestrator/port-allocator.ts, packages/cadre-host/src/orchestrator/types.ts, packages/cadre-host/src/server/routes/bootstrap-node-validation.ts, packages/cadre-host/src/donation/donation-service.ts, packages/cadre-host/src/donation/types.ts, packages/cadre-host/src/__tests__/orchestrator-ports.test.ts, packages/cadre-host/src/__tests__/orchestrator.test.ts, packages/cadre-host/src/__tests__/orchestrator-env-scrub.test.ts, packages/cadre-host/src/__tests__/orchestrator-node-identity.test.ts, packages/cadre-host/src/donation/__tests__/donation-service.test.ts, packages/cadre-host/src/server/__tests__/grants-route.test.ts, packages/cadre-host/src/server/__tests__/bootstrap-node-validation.test.ts, packages/cadre-host/ui/src/lib/state.svelte.ts, packages/cadre-host/ui/src/routes/NodeDetail.svelte, packages/cadre-provider/src/server/bootstrap-node-validation.ts, packages/cadre-provider/src/server/__tests__/bootstrap-node-validation.test.ts, docs/cadre-host.md, docs/architecture.md
----
# A lent node a phone can reach — review handoff

Split from `phone-adds-cadre-host-node-to-its-cadre`. Siblings: `owner-keeps-dialing-node-it-added` (the phone side), `donation-scenario-phone-shaped-requester` (the end-to-end proof), `rn-request-node-from-cadre-host` (the app).

Terms: a **lent node** (donated node) is a cadre node cadre-host spawns as a child process into someone else's cadre. The **requester** owns that cadre. A **phone-shaped** node listens on nothing and has WebSocket, circuit-relay and WebRTC transports but no TCP, so it can dial out and nothing can dial it.

## What changed

- **Every managed child also listens on WebSocket.** `launchChild` sets `CADRE_LISTEN_ADDRS` from the new exported pure function `childListenAddrs(ports)`: `/ip4/0.0.0.0/tcp/<p2p>,/ip4/0.0.0.0/tcp/<ws>/ws`. cadre-core derives the WebSocket transport from the `/ws` entry; no cadre-cli or cadre-core change. This applies to lent nodes and to the host's own owner node, since both go through `launchChild`.
- **`NodePorts` has a fifth key, `ws`**, appended last in `NODE_PORT_KEYS` so the first four keep their allocation order. A node now costs five ports from the range.
- **A re-spawn comes back on the same ports.** `createContainer` passes `reusedNodePorts(dropped)`, the dropped handle's ports, as `allocateNodePorts` overrides. `ensureOwnerNode` does the same with its configured `libp2pPort` winning for `p2p`. A key the dropped handle lacks (`ws` on a pre-change `state.json`) is allocated fresh.
- **Port-set bookkeeping moved into `port-allocator.ts`**: `reserveNodePorts` / `releaseNodePorts` loop over the key list, replacing the hand-listed calls (and the special case for a missing `admin`). `PortAllocator.markUsed` now ignores non-integers, so a missing key can never put `undefined` or `NaN` in the used-set.
- **`bootstrapNodes` is optional on `POST /grants`.** `validateBootstrapNodes` returns `{ nodes: [] }` for absent or `[]`. `null`, non-arrays and non-string entries are still rejected, and every per-entry rule is unchanged. The module comment now explains that the per-entry rule is identical to cadre-provider's while the list-level rule differs on purpose. The provider copy's comment and test header were updated to match (comment only; provider behaviour unchanged).
- **Respawn accepts an empty list.** `DonationService.respawn` returns `not_respawnable` only when `bootstrapNodes` is absent (or owner keys are missing), not when it is `[]`.
- **UI** shows the `ws` port on the node detail page.
- **Docs**: `docs/cadre-host.md` covers the lifecycle diagram, a new "Who dials whom" paragraph, the `bootstrapNodes` paragraph (per-entry vs list-level), a new "A respawned node keeps its addresses" paragraph (five ports per node, lost `state.json` means fresh ports), LAN reachability of the `/ws` port, and a status note that the dial-in direction has no end-to-end test. `docs/architecture.md` replaced its "byte-identical rule" sentence.

## Use cases to validate

- `POST /grants` with no `bootstrapNodes`, or `[]`, gives 201 and a record with `bootstrapNodes: []`. The child's `cadre.json` gets `controlNetwork.bootstrapNodes: []`.
- `POST /grants` with a bad entry (`not-an-address`, no `/p2p/`, a truncated peer id, peer ids only, `''`) is still 400 naming the entry.
- A lent node's `GET /grants/:id/peer` should list a `/ws` multiaddr beside the TCP ones. **No test asserts this against a real child**; see the gaps below.
- Kill a lent node whose lower-numbered neighbour was terminated, then respawn it. It comes back on exactly its old five ports, not the freed lower ones.
- A `state.json` handle written before this change (no `ws`) rehydrates without reserving `undefined`, and its respawn keeps its four old ports and gains a `ws` port.
- A `seeded` donation with `bootstrapNodes: []` respawns. One with the field missing is `not_respawnable`.

## Tests added or changed

- New `src/__tests__/orchestrator-ports.test.ts` holds the pure port logic. The existing `PortAllocator` / `allocateNodePorts` tests moved there from `orchestrator.test.ts` and gained: five ports in order, a four-port range fails cleanly and releases everything, overrides come back exactly, `markUsed` ignores `undefined`/`NaN`/fractions, reserve/release skip a missing key, `reusedNodePorts` (whole set, `{}` when nothing was dropped, omits a missing `ws`, the last of several duplicates wins), and `childListenAddrs`.
- `orchestrator.test.ts` (spawns a stub child, not cadre-cli): a re-spawn keeps its ports even when lower ones are free, which the old test could not distinguish from lowest-free allocation; a legacy `state.json` handle without `ws` re-spawns on its old ports plus a fresh `ws`; pinned port sets and the "exactly one node's worth" ranges updated from four ports to five.
- `orchestrator-env-scrub.test.ts`: the stub child records `CADRE_LISTEN_ADDRS`, and a new case asserts it is the TCP and `/ws` pair on the handle's own ports. This is the only check that the helper is actually wired into the child's environment.
- `donation-service.test.ts`: provision with `[]` forwards and persists `[]`; respawn of a `seeded` record with `[]` succeeds; a record with owner keys but no `bootstrapNodes` field is `not_respawnable`.
- `grants-route.test.ts`: `[]` removed from the "unusable address" list; new case that absent and `[]` both give 201 with `[]` recorded.
- `bootstrap-node-validation.test.ts` (host): the "required" row is now the "accepted as empty" row.

## Validation run

- `yarn workspace @serfab/cadre-host typecheck` (server and UI tsconfigs): clean.
- `yarn lint`: clean.
- cadre-host suite: **68 files, 643 passed, 4 skipped** (the same 4 skips as the recorded baseline).
- `cadre-host-node-donation.integration.ts` with cadre-host rebuilt: **6/6 passed**. Both of its real `cadre-cli` children were spawned with the new two-entry listen list and came up healthy.
- **Both runs bypassed the stale-build guard, and why matters.** `../optimystic` has uncommitted edits in `packages/db-p2p/src`, from its own runner's in-progress relay-reservation fix, so the guard reported db-p2p stale. Rebuilding would have tested against another repo's unfinished work. I rebuilt `@serfab/cadre-core` (committed source, not yet rebuilt) and `@serfab/cadre-provider` (my comment edit) normally. For db-p2p I ran with scratch vitest configs identical to each package's own except without `globalSetup`. The db-p2p build in use (11:59) predates those edits, but it also lacks the 4-line `libp2p-node-base.ts` change in optimystic `375b6627`. None of the changed tests touch db-p2p. A reviewer should re-run both suites through the normal guard once that runner is idle.
- The cadre-provider suite was not run: its changes are comments only.

## Known gaps — treat these as a starting point

- **The dial-in direction is proven by reading only.** Two claims come from the plan ticket's code reading and have no wire test: a lent node with an empty control database admits the requester's first inbound connection (`admitInboundControlConnection`, `authorizeInboundControlStream` in `cadre-core/src/cadre-node.ts`), and nothing on the lent node retries dialing the phone. `donation-scenario-phone-shaped-requester` owns that proof. The new "Who dials whom" docs paragraph states it as fact, so correct it if the scenario disagrees.
- **Nothing asserts that the `/ws` listener actually binds** in a real child, or that `GET /grants/:id/peer` returns a `/ws` address. The env-var test proves what the child is told. cadre-core's own `listen-transport-options` spec covers the `/ws` → WebSocket transport derivation. The integration pass shows the listen list does not break startup.
- **Strand nodes of managed children now also get an OS-assigned WebSocket listener**, because `strand-network-config.ts` inherits the control node's listen entries with ports rewritten to 0. That was intended, but no test covers it here.
- **A re-spawn over a still-live previous child now always bind-clashes** instead of only sometimes, since it takes the same ports on purpose. Every caller today respawns only a child it has found not running; the NOTE on `dropStaleHandle` was updated to say so.
- **A lost `state.json` means fresh ports**, and a cadre whose only other device is a phone then cannot find its node. This is documented, not solved.
- **`NatService` maps only the owner node's TCP port.** Remote phones need the `/ws` port mapped; that arm is already recorded in `backlog/feat-cadre-host-wan-grant-reachability`. The provider equivalent is `backlog/feat-provider-drone-reachable-by-phone`.
- A `reusedNodePorts` override that falls outside a since-changed port range is used without being reserved, because `markUsed` is a no-op outside the range. The allocator never hands out out-of-range ports, so nothing can collide with it. I judged this harmless and filed no note.
