description: A phone can now reach a node that a self-hosted machine lends it. Lent nodes accept WebSocket connections on ports that stay the same across restarts, and the request for a node may leave out the phone's address so the phone dials in instead.
files: packages/cadre-host/src/orchestrator/host-process-orchestrator.ts, packages/cadre-host/src/orchestrator/port-allocator.ts, packages/cadre-host/src/orchestrator/types.ts, packages/cadre-host/src/server/routes/bootstrap-node-validation.ts, packages/cadre-host/src/donation/donation-service.ts, packages/cadre-host/src/donation/types.ts, packages/cadre-host/src/__tests__/orchestrator-ports.test.ts, packages/cadre-host/src/__tests__/orchestrator.test.ts, packages/cadre-host/src/__tests__/orchestrator-owner.test.ts, packages/cadre-host/src/__tests__/orchestrator-env-scrub.test.ts, packages/cadre-host/src/donation/__tests__/donation-service.test.ts, packages/cadre-host/src/server/__tests__/grants-route.test.ts, packages/cadre-host/src/server/__tests__/bootstrap-node-validation.test.ts, packages/cadre-host/ui/src/routes/NodeDetail.svelte, packages/cadre-host/README.md, packages/cadre-provider/src/server/bootstrap-node-validation.ts, docs/cadre-host.md, docs/architecture.md
----
# A lent node a phone can reach

Split from `phone-adds-cadre-host-node-to-its-cadre`. Siblings: `owner-keeps-dialing-node-it-added` (the phone side), `donation-scenario-phone-shaped-requester` (the end-to-end proof), `rn-request-node-from-cadre-host` (the app).

A **lent node** (donated node) is a cadre node that cadre-host spawns as a child process into someone else's cadre. The **requester** owns that cadre. A phone's node listens on nothing and has no TCP transport, so the phone must be the one that dials.

## What landed

- **Every managed child listens on WebSocket as well as TCP.** `childListenAddrs(ports)` in `host-process-orchestrator.ts` builds the child's `CADRE_LISTEN_ADDRS`: TCP on `p2p` and `/ws` on the new `ws` port, both on `0.0.0.0`. This applies to lent nodes and to the host's own owner node.
- **A node holds five ports** (`NodePorts.ws` added last in `NODE_PORT_KEYS`, so the first four keep their allocation order).
- **A re-spawn comes back on the same ports.** `reusedNodePorts(dropped)` passes the dropped handle's ports as `allocateNodePorts` overrides. The owner node does the same, except its `p2p` always comes from the configured `libp2pPort`. A key missing from an older `state.json` handle is allocated fresh.
- **Port-set bookkeeping lives in `port-allocator.ts`** (`reserveNodePorts` / `releaseNodePorts`). `markUsed` ignores non-integers.
- **`bootstrapNodes` is optional on `POST /grants`.** Absent or `[]` provisions a node with no bootstrap peers. Every per-entry rule is unchanged. cadre-provider still requires a non-empty list; only its comments changed.
- **Respawn accepts an empty list.** Only a missing `bootstrapNodes` field is `not_respawnable`.
- UI node detail shows the `ws` port. Docs: `docs/cadre-host.md` (lifecycle, "Who dials whom", "A respawned node keeps its addresses", LAN reachability, status) and `docs/architecture.md`.

## Review findings

**Checked, by reading the implement diff (`68437e5`) first, then the surrounding code:**

- Port logic: all-or-nothing allocation, re-spawn reuse, handles saved without `ws`, release-before-restore ordering after a failed launch (reused ports are released and then re-reserved by the restored handle, so nothing leaks), and the owner node's `libp2pPort` override winning over the reused `p2p`. Correct.
- The cold-start admission path used for dial-in (`admitInboundControlConnection`, `authorizeInboundControlStream`, `admitControlPeerUnconditionally` in `cadre-core/src/cadre-node.ts`). Both gates admit when the node has no authorized members. `SeedBootstrapService.applySeed` (`cadre-core/src/seed-bootstrap.ts`) writes no control-database rows: it anchors the signer, merges peer addresses and dials owner peers that have addresses. So the docs' claim that the node "holds no authorized members yet" when the phone dials still holds after the seed step. This is confirmed by reading only; the wire proof remains `donation-scenario-phone-shaped-requester`.
- Code references cited in comments and docs exist: `resolveTransportOptions` (`cadre-core/src/relay-addrs.ts`), `reference-app-rn/src/phone-node-config.ts`, and the `/ws` port rewrite in `cadre-core/src/strand-network-config.ts`. The referenced tickets exist on the board, and `backlog/feat-cadre-host-wan-grant-reachability` already carries the WebSocket-port arm.
- The list-level vs per-entry split between the host and provider validators. The provider's behaviour and tests are unchanged, and both module comments describe the difference accurately.
- Other `bootstrapNodes` length checks and "required" wording across `packages/`: none left in cadre-host.

**Found and fixed in this pass (minor):**

- `packages/cadre-host/README.md` (grantee steps) still presented bootstrap addresses as required and did not mention the `/ws` address. Updated.
- `docs/cadre-host.md` "Who dials whom" did not say that the cold-start rule admits *any* peer, not just the requester, until the requester's rows arrive. A dial-in loan can now sit in that state until the phone dials, so the docs now say so, and that today this means anyone on the host's LAN.
- The owner node's port reuse (`ensureOwnerNode` with `reusedNodePorts` plus the `libp2pPort` override) had no test. Added `re-spawns on its previous ports, taking p2p from the current config` to `orchestrator-owner.test.ts`. It frees lower ports first, so lowest-free allocation would fail it.

**Tripwire recorded:**

- `allocateNodePorts` trusts its overrides: `markUsed` refuses neither a port another handle holds nor two keys naming one port. That is safe for today's callers. Parked as a `NOTE:` on `allocateNodePorts` in `port-allocator.ts`.

**Considered, no action:**

- *Immediate rebind of the same ports after a child exits* (for example, lingering TCP TIME_WAIT sockets on Windows). This is not new: lowest-free allocation already usually returned the freed ports, and the owner node has always rebound a fixed `libp2pPort` on restart.
- *The UI shows an empty `ws` for a still-running handle saved before this change.* This is cosmetic and only affects old state, and the project has no backwards-compatibility policy yet.
- *`host-process-orchestrator.ts` is 1161 lines* (`wc -l`). The size predates this change, which moved port bookkeeping out of it. No natural split emerged from this review, and no open ticket claims the file. Nothing filed.
- *The cold-start admission window.* This is cadre-core's existing design, and a lent node whose bootstrap peers were unreachable already sat in that state indefinitely. Documented (above), not filed.

**Major findings:** none. No tickets filed.

**Validation:**

- `yarn workspace @serfab/cadre-host typecheck` exits 0; `yarn lint` exits 0.
- cadre-host suite: **68 files, 644 passed, 4 skipped** (the implement run's 643 plus the new owner test; same 4 skips).
- The stale-build guard still reports `@optimystic/db-p2p` stale, because `../optimystic` holds another runner's uncommitted relay-reservation edits. As in the implement stage, the suite ran with a scratch vitest config identical to cadre-host's except without `globalSetup`. Re-run through the normal guard once that work lands.
- Not re-run: the cadre-provider suite (comment-only changes) and `cadre-host-node-donation.integration.ts`. This pass changed docs, one comment and one unit test, no runtime code.

## Known gaps carried forward

- No wire test proves the dial-in direction or that a real child binds its `/ws` listener and reports it from `GET /grants/:id/peer`. Owned by `donation-scenario-phone-shaped-requester`.
- Strand nodes of managed children also get an OS-assigned WebSocket listener, which is not tested in cadre-host.
- A lost `state.json` means fresh ports, so a cadre whose only other device is a phone loses its node. This is documented.
- `NatService` maps only the owner node's TCP port. The `/ws` arm is in `backlog/feat-cadre-host-wan-grant-reachability`; the provider equivalent is `backlog/feat-provider-drone-reachable-by-phone`.
