description: NatService initial invite-address push now retries (bounded) within start() until the freshly spawned authority node accepts it, so early invites carry NAT-resolved addresses
files: packages/cadre-host/src/nat/nat-service.ts, packages/cadre-host/src/nat/__tests__/nat-service.test.ts, packages/cadre-host/src/bin/host.ts, docs/cadre-host.md

## Summary

`NatService.start()` previously ended with a single best-effort
`await this.fireAddressesChanged()`. `orchestrator.ensureAuthorityNode()` returns
as soon as the detached child is *spawned* — its admin HTTP server has not bound
yet — so the first `getInviteAddresses()` threw `AuthorityNodeUnavailableError` →
`NatError('node_unavailable')`, which the best-effort path swallowed with no
retry. The pre-registered `authority.pushInviteAddresses` listener never fired,
the node held no host-pushed addresses, and an invite minted right after startup
handed out raw libp2p multiaddrs instead of the NAT-resolved DDNS/external-IP set
— until a later NAT event happened to re-fire the push.

**Fix (shipped in `d1c3ffb`):** the initial push is now a bounded retry that
`start()` awaits (`pushInitialAddresses()`), retrying only on `node_unavailable`
(which unifies both not-ready states: admin channel not bound, and node bound but
no libp2p peer ID yet) until the node accepts it or the budget (`initialPushTimeoutMs`,
default 15s) elapses. Because `host.ts` awaits `natService.start()` *before*
creating the management-API server (the only invite-minting path), the invite
endpoint does not come up until the first NAT-resolved address set has landed (or
the deadline passed) — the ordering guarantee, with no node-side protocol change.

## Review findings

Reviewed the implement diff (`d1c3ffb`) with fresh eyes against the prior code,
then audited `nat-service.ts`, `host.ts`, the test file, and `docs/cadre-host.md`.

**Verified correct:**
- **Ordering guarantee holds.** `host.ts:324` awaits `natService.start()` before
  `createLocalUiServer` (`:331`) and `server.start()` (`:340`). The only
  invite-minting path is the management API on that server (`/auth/invites`); the
  `cadre-host invite` CLI subcommand (`host.ts:489`) POSTs to an already-running
  host. No mint path bypasses the awaited start.
- **Retry scope is right.** Retries only `node_unavailable`; any other error logs
  and gives up (no infinite retry on a real bug — covered by the "non-transient
  error" test). `node_unavailable` correctly covers both the thrown-transport case
  and the empty-peerId case (`getInviteAddresses`, `nat-service.ts:250-260`).
- **Stop-safe** (`if (!this.started) return;` each iteration) and **early-out on no
  listeners** preserves the existing suite's semantics (listeners registered after
  `start()` see zero initial-push notifications).
- **Type safety:** `NatError.code` is typed `NatErrorCode`; `'node_unavailable'`
  is a valid member (`nat/types.ts:100-117`). No `any`.
- **Resource cleanup:** module-private `sleep()` uses an unref'd timer, so the
  retry loop never holds the process open.
- **Build + tests green:** `yarn workspace @serfab/cadre-host test` → 333 passed /
  4 skipped (nat-service: 21 tests). `yarn workspace @serfab/cadre-host build`
  (tsc + vite) clean. (cadre-host has no `lint` script; root `lint` skips it.)

**Fixed inline this pass:**
- **Added a happy-path regression test** (`delivers the initial push exactly once
  when the node is ready on the first attempt`, `makeFlakyNode(0)`): listener
  registered *before* `start()`, node ready immediately → push fires exactly once
  and `peerIdCalls() === 1` (no retry). The implementer's suite covered
  retry-then-success, give-up, and non-transient-error, but not the common
  production case of an immediately-ready node with a pre-start listener — guards
  against a regression that double-fires or skips the zero-retry path.
- **Updated `docs/cadre-host.md:99`** to state the spawn-time push is a bounded
  retry awaited inside `start()`, gating the invite-minting API. The doc already
  claimed the manager pushes "at spawn"; the fix is what makes that actually true.

**Noted, no change (minor / by-design / out of scope):**
- **Latent clock coupling (not currently reachable):** the deadline is computed
  from `nowFn()` but `sleep()` uses the real `setTimeout`. A future test (or
  caller) injecting a frozen fake clock *and* a pre-start listener against a
  perpetually-unavailable node would spin forever. Not triggered today — no test
  injects `now`, and production uses the real clock for both. If fake-timer tests
  are ever added here, base the deadline on real time (or drive `sleep` off the
  same clock). Left as-is to keep the change minimal.
- **Retry keys on read-readiness, not push success.** The loop retries until
  `getInviteAddresses()` (admin GETs) succeeds, then notifies listeners; a failure
  of the listener's `pushInviteAddresses` POST is swallowed by
  `notifyAddressListeners` and does not re-trigger the loop. This matches the
  pre-existing best-effort listener contract (same as `fireAddressesChanged`), and
  read+push share one admin channel, so a read-success/push-failure split is
  unlikely. Not widened.
- **No host.ts-level integration test** of the real spawn-then-bind race (the
  orchestrator child is detached and heavyweight; not reliably agent-runnable).
  The ordering is a single linear await sequence verified by reading `host.ts`;
  the retry logic itself is unit-tested thoroughly. Acceptable gap.
- **Default 15s `initialPushTimeoutMs` delays UI bring-up** in a genuine sustained
  node outage. This is the ticket's explicit await-for-ordering-vs-fast-UI
  tradeoff, signed off in the plan. SIGINT during the await still terminates the
  process (no handler installed yet → Node default exit), so it is not a hang.
- **DRY:** the empty-listener guard is duplicated in `fireAddressesChanged` and
  `pushInitialAddresses` — both one-liners; not worth a shared helper.

No major findings; no new fix/plan/backlog tickets filed. The residual node-side
guarantee (node refuses to mint until addresses pushed) remains correctly out of
scope; file a backlog ticket if belt-and-suspenders is later desired.

## Validation

- `yarn workspace @serfab/cadre-host test` — 333 passed / 4 skipped.
- `yarn workspace @serfab/cadre-host build` — tsc + vite clean.
