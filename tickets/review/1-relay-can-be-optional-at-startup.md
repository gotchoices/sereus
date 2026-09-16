description: A node that is told to use a forwarding server can now be configured to boot even when that server is unreachable, instead of always refusing to start — needed for phones and browser tabs, which have to start with no network.
files: packages/cadre-core/src/types.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/relay-addrs.ts, packages/cadre-core/test/cadre-node-relay-optional.spec.ts, packages/cadre-core/test/cadre-node-relay-boot-failure.spec.ts, packages/cadre-core/test/cadre-node-control-node-options.spec.ts, docs/architecture.md
----

# `network.relayAddrs` gets an optional posture

## What changed

Added `requireRelay?: boolean` to `NetworkConfig` (`packages/cadre-core/src/types.ts`), default `true`. Read in exactly one place: `CadreNode.driveControlRelayReservation` (`packages/cadre-core/src/cadre-node.ts`, private method at the end of `start()`). When the first relay-reservation attempt does not land a `/p2p-circuit` address and `requireRelay === false`, it logs the status and returns instead of throwing `RelayReservationFailedError`. The default posture (`requireRelay` absent or `true`) is byte-for-byte unchanged — same throw, same message, same call site.

Nothing else about the reservation machinery changed:

- The bare `/p2p-circuit` search listener (`resolveListenAddrs`) is added regardless of `requireRelay` — a tolerated start still needs somewhere for a later reservation to land.
- `reserveRelays` (the fail-soft entry point browser tabs already use) always starts a retry supervisor on the standard backoff (2s doubling to 60s), whatever `requireRelay` says. `driveControlRelayReservation` calls it unconditionally; `requireRelay` only changes what happens to the returned state.
- `cleanup()` (which both `stop()` and a failed `start()` funnel through) already stopped `relayReserveSupervisor` and reset the posture to `none` before this change — that existing code is what makes `stop()` correctly tear down a tolerated-but-unreserved node. No change was needed there; a test now pins it (see below).
- A malformed `relayAddrs` entry still throws unconditionally at config resolution (`relayCircuitAddrs`, called from `buildControlNodeOptions` well before the reservation is driven) — `requireRelay` does not touch validation.
- A hand-written `<relay>/p2p-circuit` entry in `listenAddrs` is still rejected on the control node (`rejectConfiguredCircuitListenAddrs`) — unrelated to this field, that rejection is about listener shape.
- Strand nodes never read `requireRelay` (`strand-network-config.ts` has no reference to it) — they were already fail-soft over `relayAddrs` before this ticket and stay that way regardless of the control node's posture.

Doc comments updated in three places to describe both postures together: the `relayAddrs` field comment and the new `requireRelay` field comment in `types.ts`; the module header and `RelayReservationFailedError` comment in `relay-addrs.ts`; and the relay-reservation table + prose in `docs/architecture.md` ("Reservations are requested explicitly, not discovered").

## Why a field, not a default change or a new method

`cadre-cli`'s existing behavior is deliberate and documented — see the ticket for the full reasoning. Short version: the two node kinds (a fixed operator-run server vs. a phone/browser tab) genuinely want opposite answers to "is my named relay required", so the posture sits in config next to the addresses it governs, mirroring `requireSignedSchemas`'s existing "fail-closed unless the embedder opts out" pattern.

## For the reviewer: what to check

1. **The default path is untouched.** `driveControlRelayReservation`'s throw branch (`cadre-node.ts`) still reads `throw new RelayReservationFailedError(relayAddrs, state)` for the case `requireRelay` is absent or `true`, and only the new `if (this.config.network?.requireRelay === false)` branch changed anything. `cadre-node-relay-boot-failure.spec.ts` was left with its original two tests unmodified (per the ticket's explicit instruction) — I added a third test to that same file for `requireRelay: true` rather than editing the existing ones, to keep that guarantee visible in the diff.
2. **Caller responsibility for dialability.** The new field's doc comment says a `requireRelay: false` caller must read `getRelayReservationState()` rather than infer dialability from `start()` resolving. I did not add any new assertion helper for this — it is the same `getRelayReservationState()` that already existed for `reserveRelays()` callers. Worth confirming that's sufficient rather than needing something more explicit (e.g. a warning log on every tolerated failure — I did add one `log(...)` call, at `debug('sereus:cadre:node')` level, not a `console.warn`).
3. **Test budget/timing.** The three new specs in `cadre-node-relay-optional.spec.ts` use a genuinely unreachable relay (`127.0.0.1:1`, which refuses instantly) and 60s vitest timeouts, matching the existing dead-relay spec's convention. They do not wait out the retry backoff — they only assert the *first* attempt's outcome (`retrying` with a non-null `retryAtMs`), then stop the node. Full suite run: 131 test files / 2134 passed, 1 skipped (pre-existing, unrelated).
4. **`docs/architecture.md` edit.** I extended the existing two-row table (`network.relayAddrs` / `CadreNode.reserveRelays(addrs)`) to three rows rather than restructuring the section — check that reads cleanly in context; I did not re-verify every other cross-reference in that ~800-line file.

## Known gaps / out of scope

- **No integration test puts this on a real network.** Everything here is a `cadre-core` unit-level `CadreNode.start()`/`stop()` test against a dead-but-real TCP port. `blind-relay-phone-to-phone-e2e.integration.ts` (unmodified) already proves the *reachable* case for this node shape; nothing here re-runs it. If the reviewer wants an integration-level check of `requireRelay: false`, that's new scope, not a gap in what was asked for — the ticket didn't request one and ticket `phone-becomes-reachable-through-a-relay` (already in `implement/`, blocked on this one) is the actual consumer that will exercise it end to end via `blind-relay-phone-to-phone-e2e`'s existing node shape.
- **`docs/reference-app-web`'s `cadre-web.ts` comment** referencing this gap (pointed at by the original plan doc) was **not** touched — it's about `reserveRelays()` reaching the control node only, a pre-existing and still-true limitation unrelated to what this ticket added. Left for whichever ticket actually changes that call site.
- I did not add a supervisor-options passthrough to let a caller shorten the first-attempt timeout for `requireRelay: false` nodes. Ticket `phone-becomes-reachable-through-a-relay` flags "every strand launch waits ~10s longer when its relay is unreachable" as a decision point for itself — that's downstream of this ticket and intentionally not addressed here.

## Tests

`yarn workspace @serfab/cadre-core test` (full suite, 131 files / 2134 passed / 1 skipped), `yarn workspace @serfab/cadre-core typecheck` (clean), `yarn lint` (clean, repo-wide).
