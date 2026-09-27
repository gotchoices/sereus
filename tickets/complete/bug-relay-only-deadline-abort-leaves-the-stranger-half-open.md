description: A node that lets a stranger connect only so it can ask to borrow forwarding capacity is supposed to hang up after five seconds when the stranger never asks. It was hanging up in a way that never reached the network, so the stranger's socket stayed open and the node accumulated one dead socket per stranger; it now hangs up for real.
architecture: docs/architecture.md#relay-integration
files:
  - packages/cadre-core/src/membership-connection-gater.ts (the fix, the bounded close, the NOTE, and five doc passages)
  - packages/cadre-core/src/index.ts (one added constant export)
  - packages/cadre-core/test/membership-connection-gater.spec.ts (the connection double and the five deadline cases)
  - packages/cadre-core/test/relay-admission-deadline.spec.ts (NEW — the real-transport regression spec)
  - packages/integration-tests/src/scenarios/relay-only-control-addr.integration.ts
  - packages/integration-tests/src/scenarios/control-stream-authz.integration.ts
  - packages/integration-tests/src/scenarios/control-cohort-cold-start-retry.integration.ts
  - docs/architecture.md (the "Relay Integration" line)
repro: verified
----

# What landed

`PendingReserveDeadlines.expire` used to end an expired relay-only connection with `maConn.abort(...)`. On the WebSocket transport that call never reaches the network: `@libp2p/websockets` resets by calling `websocket.close(1006)`, RFC 6455 forbids an endpoint from sending code 1006, `ws` throws, and `AbstractMessageStream.abort()` swallows the throw. The local end flipped to `aborted` — so the relay dropped the connection from its own list immediately — while the socket stayed up on both machines. One leaked socket per stranger, held for as long as the stranger kept it.

`expire` now delegates to a new private `drop()`, which awaits a bounded `maConn.close({ signal })` and falls back to `abort()` only if that close fails. Two constraints are load-bearing and documented at the site:

- **Close first, abort second, never the reverse.** `abort()` marks the connection `aborted`, and `close()` returns immediately on any status but `open`, so aborting first would turn the close into a silent no-op. Verified against the installed `@libp2p/utils` — `AbstractMultiaddrConnection.close()` opens with `if (this.status !== 'open') return`, and `AbstractMessageStream.abort()` short-circuits only on `aborted`/`reset`/`closed`, so the fallback is still reachable after a close that failed partway (status `closing`).
- **The close must be bounded.** `AbstractMultiaddrConnection.close()` awaits an `idle`/`drain` event when it holds unsent bytes, and an unsignalled wait never ends. The gate writes nothing to a stranger, so that wait is not reachable today; the bound exists so a timer callback can never hold an unending await. `RELAY_ADMISSION_CLOSE_TIMEOUT_MS` (2 s) is a new exported constant beside `RELAY_ADMISSION_RESERVE_DEADLINE_MS`, re-exported from `packages/cadre-core/src/index.ts` alongside the module's four other constants.

Prose that claimed the deadline "aborts" was corrected in five places in `membership-connection-gater.ts`, in `docs/architecture.md`'s "Relay Integration" line, and in three scenario comments.

Independent corroboration found during review: libp2p's own WebSocket listener uses exactly this remedy — when `upgradeInbound` rejects, `@libp2p/websockets`' `listener.ts` tears the connection down with `maConn.close()`, not `abort()`. The fix matches upstream's own pattern for the identical situation.

# Review findings

## Fixed in this pass (minor)

**`AbortSignal.timeout` is prohibited in this repository, and using it silently restored the bug on React Native.** `drop()` bounded its close with `AbortSignal.timeout(RELAY_ADMISSION_CLOSE_TIMEOUT_MS)`. Two existing sites document why that is not allowed: `packages/cadre-core/src/relay-reservation.ts:354` ("An explicit controller, not `AbortSignal.timeout` — the latter is not reliably present on React Native/Hermes, which runs this same module") and `packages/reference-app-rn/src/ice-config.ts:29` ("Do NOT use `AbortSignal.timeout`"). `membership-connection-gater.ts` is loaded on React Native: `cadre-node.ts:1695` builds the gater for every control node, and `@serfab/cadre-core` ships a `react-native` export condition. Worse, the call sits *inside* `drop()`'s `try`, so on Hermes the `TypeError` would be caught, logged as a close failure, and fall straight through to the `abort()`-only path — that is, silently back to the defect this ticket exists to fix, on the one platform where nothing would notice.

Fixed by routing the bound through `withDeadline` from `control-stream.ts`, the repository's own cross-platform deadline primitive (explicit `AbortController` + `setTimeout`, and it cancels the operation as well as rejecting). `control-stream.ts` is dependency-free by design, so the import graph stays acyclic. This also removed an untested inline timeout: `withDeadline` and its underlying `withTimeout` already carry coverage in `control-stream-exchange.spec.ts` and `control-stream-timeout.spec.ts`, so the bound needed no new test of its own. The constant's doc comment now records why the helper is used rather than the global.

**Stale prose in an open sibling ticket.** `tickets/backlog/bug-party-run-relay-drops-a-stranger-dialing-through-it.md` described the gate as "aborts it unless a reservation ... is admitted". Corrected to "closes it". That ticket's own closing section already tracks the behavioural change and asks a human to re-read its `severity`/`likelihood`, which is deliberately left as the human's call.

## Checked and clean

- **Sibling sites with the same defect class.** Swept every `.abort(` in `packages/cadre-core/src`. The only other call sites (`control-stream.ts:116,172`) abort *yamux substreams*, not the raw `MultiaddrConnection` — a yamux reset is an RST frame written over a still-live socket, so it does reach the wire. No second instance, therefore no class-level ticket.
- **The `'deny'` verdict path, which the implementer declared out of scope.** Traced it rather than taking the claim: `libp2p/src/upgrader.ts` `shouldBlockConnection` only throws, and `@libp2p/websockets/src/listener.ts:226` tears the failed upgrade down with `maConn.close()`. A gater deny therefore already closes gracefully and does not leak. The claim holds.
- **Documentation.** Grepped `docs/` and `packages/*/src` for every description of the deadline. `docs/architecture.md:376`, `cadre-node.ts:1782` ("drops the connection"), `relay-addrs.ts`, `delegate-admission.ts` and `strand-revocation-enforcer.ts` all now read correctly. `tickets/backlog/debt-relay-reservation-decision-repeatable-cost.md` references only the 5 s window, which is unchanged.
- **Tests, as code under review.** The six cases were weighed against the "tests must pay for themselves" bar and all six survive: five pin branching deadline logic (fires / disarms / refused-still-fires / plain-admit-arms-nothing / fallback-on-close-failure) and `relay-admission-deadline.spec.ts` is the bug's reproduction at the lowest layer that reproduces it. Nothing restates the implementation and nothing mocks a module this repository owns — the doubles stand in for the libp2p `MultiaddrConnection` seam. No test was cut and none was added.
- **The new spec's placement and budget.** Real-libp2p specs in `packages/cadre-core/test/` are the established pattern (22 files use `createLibp2p`), so it is not misplaced. Its 5 s drop window sits inside the package's 30 s `testTimeout` and well under the ~15 s a connection-monitor ping failure would take, so the spec stays both sharp and stable; the file keeps the stock connection monitor, confirmed by reading it.
- **Error handling and cleanup.** `drop()` cannot reject — both paths are wrapped and logged, and `expire` marks the call `void`, matching the project's unused-promise rule. The map entry is removed before the close begins, and a timer firing against an already-gone connection is a genuine no-op given `close()`'s status guard.

## Recorded, not filed

- `withDeadline`'s timer is not `unref`'d, where the class deliberately unrefs its deadline timers so an armed deadline never holds the process open. The exposure is at most 2 s, and only while a close is actually in flight — which is the entire purpose of the bound. Not worth a comment at the site; noted here.
- The abort fallback remains a no-op on WebSockets for the same upstream reason, so a failed close cannot free the socket either. The implementer recorded this as a `NOTE:` tripwire at the fallback with its revisit condition (drop the fallback, or return to a plain `abort()`, once `@libp2p/websockets` sends a legal reset code), cross-referenced to `tickets/blocked/report-libp2p-websockets-abort-close-code.md`. Left as is — correctly placed and correctly scoped.
- `RELAY_ADMISSION_CLOSE_TIMEOUT_MS` is exported with no external consumer. Left alone: the module's four other constants are exported the same way, and breaking that symmetry costs more than it saves.

## Not found

No correctness, resource-cleanup, type-safety, or source-hygiene defect beyond the one above. Specifically: no unbounded await, no swallowed exception, no `any`, no file over its useful size (`membership-connection-gater.ts` is 580 lines and decomposed — `expire` delegating to a named `drop()` is the right shape), and no comment that narrates a statement rather than stating a constraint.

# Validation

All green, after the review fix, in this order:

- `yarn lint` — exit 0.
- `yarn typecheck` — exit 0; all three coverage guards green (361 test files across 9 packages, 0 allowlisted).
- `yarn workspace @serfab/cadre-core test` — **138 files, 2261 passed, 1 skipped**, 111 s.
- `yarn workspace @serfab/cadre-core build` — exit 0 (needed after the source edit; the integration suite runs compiled output).
- `yarn workspace @serfab/integration-tests test relay-only-control-addr control-stream-authz control-cohort-cold-start-retry` — 3 files, 8 passed. The case this ticket was filed on ("is dropped when it never reserves") passes in **5.30 s** against its 5 s deadline and its tightened 10 s wait, versus the `Timeout … after 20000ms` it failed with before.

**The implement stage's one open gap is now closed.** That handoff could not re-run the cadre-core suite after its last two edits because the stale-build guard reported `@optimystic/db-p2p: dist is stale`. That sibling's `dist` is fresh again, the guard passed, and the full suite ran clean — no sibling repository was built.

No pre-existing failures surfaced.
