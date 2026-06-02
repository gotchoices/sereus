description: Review — NatService initial invite-address push now retries (bounded) until the freshly spawned authority node accepts it, so early invites carry NAT-resolved addresses
files: packages/cadre-host/src/nat/nat-service.ts, packages/cadre-host/src/nat/__tests__/nat-service.test.ts, packages/cadre-host/src/bin/host.ts

## What changed & why

`NatService.start()` previously ended with a single best-effort
`await this.fireAddressesChanged()`. That round-trips to the authority node, but
`orchestrator.ensureAuthorityNode()` returns as soon as the detached child is
*spawned* — its admin HTTP server has not bound yet. So the first
`getInviteAddresses()` threw `AuthorityNodeUnavailableError` →
`NatError('node_unavailable')`, which the best-effort path swallowed with no
retry. The pre-registered `authority.pushInviteAddresses` listener never fired,
the node held no host-pushed addresses, and an invite minted right after startup
handed out raw libp2p multiaddrs instead of the NAT-resolved DDNS/external-IP
addresses — until a later NAT event happened to re-fire the push.

**Fix:** the initial push is now a **bounded retry that `start()` awaits**
(`pushInitialAddresses()`). It retries only on `node_unavailable` (which unifies
both not-ready states: admin channel not bound, and node bound but no libp2p peer
ID yet) until the node accepts it or the budget elapses. Because `host.ts` awaits
`natService.start()` *before* creating the management-API server (the only
invite-minting path), the invite endpoint does not come up until the first
NAT-resolved address set has landed (or the deadline passed). That is the
ordering guarantee, with no node-side protocol change.

### Implementation details

- New `NatServiceOptions`: `initialPushRetryMs` (default 250ms) and
  `initialPushTimeoutMs` (default 15000ms), stored on the instance and injectable
  so tests run fast.
- Extracted `notifyAddressListeners(addresses)` from `fireAddressesChanged()`;
  both the regular path and the new initial-push path use it.
- New module-private `sleep(ms)` with an unref'd timer (mirrors the orchestrator's
  helper), so the retry loop never holds the process open.
- `pushInitialAddresses()`:
  - early-out `if (this.addressListeners.size === 0) return;` (preserves current
    semantics; keeps the suite fast — most tests register listeners *after*
    start, or none).
  - bounded loop on a wall-clock deadline computed from `nowFn()`.
  - retries **only** `node_unavailable`; any other error is logged and the loop
    gives up (no infinite retry on a real bug).
  - stop-safe: checks `this.started` each iteration and bails if `stop()` ran.
- `putSettings` / `testReachability` are unchanged — still single-shot
  best-effort `fireAddressesChanged()` (node is ready by then; a transient blip
  shouldn't block a settings PUT).
- `host.ts`: comment-only update describing the retry; listener stays registered
  before `start()` (host.ts:309 precedes the start call), which is what lets the
  awaited push reach a real listener.

## How to validate

`yarn workspace @serfab/cadre-host test` — 332 passed / 4 skipped (was 17 tests in
`nat-service.test.ts`, now 20). `yarn workspace @serfab/cadre-host build` (tsc +
vite) clean.

New tests in `nat/__tests__/nat-service.test.ts` (describe: *initial invite-address
push retry*), all with small `initialPushRetryMs`/`initialPushTimeoutMs`:

- **Race closed:** listener registered *before* `start()`; a `makeFlakyNode(3)`
  whose `getPeerId` throws `AuthorityNodeUnavailableError` for the first 3 calls
  then returns a peer ID → push delivered **exactly once** as
  `/ip4/203.0.113.42/tcp/4001/p2p/12D3KooWFlaky`, and `peerIdCalls() === 4`
  (proves it retried, not luck).
- **Bounded give-up:** node always unavailable past `initialPushTimeoutMs` →
  `start()` still resolves, listener never fires (best-effort preserved),
  `getStatus().portMode === 'auto-upnp'` (process otherwise healthy).
- **No retry on non-transient error:** `getPeerId` throws a plain `Error('boom')`
  → `start()` resolves immediately, `getPeerId` called once (doesn't burn the
  budget retrying a real bug).
- **Regression preserved:** the existing unsubscribe test (`count === 1`, listener
  registered *after* start) still holds — the initial push sees zero listeners and
  returns immediately.

## Reviewer focus / known gaps & risks

- **Timing-based tests use the real clock** (default `nowFn`), not fake timers —
  the deadline is wall-clock. The give-up test budgets ~20ms; on a heavily loaded
  CI box the loop simply exits on the next deadline check, so it shouldn't flake,
  but it's worth a skeptical look. The retry-then-succeed test does not depend on
  the timeout (it succeeds on attempt 4 well within 2s).
- **`peerIdCalls() === 4` is an exact assertion.** It's deterministic given
  `getInviteAddresses` calls `getPeerId` once per attempt and the node fails
  exactly 3 times, but it couples the test to that call shape. If a reviewer finds
  it brittle, `toBeGreaterThanOrEqual(4)` would loosen it.
- **No host.ts-level integration test** exercises the real spawn-then-bind race
  end-to-end (the orchestrator child is detached). The unit tests simulate the
  not-ready node via stubs; the structural ordering guarantee (management API
  created after `start()` resolves) is verified only by reading `host.ts`, not by
  a test. Consider whether a smoke test that mints an invite immediately after
  host startup is worth adding — it would catch regressions in the start-ordering
  that the unit tests cannot.
- **Default 15s timeout blocks UI bring-up** in the genuine sustained-outage case.
  This is the ticket's explicit tradeoff (await-for-ordering vs. fast UI), but a
  reviewer should confirm 15s is acceptable for the worst case where the authority
  node truly never comes up; the UI/management API is delayed by up to that budget
  on every cold start where the node is slow.

## Residual / out of scope (do NOT expand here)

A theoretical micro-race remains only if an invite is minted through a path that
bypasses `start()` ordering — there is none today (management API is created after
`start()` resolves). A stronger node-side guarantee (node refuses to mint invites
until addresses are pushed, or requests them on readiness) is a larger protocol
change and is **not** in scope. If the team wants belt-and-suspenders, file a
**backlog** ticket rather than widening this one.
