---
description: Review per-peer dial deadline added to NetworkTransactor so unreachable peers fail fast and consensus retries elsewhere
files: ../optimystic/packages/db-core/src/network/i-repo.ts, ../optimystic/packages/db-core/src/transactor/network-transactor.ts, ../optimystic/packages/db-p2p/src/repo/client.ts, ../optimystic/packages/db-p2p/src/protocol-client.ts, ../optimystic/packages/db-p2p/src/libp2p-key-network.ts, ../optimystic/packages/reference-peer/src/cli.ts, ../optimystic/packages/quereus-plugin-optimystic/src/optimystic-adapter/collection-factory.ts, packages/reference-app-web/src/lib/optimystic.ts
---

## What landed

A new `dialTimeoutMs` knob that bounds the **dial portion** of each per-peer
repo call. The existing `timeoutMs` (overall transaction budget) is unchanged —
the difference is *granularity*: a 30s budget with `dialTimeoutMs: 3000` can
afford ten 3s dial attempts against different peers, instead of one stuck peer
monopolising the entire 30s.

### Original investigation (answers the ticket's "Open questions")

- The pre-existing `timeoutMs: 30_000` is the **overall per-call budget** for a
  single `get`/`pend`/`commit`/`cancel`, computed as `expiration = Date.now() + timeoutMs`
  and passed through to `processBatches` (where it gates retries) and to
  `RepoClient.processRepoMessage` (where `withTimeout(msLeft)` wraps the entire
  dial+send+receive flow). So a single stuck dial absorbs `msLeft` for that
  attempt; subsequent retries shrink the remaining budget for the next coordinator.
- The actual dial happens in `Libp2pKeyPeerNetwork.connect`, which used to
  **ignore its `AbortOptions` parameter** (`_options` was unused) — so libp2p's
  built-in dial timeout (~30s) was the effective floor. Anything tighter was
  decorative.
- FRET / reputation: not touched in this ticket. The reputation hooks exist but
  feeding per-peer dial outcomes into selection is a follow-up, not in scope.

### Change shape

1. **`db-core/.../i-repo.ts`** — `MessageOptions` gains optional `dialTimeoutMs?: number`.
2. **`db-core/.../network-transactor.ts`** —
   - `NetworkTransactorInit` gains optional `dialTimeoutMs?: number`.
   - Default `DEFAULT_DIAL_TIMEOUT_MS = 3000`. Pass `dialTimeoutMs <= 0`
     to disable (fall back to overall-budget-only behaviour); omit to use 3s.
   - Forwarded into every `getRepo(peer).{get,pend,commit,cancel}(..., { expiration, dialTimeoutMs })` call site (`get` initial+retry, `pend`, `cancel` (action), `commitBlocks`, `cancelBatch`).
3. **`db-p2p/.../repo/client.ts`** — `RepoClient.processRepoMessage` forwards
   `options.dialTimeoutMs` into `ProtocolClient.processMessage`. The existing
   `withTimeout(msLeft)` wrapper is untouched, so the response wait remains
   bound by the overall budget.
4. **`db-p2p/.../protocol-client.ts`** —
   - New exported `DialTimeoutError` (`.code === 'DIAL_TIMEOUT'`) so callers /
     diagnostic UI can distinguish "peer was slow" from "user cancelled" or
     "libp2p dial failure (no route, refused, etc.)".
   - `processMessage` accepts `dialTimeoutMs`. When set & > 0, an
     `AbortController` is armed with a timer; on timer fire the dial is
     aborted with a `DialTimeoutError`. The timer is cleared as soon as the
     dial returns (success or fail), so it never affects the post-dial
     response wait.
   - Parent `signal` (if present) is chained into the dial controller, and
     the dial controller's listener on the parent is removed in `finally`.
5. **`db-p2p/.../libp2p-key-network.ts`** — `connect()` now **honours the
   `AbortSignal`** by forwarding it to `dialProtocol(...)` and to
   `connection.newStream([protocol], { signal })`. Without this fix, the
   abort upstream in (4) has no effect on a stuck libp2p dial.
6. **Callers wired**:
   - `optimystic/.../reference-peer/src/cli.ts`: `dialTimeoutMs: 3000`.
   - `optimystic/.../quereus-plugin-optimystic/.../collection-factory.ts`:
     `dialTimeoutMs: 3000`.
   - `sereus/packages/reference-app-web/src/lib/optimystic.ts`: new
     `DIAL_TIMEOUT_MS = 3000` constant, threaded into the
     `NetworkTransactor` init in `buildNetworkTransactor`. The constant lives
     beside the existing `NETWORK_TIMEOUT_MS` / `ABORT_OR_CANCEL_TIMEOUT_MS`
     with a comment explaining why browsers warrant a tight cap.

## Why this is a "starting point", not a finish line

The reviewer should treat the following as known gaps and weigh whether any
warrant landing as a follow-up fix:

- **No new automated test** asserts that a hung dial actually times out at the
  per-peer deadline. The mock test fixtures (`MockPeerNetwork` etc.) return
  immediately, so the dial-timer code path is exercised only by happy-path
  callers in existing tests — proven *not to regress*, but not directly
  validated end-to-end. A dedicated test would need to either:
    (a) inject a stalled `IPeerNetwork.connect` (returns a never-resolving
        promise) and assert that the `NetworkTransactor` retry loop moves on
        within `dialTimeoutMs + epsilon`, or
    (b) use the mesh harness with an intentionally-undialable peer.
  Either is straightforward but I chose to skip it under this ticket's scope.
  If the reviewer adds (a) it should live in
  `db-core/test/network-transactor.spec.ts` or a new
  `db-p2p/test/protocol-client.spec.ts`.
- **Surfacing in the diagnostic panel / error ring buffer** (ticket bullet 3)
  was *enabled* (the `DialTimeoutError` is now distinguishable from a generic
  libp2p dial failure and from an aborted/cancelled call), but the UI side
  of the diagnostics panel was not modified. Threading these distinct codes
  into the existing diagnostic UI is a separate, UI-shaped change.
- **Other `ProtocolClient` subclasses** (`ClusterClient`, `DisputeClient`,
  `SyncClient`, `BlockTransferService`) inherit the new
  `dialTimeoutMs` option but no caller passes one to them. They still work
  fine; just not bounded by a per-peer dial cap. That mirrors today's
  behaviour and is intentionally out of scope — the ticket explicitly named
  the transactional layer as the priority.
- **`abortOrCancelTimeoutMs` path**: cancel() also gets the new
  `dialTimeoutMs`, which means a cancel against an unreachable peer also
  fails fast (~3s). The cancel total budget is only 10s, so this is
  proportionally tighter (3/10) than for normal ops (3/30) — fine, but
  worth eyeballing if cancel semantics matter to the reviewer.
- **Tier 2 e2e**: not re-run under this ticket. The companion ticket
  `web-e2e-tier2-data-convergence-relay` addresses the underlying reachability
  via circuit-relay reservations; this ticket reshapes the timeout but does
  not on its own make the e2e tier-2 specs pass. Both should be in place
  before re-running them.

## Validation done

- `yarn build` clean on `@optimystic/db-core`, `@optimystic/db-p2p`,
  `@optimystic/reference-peer`, `@optimystic/quereus-plugin-optimystic`.
- `yarn typecheck` clean on `sereus/packages/reference-app-web`.
- `yarn test` green on:
  - `@optimystic/db-core` — 302 passing.
  - `@optimystic/db-p2p` — 443 passing, 5 pending (unchanged from baseline).
  - `@optimystic/reference-peer` — 4 passing (full 3-node mesh
    distributed-diary spec).

## Suggested review checklist

- Confirm `dialTimeoutMs <= 0` really means "do not impose a separate dial
  cap" by reading the `init.dialTimeoutMs === undefined ? ... : (>0 ? ... : undefined)`
  branch in `NetworkTransactor`'s constructor.
- `ProtocolClient.processMessage`: verify the `dialController` /
  `dialTimer` / `onParentAbort` listener lifecycle — particularly that the
  parent-signal listener is removed in the `finally` (no memory leak per
  dial) and that the timer is cleared before the post-dial response-wait
  path begins.
- `Libp2pKeyPeerNetwork.connect`: confirm `newStream([protocol], { signal })`
  is a valid call (per current `@libp2p/interface` Connection API). On older
  libp2p versions `newStream` might not accept `signal` — if you spot a
  TypeScript error in a transitively-resolved version, drop it from that
  branch and leave only the `dialProtocol` path with the signal.
- 3 seconds: is this aggressive enough / too aggressive? Browser → service
  peer over a circuit-relay hop can be slower than a wired LAN dial. If the
  reviewer wants a higher default for the browser caller specifically,
  consider 5s in `optimystic.ts` while keeping 3s for the reference-peer CLI.

## Use cases / validation cases

1. **Happy path, real libp2p localhost mesh** — distributed-diary spec.
   Confirms no regression on healthy clusters where every dial completes
   sub-second.
2. **Unreachable cluster member** — manually: start a 3-node mesh, block one
   peer's port with a firewall rule after FRET converges, run a write. The
   NetworkTransactor should fail the dial against the blocked peer in ~3s
   and successfully retry against another coordinator before the 30s budget
   is consumed. Pre-change, that write would hang ~30s and then fail outright.
3. **Browser tab as undialable coordinator** — relevant when
   `web-e2e-tier2-data-convergence-relay` also lands. With circuit-relay
   reservations in place, dialing a browser tab via `/p2p-circuit` should
   succeed inside the 3s budget on a local fixture. Without a reservation
   (the partial state) the dial fails fast (~3s) and consensus retries on a
   reachable service peer.
4. **DialTimeoutError surfaces to error aggregate** — when all coordinator
   candidates for a block are unreachable, the eventual
   `NetworkTransactor.pend` aggregate error includes
   `cause=dial timeout: peer=... protocol=... after 3000ms` (via
   `firstBatchError(...)`). Verify this string shape if the diagnostic UI
   relies on substring matching.

## Non-goals (kept out)

- No change to consensus quorum semantics or `findCluster` selection.
- No change to FRET reputation feedback.
- No change to the overall `timeoutMs` budget shape.
