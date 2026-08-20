----
description: A test scenario that stands up a NAT'd receiver behind a relay was using a configuration shape a recent guard now rejects; it has been switched to the accepted shape and the scenario now passes.
files: packages/integration-tests/src/scenarios/push-wake-e2e.integration.ts, packages/cadre-core/src/relay-addrs.ts, packages/integration-tests/src/harness/node-fixtures.ts
difficulty: easy
----

# `push-wake-e2e`'s NAT'd-receiver scenario now uses `network.relayAddrs`

## Root cause (from `tickets/fix/push-wake-scenario-still-configures-a-relay-listener.md`)

`control-db-bring-up-runs-before-first-connection` (commit `370ad30`) added
`rejectConfiguredCircuitListenAddrs` (`packages/cadre-core/src/relay-addrs.ts:157`),
which throws when `network.listenAddrs` names a relay directly
(`<relay>/p2p-circuit`) on a control node — that shape makes libp2p dial the relay
from inside `listen()`, before control-database bring-up accepts any connection.
The scenario's "NAT'd receiver reachable only via a circuit relay" test
(`push-wake-e2e.integration.ts`, describe block "delivers a wake to a NAT'd
receiver over a circuit-relay (signaling-first) dial") still configured its
receiver `Rx` that exact way and was failing before it reached any push-wake
behaviour. `network.relayAddrs` (`relay-addrs.ts`'s `'search'` route) is the
prescribed replacement: the control node listens on the bare `/p2p-circuit`
search address and `CadreNode.start()` (`cadre-node.ts:4614`
`driveControlRelayReservation`) drives the reservation explicitly, after
control-database bring-up, throwing `RelayReservationFailedError` if the first
attempt (10 s) lands nothing.

## What was already done in this pass

`packages/integration-tests/src/harness/node-fixtures.ts` already had a
`relayAddrs` option on `controlNodeConfig` (`ControlNodeOpts.relayAddrs`,
node-fixtures.ts:63) wired through to `network.relayAddrs` — nothing there needed
to change.

`push-wake-e2e.integration.ts`'s NAT'd-receiver scenario was edited:

- `Rx`'s config changed from `listenAddrs: [\`${lAddr}/p2p-circuit\`]` (the
  rejected CONFIGURED shape) to `listenAddrs: [], relayAddrs: [lAddr]` (the
  SEARCH-route shape `controlNodeConfig` already supports).
- Added an assertion right after `await Rx.start()` that `Rx`'s live control
  multiaddrs (`controlAddrs(Rx)`) are non-empty and *every* entry contains
  `/p2p-circuit` — i.e. the receiver this scenario claims to test is reachable
  ONLY via the relay, not just "the relay address happens to work."
  `Rx.start()` already blocks on `driveControlRelayReservation` and throws on
  failure, so this assertion cannot pass on a lucky race.
- The two `waitUntil` polls that followed (waiting for a control connection,
  then waiting for the `/p2p-circuit` addr to appear) were removed — they are
  now provably redundant, since `Rx.start()` itself blocks until the
  reservation lands or throws. The existing `expect(circuitAddr).toBe(rxCircuitAddr)`
  check (that the reservation matches the address record `L` vouched for) was
  kept, just reading from the already-captured `controlAddrs(Rx)` snapshot
  instead of re-polling.
- Removed the now-unused `RESERVATION_WAIT` const and `waitUntil` import.
- Updated the file's header comment (the "Scenario 2 — NAT receiver listen
  address" paragraph) and the inline comment above `Rx`'s construction to
  describe the `relayAddrs`/SEARCH-route shape instead of the rejected
  CONFIGURED one.

No change was needed to `relay-addrs.ts` itself — the guard added by
`control-db-bring-up-runs-before-first-connection` is correct and is not part of
this ticket's scope; `files:` above lists it only because the ticket's root
cause lives there.

## Verification run in this pass

```
$ cd packages/integration-tests && yarn vitest run src/scenarios/push-wake-e2e.integration.ts -t "circuit-relay"
 ✓ delivers a wake to a NAT'd receiver over a circuit-relay (signaling-first) dial  2315ms
 Test Files  1 passed (1)
      Tests  1 passed | 3 skipped (4)

$ yarn vitest run src/scenarios/push-wake-e2e.integration.ts   # all 4 scenarios, unfiltered
 ✓ wakes a hibernating member over a real direct control dial                       1820ms
 ✓ delivers a wake to a NAT'd receiver over a circuit-relay (signaling-first) dial   1845ms
 ✓ rejects a wake and strand-addr from a peer whose membership row exists but whose voucher owner is unanchored   523ms
 ✓ wakes a member whose authorization and address were learned by control-DB replication, not local seeding       2509ms
 Test Files  1 passed (1)
      Tests  4 passed (4)

$ cd C:/projects/sereus && yarn eslint packages/integration-tests/src/scenarios/push-wake-e2e.integration.ts
(no output — clean)

$ cd packages/integration-tests && yarn tsc --noEmit -p .
(no output — clean)
```

All four scenarios in the file pass, including the two documented pre-existing
failures noted in the fix ticket (`push-wake-e2e` → "wakes a member whose
authorization and address were learned by control-DB replication" and its
sibling class in `tickets/.pre-existing-known.md` lines 111-113) — those are
flagged as intermittent there, not deterministic, and were green on this run.
No `.pre-existing-error.md` was written; nothing failed.

## Known gaps for review

- Only this one test file was run — not the full `integration-tests` suite —
  since the fix ticket's full-suite measurement (`tickets/.logs/garden-integration-2026-08-20.log`)
  already isolated this as the one live regression outside the documented
  pre-existing set. Review should decide whether to re-run the full suite (it's
  the kind of long-running validation the ticket workflow flags as not
  necessarily agent-runnable inside one pass — the referenced log took long
  enough to be logged rather than run inline).
- The two `waitUntil` removals are a behavior-neutral simplification riding
  along with the required fix (they're provably redundant once `Rx.start()`
  blocks on the reservation), not something the ticket asked for — flagging so
  review can decide if that scope creep is acceptable or should be reverted to
  keep the diff minimal.

## TODO

Confirm the diff above, re-run the verification commands if desired, and write
the `review/` handoff.
