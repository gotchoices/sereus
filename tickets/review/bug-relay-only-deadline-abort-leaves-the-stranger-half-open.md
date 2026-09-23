description: A node that lets a stranger connect only so it can ask to borrow forwarding capacity is supposed to hang up after five seconds when the stranger never asks. It was hanging up in a way that never reached the network, so the stranger's socket stayed open and the node accumulated one dead socket per stranger; it now hangs up for real.
architecture: docs/architecture.md#relay-integration
files:
  - packages/cadre-core/src/membership-connection-gater.ts (the fix, the new close bound, the NOTE, and five doc passages)
  - packages/cadre-core/src/index.ts (one added constant export)
  - packages/cadre-core/test/membership-connection-gater.spec.ts (the connection double and the five deadline cases)
  - packages/cadre-core/test/relay-admission-deadline.spec.ts (NEW — the real-transport regression spec)
  - packages/integration-tests/src/scenarios/relay-only-control-addr.integration.ts (case 4's comment and wait)
  - packages/integration-tests/src/scenarios/control-stream-authz.integration.ts (case (a)'s comment and wait)
  - packages/integration-tests/src/scenarios/control-cohort-cold-start-retry.integration.ts (a header comment that described the old broken timing)
  - docs/architecture.md (the "Relay Integration" line that said the connection is aborted)
repro: verified
----

# What changed

`PendingReserveDeadlines.expire` used to end an expired relay-only connection with `maConn.abort(...)`. On the WebSocket transport that call never reaches the network: `@libp2p/websockets@10.1.3` resets by calling `websocket.close(1006)`, RFC 6455 forbids an endpoint from sending code 1006, `ws` throws, and `AbstractMessageStream.abort()` swallows the throw. The local end flipped to `aborted` — so the relay dropped the connection from its own list immediately — while the socket stayed up on both machines. One leaked socket per stranger, held for as long as the stranger kept it.

`expire` now delegates to a new private `drop()`, which awaits a bounded `maConn.close({ signal: AbortSignal.timeout(RELAY_ADMISSION_CLOSE_TIMEOUT_MS) })` and falls back to `abort()` only if that close rejects. Two constraints are load-bearing and are documented at the site:

- **Close first, abort second, never the reverse.** `abort()` marks the connection `aborted`, and `close()` returns immediately on any status but `open`, so aborting first would turn the close into a silent no-op.
- **The close must be bounded.** `AbstractMultiaddrConnection.close()` awaits an `idle`/`drain` event when it holds unsent bytes, and an unsignalled wait never ends. The gate writes nothing to a stranger, so that wait is not reachable today; the bound exists so a timer callback can never hold an unending await. `RELAY_ADMISSION_CLOSE_TIMEOUT_MS` is a new exported constant (2 s) beside `RELAY_ADMISSION_RESERVE_DEADLINE_MS`, also re-exported from `packages/cadre-core/src/index.ts` alongside the module's four other constants.

Prose that claimed the deadline "aborts" was corrected in five places in `membership-connection-gater.ts` (module doc bullet, the deadline constant, `createMembershipConnectionGater`'s paragraph, the `PendingReserveDeadline` interface comment, the `PendingReserveDeadlines` class doc), in `docs/architecture.md`'s "Relay Integration" line, and in the two scenario comments. The `'deny'` path's abort of the *upgrade* was deliberately left alone — that one is still what happens.

# Tests

| Test | What it verifies |
| --- | --- |
| `membership-connection-gater.spec.ts` → "admits an admit-for-relay connection, then CLOSES it when no reservation is admitted in time" | The deadline fires `close()` and does **not** fire `abort()`. Rewritten from a case that asserted the opposite. |
| `membership-connection-gater.spec.ts` → "aborts the expired connection only when the close itself fails" | **New.** A double whose `close` rejects still reaches the `abort()` fallback. |
| `membership-connection-gater.spec.ts` → "an admitted reservation disarms…", "a REFUSED reservation leaves the deadline armed…", "a plain admit arms no deadline" | Unchanged claims, re-pointed at `close`. |
| `relay-admission-deadline.spec.ts` (new file, one case) | **The reproduction, at the lowest layer that reproduces it.** Two plain libp2p WebSocket nodes, the gater over an `'admit-for-relay'` policy with a 1 s deadline; asserts the **dialer's** connection leaves `open` within 5 s. |

The doubles could not have caught this bug and still cannot on their own: the old `abortableConn()` returned `{ abort: vi.fn() }` with no `close`, so against the fixed code `await maConn.close(...)` threw `TypeError` and the fallback called `abort` exactly as before — all 54 cases stayed green. The double is now `droppableConn()`, carrying both methods so a case can say which one fired, and the real-transport spec is what actually pins the wire behaviour.

**The new spec was proved to fail against the old behaviour**, not merely to pass against the new: with `drop()`'s close temporarily replaced by an immediate throw (forcing the abort-only path), `relay-admission-deadline.spec.ts` failed with `expected true to be false` — the stranger's connection was still `open` after the full 5 s window. The probe was reverted before any other run.

No test was added for the constant export or for the doc corrections.

# Validation run

All green, in this order:

- `yarn workspace @serfab/cadre-core test` — **138 files, 2261 passed, 1 skipped**, 112 s.
- `yarn workspace @serfab/integration-tests test src/scenarios/relay-only-control-addr.integration.ts src/scenarios/control-stream-authz.integration.ts` — 7 passed. The case the ticket was filed on ("is dropped when it never reserves") passes in **5.4–5.6 s** against its 5 s deadline, versus the `Timeout … after 20000ms` it failed with before.
- `yarn workspace @serfab/integration-tests test src/scenarios/membership-connection-gater.integration.ts src/scenarios/control-cohort-cold-start-retry.integration.ts` — 4 passed (the two other scenarios whose comments reference the deadline).
- `yarn lint` — exit 0. `yarn typecheck` — clean, all three coverage guards green.

Both `lint` and `typecheck` were re-run after the final two edits and passed.

# Known gaps — read before reviewing

**The last test re-run was blocked by a sibling repo, not by this change.** After the validation above, two non-behavioural edits landed: a doc-comment rewording inside `drop()`, and adding `RELAY_ADMISSION_CLOSE_TIMEOUT_MS` to `index.ts`'s export list. The confirming re-run of the two gater specs could not execute — the stale-build guard reported `@optimystic/db-p2p: dist is stale — src was edited after the last build`, meaning that sibling's source is being edited right now. Per `tickets/rules/sibling-repos.md` it was **not** built. `yarn lint` and `yarn typecheck` both ran clean after those two edits, and neither edit touches runtime behaviour, but a reviewer should re-run `yarn workspace @serfab/cadre-core test` once the sibling's `dist` is fresh.

**The abort fallback is itself a no-op on WebSockets.** If the bounded close ever fails, the fallback cannot free the socket either, for the same upstream reason. `MultiaddrConnection` exposes no route down to the raw socket, so this is as far as this layer can go. Recorded as a `NOTE:` at the fallback with its revisit condition (drop the fallback, or go back to a plain `abort()`, once `@libp2p/websockets` sends a legal reset code) and cross-referenced to `tickets/blocked/report-libp2p-websockets-abort-close-code.md`, which is the human's call on reporting or working around the upstream defect. This ticket does not wait on it.

**The scenario waits were tightened from 20 s to 10 s**, as the ticket specified. Measured margin is wide (the drop lands within a few hundred ms of the 5 s deadline, and the whole test takes 5.4–5.6 s), but 10 s is now the headroom on a loaded machine rather than 20 s. If either scenario ever flakes on that bound, the bound is the thing to look at first, not the fix.

**One scenario comment outside the ticket's list was corrected.** `control-cohort-cold-start-retry.integration.ts`'s header explained why that scenario must pass `enableRelay: false`, and its explanation leaned on the broken timing ("B — which learns of that abort no sooner than its next connection-monitor ping — holds the dead connection `open` for several seconds beyond that"). That is no longer true. The requirement itself is unchanged and still stated: with relay on, B's dial is admitted rather than refused, so the step that exists to pin the refusal would never observe one. The scenario was re-run and passes.

**Now newly reachable, deliberately not solved here:** `tickets/backlog/bug-party-run-relay-drops-a-stranger-dialing-through-it` is a different defect at the same file — a peer hop-connecting *through* the relay never touches `denyInboundRelayReservation`, so nothing disarms its deadline. That drop silently did not happen over WebSockets before this change; it will now. That ticket already carries the measurement.

# Suggested review focus

- Does `drop()` behave correctly when the peer closed first? (`close()` on a non-`open` connection returns at once without throwing, so the fallback should stay unreached — this is asserted only indirectly, via the ordinary-path case.)
- Is `RELAY_ADMISSION_CLOSE_TIMEOUT_MS` = 2 s the right bound given the wait it guards is not reachable today?
- Is `relay-admission-deadline.spec.ts`'s 5 s drop window wide enough on a loaded CI machine while still staying under the ~15 s a connection-monitor ping failure would take? Those are the two numbers that keep the spec both sharp and stable.
- The new spec deliberately keeps libp2p's stock connection monitor. Confirm nothing in that file quietly disables it.
