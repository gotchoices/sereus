---
description: Per-peer dial deadline added to NetworkTransactor so unreachable peers fail fast and consensus retries elsewhere
files: ../optimystic/packages/db-core/src/network/i-repo.ts, ../optimystic/packages/db-core/src/transactor/network-transactor.ts, ../optimystic/packages/db-p2p/src/repo/client.ts, ../optimystic/packages/db-p2p/src/protocol-client.ts, ../optimystic/packages/db-p2p/src/libp2p-key-network.ts, ../optimystic/packages/db-p2p/test/protocol-client-dial-timeout.spec.ts, ../optimystic/packages/reference-peer/src/cli.ts, ../optimystic/packages/quereus-plugin-optimystic/src/optimystic-adapter/collection-factory.ts, packages/reference-app-web/src/lib/optimystic.ts
---

## Outcome

A new `dialTimeoutMs` knob (default 3000ms) bounds the dial portion of each
per-peer repo call inside `NetworkTransactor`. The overall `timeoutMs`
budget is unchanged; granularity is the difference. Passing `dialTimeoutMs <= 0`
disables the cap; omitting falls back to 3s. The default is wired into the
reference-peer CLI, the quereus optimystic plugin, and the sereus web
reference app.

A new `DialTimeoutError` (`code === 'DIAL_TIMEOUT'`) is exported from
`@optimystic/db-p2p` so diagnostic surfaces can distinguish "peer was slow"
from generic libp2p dial failures and from user-cancelled aborts.

The fix also closes a latent bug in `Libp2pKeyPeerNetwork.connect`, which
previously ignored its `AbortOptions` parameter — meaning libp2p's built-in
~30s dial timeout was the effective floor. The signal is now forwarded into
both `connection.newStream` and `libp2p.dialProtocol`.

## Review findings

### What I checked

- **Diff (cross-repo)**: read the full implement-stage change set across the
  sereus monorepo and the optimystic working tree. The sereus side is a single
  ~6-line edit in `packages/reference-app-web/src/lib/optimystic.ts`; the
  substantive work lives in optimystic (`db-core`, `db-p2p`, `reference-peer`,
  `quereus-plugin-optimystic`).
- **Lifecycle of the dial timer / parent-signal listener** in
  `ProtocolClient.processMessage`: timer cleared in `finally`, parent-signal
  listener registered with `{ once: true }` and removed in the same `finally`
  (no leak; removal is a harmless no-op when the abort already fired). The
  cleanup runs before the response-wait phase begins.
- **`dialTimeoutMs <= 0` semantics**: confirmed `NetworkTransactor` constructor
  maps `undefined → 3000`, `≤ 0 → undefined (no cap)`, and `> 0 → as-is`; and
  `ProtocolClient` short-circuits the controller when `dialTimeoutMs` is
  undefined/0/negative. Matches the documented contract end to end.
- **`Libp2pKeyPeerNetwork.connect` signal forwarding**: verified both the
  pre-existing-connection (`newStream`) and dial (`dialProtocol`) paths now
  receive the caller's signal. Build passes against the workspace's libp2p
  version, so the `NewStreamOptions` shape is correct.
- **`as any` cast in the pend call**: pre-existing; it's for
  `coordinatingBlockIds` (not in `MessageOptions`), not for the new
  `dialTimeoutMs`. Not introduced by this ticket.
- **Cross-call wiring**: confirmed `NetworkTransactor` now passes
  `dialTimeoutMs` through every `getRepo(peer).{get,pend,commit,cancel}`
  call site (initial gets, retry gets, pend with `coordinatingBlockIds`,
  commit, cancel-action, cancel-batch). No call site omits the option.
- **Exports**: `DialTimeoutError` and `DIAL_TIMEOUT_ERROR_CODE` reach
  consumers via `@optimystic/db-p2p`'s `index.ts` and `rn.ts` re-exports —
  diagnostic-surface consumers can do `instanceof DialTimeoutError`.
- **Validation**: `yarn build` clean on db-core, db-p2p, reference-peer,
  quereus-plugin-optimystic; `yarn typecheck` clean on
  `sereus/packages/reference-app-web`; `yarn test` green on
  `@optimystic/db-core` (302 passing) and `@optimystic/db-p2p` (446 passing,
  5 pending — three more than baseline due to the test added below). One
  pre-existing flaky test (`fresh-node-ddl-multi.spec.ts` "Scenario B —
  5-node cold-start with one peer down at boot") failed on a first run and
  passed on a re-run; it is unrelated to this ticket — runs green in
  isolation and uses a `coordinatorRepo`-shaped mock that bypasses the new
  dial-timer codepath.

### Findings & disposition

- **Test gap (fixed inline)** — the implementer flagged that no automated
  test covered the dial-timer codepath. Added
  `optimystic/packages/db-p2p/test/protocol-client-dial-timeout.spec.ts`
  with three focused unit tests:
    1. A hanging `IPeerNetwork.connect` causes `DialTimeoutError` (and the
       correct `code`) within `dialTimeoutMs + epsilon` (100ms cap, asserted
       under 500ms for CI jitter slack).
    2. Omitting `dialTimeoutMs` results in `undefined` being passed as the
       dial signal — no cap is imposed.
    3. Parent-signal abort propagates through to the dial and surfaces the
       parent's reason (not a `DialTimeoutError`).
  All three pass; the suite as a whole is green.
- **Diagnostic UI surfacing (left for follow-up)** — `DialTimeoutError` is
  now distinguishable, but threading it into the existing diagnostic panel /
  error ring buffer was *not* in this ticket's scope and is genuinely
  UI-shaped work. Out-of-scope; no new ticket filed because the implementer
  already called it out as a follow-up class of work.
- **Other `ProtocolClient` subclasses** (`ClusterClient`, `DisputeClient`,
  `SyncClient`, `BlockTransferService`) — inherit the new option but no
  caller threads it through. Mirrors today's behaviour and is intentionally
  out of scope; not filing a follow-up.
- **3s default for browsers** — implementer raised the question of whether
  3s is too aggressive for browser → service-peer over a circuit-relay hop.
  No regression observed in the localhost mesh and existing tests, and the
  knob is per-caller, so an individual app can raise it. Leaving the
  default at 3s; documented in the sereus `optimystic.ts` comment why
  browsers warrant a tight cap. Not filing a follow-up.
- **`abortOrCancelTimeoutMs` proportional tightness** — cancel total budget
  (10s in sereus / reference-peer, 5s in quereus plugin) with a 3s
  dial cap leaves ~3 retries before total cancel timeout. Cancel is
  best-effort; no action.
- **Tier 2 e2e re-run** — not in this ticket's scope; explicitly deferred
  to the companion ticket `web-e2e-tier2-data-convergence-relay` for the
  reachability piece. No action here.

### Categories with nothing to report

- **Type safety**: no new `any` introduced; `DialTimeoutError` is properly
  typed and exported. The pre-existing `as any` on `coordinatingBlockIds`
  predates this ticket.
- **Resource cleanup**: timer + listener lifecycle correct (see above).
- **Performance**: one `setTimeout` and one `AbortController` per dial
  when a cap is configured; negligible overhead vs the dial itself.
- **DRY**: the cap is plumbed through the existing options object rather
  than adding parallel parameters; default lives in one place
  (`DEFAULT_DIAL_TIMEOUT_MS` in `network-transactor.ts`).
- **Cross-platform**: `AbortController` / `setTimeout` / `addEventListener`
  on `AbortSignal` are all available in Node, browsers, and RN runtimes
  the project targets.

## Validation summary

- `yarn build` — green on db-core, db-p2p (optimystic).
- `yarn typecheck` — green on sereus reference-app-web.
- `yarn test` — green on db-core (302), db-p2p (446 passing / 5 pending),
  reference-peer (4).
- New `protocol-client-dial-timeout.spec.ts` — 3 passing in ~170ms.
