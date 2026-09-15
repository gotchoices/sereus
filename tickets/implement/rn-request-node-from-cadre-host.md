description: The phone reference app has no way to ask a self-hosted machine for a node to join its group, even though that is the normal "add a backup at home" step. Add a Settings action that takes the host's address and a grant token, runs the request, and shows progress and failures in plain words.
prereq: donated-node-reachable-by-phone, owner-keeps-dialing-node-it-added
files: packages/reference-app-rn/src/host-node-request.ts (new), packages/reference-app-rn/test/host-node-request.spec.ts (new), packages/reference-app-rn/src/use-cadre.ts, packages/reference-app-rn/app/settings.tsx, packages/reference-app-rn/src/test-ids.ts, packages/reference-app-rn/src/phone-node-config.ts, packages/reference-app-rn/src/cadre-phone.ts, packages/reference-app-rn/test/solo-founding.spec.ts, packages/cadre-host/src/server/routes/grants.ts (read-only: request/response shapes), packages/cadre-host/src/server/error-handler.ts (read-only: error code → HTTP status), docs/reference-app-rn.md
----
# Reference app: request a node from a cadre-host

Split from `phone-adds-cadre-host-node-to-its-cadre`.

## Terms

- **cadre-host**: the self-hosted manager that lends nodes to other people's cadres (`docs/cadre-host.md` → Node donation).
- **Grant token**: a secret the host's admin issues (`cadre-host grant issue`), presented as `Authorization: Bearer <token>` on every `/grants` call.
- **Lent node**: the node cadre-host spawns into the phone's cadre.

## The flow

A new module with no native imports, so a Node test can drive it: `src/host-node-request.ts`. Shape:

```ts
export type HostNodeRequestStage = 'requesting' | 'waiting-for-node' | 'authorizing' | 'seeding' | 'connecting' | 'connected';

export interface HostNodeRequestDeps {
	fetch: typeof fetch;
	node: Pick<CadreNode, 'addDrone' | 'removePeer' | 'reconcileControlCohort' | 'getControlNode' | 'getIdentityOwnerKey'> & { partyId: string };
	onStage?: (stage: HostNodeRequestStage) => void;
	signal?: AbortSignal;
}

export async function requestHostNode(hostUrl: string, grantToken: string, deps: HostNodeRequestDeps): Promise<{ donationId: string; peerId: string }>;
```

(Adjust the `node` pick to whatever `CadreNode` actually exposes for the party id; the point is a narrow, fakeable surface.)

Sequence, against the routes in `packages/cadre-host/src/server/routes/grants.ts`:

1. `requesting`: `POST {hostUrl}/grants` with body `{ partyId, ownerKeys: [node.getIdentityOwnerKey().publicKeyB64], profile: 'storage' }` and no `bootstrapNodes` (the phone dials in; see `donated-node-reachable-by-phone`). Expect `201 { ok, data: { donation } }`.
2. `waiting-for-node`: poll `GET /grants/:id/peer` while it answers the `peer_unavailable` error code (the child is still booting), bounded (90 s, matching the startup budget the integration scenarios use).
3. `authorizing`: `node.addDrone({ dronePeerId, droneMultiaddrs })`. After `owner-keeps-dialing-node-it-added`, this also keeps the lent node's addresses as a lasting dial hint on the phone.
4. `seeding`: `PUT /grants/:id/seed` with `{ seed: encodedSeed }`. A `502 seed_failed` right after boot can mean the node's seed route is not up yet, so retry it for a bounded time (30 s, as `cadre-host-node-donation.integration.ts` does), then surface the last message.
5. `connecting`: `await node.reconcileControlCohort()` to dial now rather than at the next 15 s pass, then wait (bounded, 30 s) for a control-node connection whose remote peer is the lent node.
6. `connected`: resolve with the donation id and peer id.

**Cleanup on failure.** If anything after step 1 fails, `DELETE /grants/:id` best-effort so the grant's node quota slot and the host's ports are freed. If step 3 already ran, also `node.removePeer(dronePeerId)` best-effort, so the phone's control database does not keep an authorized row (and a dial hint) for a node that no longer exists. Log cleanup failures; never let them replace the original error.

**Errors in plain words.** Map the host's error envelope `{ ok: false, error: { code, message } }` (codes and statuses in `server/error-handler.ts` and `grants.ts`) to messages a person can act on: an unknown token ("the host does not recognise this grant token"), an expired or revoked grant, the grant's node limit reached, the host unreachable (fetch throws: "could not reach the host at <url>"), the node never came up, the seed rejected, and the loan ended while in flight (`409`/`404` on the seed call). Keep the host's own message available as detail.

## App wiring

- `use-cadre.ts`: add `requestHostNode(hostUrl, grantToken, onStage)` to `UseCadreResult`, guarded like the other actions ("Node not started"), passing the real `fetch` and node. Refresh nothing else; the new peer arrives through the control database.
- `app/settings.tsx`: a "Host Node" section with host URL and grant token inputs, a request button disabled while a request runs, the current stage as text, and the existing modal for failures. Add test ids to `src/test-ids.ts` in the existing style.
- `phone-node-config.ts`: add `connectionGater: { denyDialMultiaddr: () => false }` to `network`. libp2p's `react-native` package field maps its connection gater to the browser version, which refuses insecure `ws://` and private (LAN and loopback) addresses unless `denyDialMultiaddr` is set, and cadre-core's membership gater does not set it (it spreads the embedder's gater and adds only `denyDialPeer`, inbound and relay hooks). Metro's handling of that field under package exports is not reliable (see the comment in `metro.config.js`), so set it explicitly instead of depending on resolution. A home lent node is a private address in normal use, not only in development. The web reference app already does the same (`reference-app-web/src/lib/cadre-web.ts` ~385). The connection is still Noise-encrypted.
- `cadre-phone.ts` ~236-243: the comment says no `connectionGater` override is added because the phone dials only public `wss` addresses; that is no longer true. Replace it with a pointer to the config.

## Device session (manual acceptance, not CI)

Document in `docs/reference-app-rn.md` as a new section after the two-node startup sequence:

- On the PC: `cadre-host start`, `cadre-host grant issue`.
- `adb reverse tcp:<uiPort> tcp:<uiPort>` so `http://127.0.0.1:<uiPort>` on the phone reaches the host. The `/grants` surface is loopback-only in v1 and its origin guard accepts a `127.0.0.1` Host header.
- The phone must be on the **same Wi-Fi LAN** as the PC for libp2p. `adb reverse` needs each port named up front, and the lent node's strand nodes listen on ports the OS picks at start, so reversing the control port alone is not a working setup. Allow `node.exe` through the Windows firewall on private networks when prompted.
- Expected result: solo Connect → enter host URL and token → Request → stages advance to `connected`; the lent node's peer id appears among the phone's control connections.
- Reconnect after relaunch on the device is observable only once the party id persists (`backlog/feat-rn-persist-node-start-options`). The headless scenario `donation-scenario-phone-shaped-requester` covers it meanwhile.
- If the flow stalls at `authorizing`, first run `yarn workspace @serfab/reference-app-rn vitest run --project metro-babel` and make sure Metro was restarted with `--clear`: the Babel helper defect behind `rn-solo-founding-stall-on-device` left Quereus's lock held after early-exit reads, and `addDrone` writes to the control database. The device confirmation of that fix is `blocked/rn-solo-founding-device-run`.

## Out of scope

- Strands on the lent node: `blocked/always-on-nodes-host-strands-of-apps-they-do-not-run`. Do not add strand steps to the flow or the acceptance.
- Reaching a host across the internet: `backlog/feat-cadre-host-wan-grant-reachability`.
- Remembering the donation id, listing lent nodes, or ending a loan from the app.

## Edge cases & interactions

- **Double tap / re-entry.** A second request while one runs must be refused in the hook (not only by a disabled button), or a slow host gets two provisions against one grant.
- **App backgrounded mid-request.** The background runner may stop the node (`background-runner.ts`). A request whose node stopped must fail with a clear message and still run its host-side `DELETE`; honour `signal` so the hook can abort on stop.
- **Host URL input.** Trim, reject a URL without `http://`/`https://`, and strip a trailing `/` before joining paths. The origin guard rejects a `Host` header other than loopback (`server/origin-guard.ts`), so a LAN IP URL answers 403 `forbidden_origin`; map that to "this host only accepts requests from the same machine — use adb reverse and 127.0.0.1".
- **`peer_unavailable` vs other 4xx during polling.** Only `peer_unavailable` is retried. A `404` means the loan was ended (or reaped after 30 minutes in `awaiting_seed`) and stops the flow.
- **Seed retry vs rejection.** `PUT /seed` maps both "node not reachable yet" and "node's trust policy rejected the seed" to `502 seed_failed`. Retrying a real rejection only costs the bounded window; do not parse messages to tell them apart.
- **`addDrone` succeeded, seed never applied.** Cleanup must remove the peer row (above); otherwise every later seed the phone mints names a node that does not exist.
- **Connected check.** Match on the lent node's peer id among `getControlNode().getConnections()`, not "any connection", because a solo phone may hold unrelated connections (a relay, in future).
- **Mixed addresses.** `droneMultiaddrs` contains TCP and loopback addresses the phone cannot use; pass them through unfiltered. cadre-core normalises and libp2p skips what it has no transport for.
- **Config change reaches strand nodes too.** `network.connectionGater` is also handed raw to strand nodes (`strand-instance-manager.ts`), which is wanted: they dial LAN addresses as well.

## Tests

`test/host-node-request.spec.ts` with a fake `fetch` and a fake node:

- Happy path: calls happen in order (`POST`, `GET peer` ×n, `addDrone`, `PUT seed`, `reconcileControlCohort`), the `POST` body carries `partyId`, the owner key and no `bootstrapNodes`, stages are reported in order, and it resolves once the fake control node reports a connection to the lent node's peer id.
- `peer_unavailable` twice, then success: polls and continues.
- `502 seed_failed` until the deadline: rejects with the host's message and issues `DELETE` and `removePeer`.
- `401` on `POST`: rejects with the grant-token message; no `DELETE` (there is no id) and no `removePeer`.
- `fetch` throws on `POST`: "could not reach the host" message.
- Failure after `addDrone` where `DELETE` itself fails: the original error surfaces, and the cleanup failure is logged.
- Aborted `signal` mid-poll: rejects promptly and cleans up.

`test/solo-founding.spec.ts` (or a small config spec beside it): `buildPhoneNodeConfig(...).network.connectionGater.denyDialMultiaddr` exists and returns `false`.

Run: `yarn workspace @serfab/reference-app-rn test`, `yarn workspace @serfab/reference-app-rn typecheck`, `yarn lint`.

## TODO

- Write `src/host-node-request.ts` (flow, bounded polling, cleanup, error mapping).
- Write `test/host-node-request.spec.ts` covering the cases above.
- Add `requestHostNode` to `use-cadre.ts` with a re-entry guard and abort-on-stop.
- Add the "Host Node" section and test ids in `settings.tsx` and `test-ids.ts`.
- Add `denyDialMultiaddr: () => false` in `phone-node-config.ts`; replace the stale comment in `cadre-phone.ts`; add the config assertion test.
- Document the device session in `docs/reference-app-rn.md`.
- Run reference-app-rn tests, typecheck and lint. Note in the review handoff that the device run is manual and was or was not performed.
