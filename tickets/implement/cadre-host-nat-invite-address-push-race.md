----
description: Make NatService's initial invite-address push survive authority-node not-yet-ready by retrying it within start() until the node accepts it (bounded), so early invites carry NAT-resolved addresses
files: packages/cadre-host/src/nat/nat-service.ts, packages/cadre-host/src/nat/__tests__/nat-service.test.ts, packages/cadre-host/src/bin/host.ts
----

## Problem (confirmed)

`NatService.start()` ends with a single best-effort `await this.fireAddressesChanged()`
(`nat-service.ts:149-151`). That round-trips to the authority node via
`getInviteAddresses()` → `cadreNode.getPeerId()/getMultiaddrs()` over the loopback
admin channel. But `orchestrator.ensureAuthorityNode()` returns as soon as the
detached child is *spawned* (`host.ts:282-292`); the child's admin HTTP server has
not yet bound. So the first `getInviteAddresses()` throws
`AuthorityNodeUnavailableError` → `NatError('node_unavailable')`, which
`fireAddressesChanged()` swallows as a best-effort skip
(`nat-service.ts:270-286`). There is **no retry on this initial path**, so the
pre-registered listener in `host.ts:309-317`
(`authority.pushInviteAddresses`) is never invoked. The node therefore holds no
host-pushed addresses and, when minting invites, falls back to its own
`getMultiaddrs()` (cadre-cli `admin-server.ts:154-155`, `setInviteAddresses` only
populated via `PUT /admin/invite-addresses`). A host that mints an enrollment
invite right after startup hands out raw libp2p multiaddrs instead of the
NAT-resolved DDNS/external-IP addresses it already computed — until some later NAT
event (`putSettings`/`testReachability`) happens to re-fire the push.

**Reproduced** during the fix stage with a `CadreNodeLike` stub whose `getPeerId`
throws `AuthorityNodeUnavailableError` on the first call then returns a real peer
ID: after `await svc.start()` with a listener registered *before* start, the
listener fired 0 times even though `getInviteAddresses()` succeeded immediately
afterward. (The scratch repro asserted the buggy behavior and was removed; the
implement test below asserts the fixed behavior.)

The two failure modes that look like "not ready" are already unified into
`node_unavailable` by `getInviteAddresses()`:
  - admin channel not bound yet → transport error → `AuthorityNodeUnavailableError`
    → `NatError('node_unavailable')` (`nat-service.ts:230-234`);
  - node bound but no libp2p peer ID yet (`/admin/identity` → `peerId: null`) →
    empty peerId → `NatError('node_unavailable')` (`nat-service.ts:236-241`).
Retrying on `node_unavailable` covers both transient states.

## Fix

Replace the single fire-and-forget initial push with a **bounded retry that
`start()` awaits**. Because `host.ts` awaits `natService.start()` *before* it
creates the local-UI / management-API server (`host.ts:321-338`) — and the
management API is the only path that mints invites — awaiting a bounded initial
push means the invite-minting endpoint does not come up until the first
NAT-resolved address set has landed on the node (or the bounded deadline has
elapsed). That gives the ordering guarantee the bug needs without a node-side
protocol change.

Key design points:
- **Awaited, not background.** Keeps the ordering guarantee and avoids
  microtask-timing flakiness in existing tests. Tests that register a listener
  *after* `start()` are unaffected because the initial push sees zero listeners
  and returns immediately (same as today's behavior — this is why the current
  suite passes).
- **Bounded.** Cap total retry time so genuine, sustained node-unavailability
  still lets the process come up with the UI serving (the ticket's explicit
  constraint). On deadline, log and return — best-effort, exactly as before, just
  after N attempts instead of one.
- **Early-out when no listeners.** `if (this.addressListeners.size === 0) return;`
  preserves current semantics and keeps the existing test suite fast (no real
  sleeps for the many tests that never register a pre-start listener).
- **Only the initial push retries.** `putSettings`/`testReachability` keep their
  current single-shot best-effort `fireAddressesChanged()` — by then the node is
  ready, and a later transient blip should not block a settings PUT.
- **Stop-safe.** The retry loop checks `this.started` each iteration and bails if
  `stop()` ran, so it never pushes after teardown.

### Shape (nat-service.ts)

Add tunables to `NatServiceOptions` (injectable so tests run fast):
```ts
/** Initial-push retry: poll interval while the node is not-yet-ready. Default 250ms. */
initialPushRetryMs?: number;
/** Initial-push retry: total budget before giving up (best-effort). Default 15000ms. */
initialPushTimeoutMs?: number;
```
Store them on the instance (with the defaults above).

Extract the listener-notify out of `fireAddressesChanged()` into a shared helper
so both the regular path and the initial-push path use it:
```ts
private async notifyAddressListeners(addresses: string[]): Promise<void> {
  for (const listener of this.addressListeners) {
    try { await listener(addresses); }
    catch (err) { log('address listener threw: %s', (err as Error).message); }
  }
}
```
`fireAddressesChanged()` becomes: get addresses (swallow on throw, unchanged) →
`await this.notifyAddressListeners(addresses)`.

Replace `start()`'s final `await this.fireAddressesChanged();` with
`await this.pushInitialAddresses();`:
```ts
/**
 * Initial invite-address push. The authority node's admin channel is a freshly
 * spawned detached child that may not be bound yet (and may not have a libp2p
 * peer ID yet), so a single attempt races readiness and silently drops the first
 * NAT-resolved address set. Retry on `node_unavailable` until the node accepts it
 * or the bounded budget elapses (best-effort thereafter). Awaited by start() so
 * the management API — the invite-minting path — does not come up first.
 */
private async pushInitialAddresses(): Promise<void> {
  if (this.addressListeners.size === 0) return;
  const deadline = this.nowFn().getTime() + this.initialPushTimeoutMs;
  for (;;) {
    if (!this.started) return; // stop() ran during a retry
    try {
      const addresses = await this.getInviteAddresses();
      await this.notifyAddressListeners(addresses);
      return;
    } catch (err) {
      const code = err instanceof NatError ? err.code : undefined;
      // Only retry transient not-ready; surface anything unexpected via log + give up.
      if (code !== 'node_unavailable' || this.nowFn().getTime() >= deadline) {
        log('initial invite-address push not delivered: %s', (err as Error).message);
        return;
      }
      await sleep(this.initialPushRetryMs);
    }
  }
}
```
Add a small module-private `sleep(ms)` (unref the timer, mirroring
`host-process-orchestrator.ts:761-766`).

`NatError`'s `code` is already exported/usable — confirm `NatError` exposes
`.code` (it's used in tests via `toMatchObject({ code: ... })`, so it does).

### host.ts

No structural change required — the comment at `host.ts:307-308` ("NatService.start()
also fires this once (best-effort initial push)") should be updated to note the
push is now retried until the node accepts it (bounded). Confirm the listener stays
registered *before* `natService.start()` (it is, `host.ts:309` precedes `:322`),
which is what makes the awaited initial push reach a real listener.

## Residual / out of scope

There remains a theoretical micro-race only if an invite is minted through some
path that bypasses `start()` ordering (there is none today — the management API is
created after `start()` resolves). A stronger node-side guarantee (node refuses to
mint invites until addresses are pushed, or requests them on readiness) is a larger
protocol change and is **not** in scope here. If the team wants belt-and-suspenders,
file a backlog ticket — do not expand this one.

## TODO

- [ ] Add `initialPushRetryMs` / `initialPushTimeoutMs` to `NatServiceOptions` and
      store them on the instance with defaults (250ms / 15000ms).
- [ ] Extract `notifyAddressListeners()` and refactor `fireAddressesChanged()` to use it.
- [ ] Add module-private `sleep(ms)` (unref'd timer).
- [ ] Implement `pushInitialAddresses()` (bounded retry on `node_unavailable`,
      stop-safe, early-out when no listeners) and call it (awaited) at the end of `start()`.
- [ ] Update the `host.ts:307-308` comment to reflect the retry behavior.
- [ ] Add tests in `nat/__tests__/nat-service.test.ts` (set small
      `initialPushRetryMs`/`initialPushTimeoutMs` so they run fast):
      - listener registered **before** `start()` + a node that is unavailable for
        the first K `getPeerId` calls then returns a real peer ID → the initial
        push is delivered exactly once with the NAT-resolved address
        (`/ip4/.../p2p/<peerId>`), proving the race is closed.
      - node that stays unavailable past `initialPushTimeoutMs` → `start()` still
        resolves, listener never fires (best-effort preserved), and the process is
        otherwise healthy (`getStatus()` works).
      - regression: existing tests that register listeners **after** `start()` still
        see no extra initial-push notifications (e.g. the unsubscribe test's
        `count === 1` must hold).
- [ ] `yarn workspace @serfab/cadre-host test` green; `yarn workspace @serfab/cadre-host build` (tsc) clean.
