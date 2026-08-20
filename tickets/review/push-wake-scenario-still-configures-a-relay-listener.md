description: A test scenario that stands up a NAT'd receiver behind a relay was using a configuration shape a recent guard now rejects; it has been switched to the accepted shape and the scenario now passes.
files: packages/integration-tests/src/scenarios/push-wake-e2e.integration.ts, packages/cadre-core/src/relay-addrs.ts, packages/integration-tests/src/harness/node-fixtures.ts
difficulty: easy
----

# `push-wake-e2e`'s NAT'd-receiver scenario now uses `network.relayAddrs`

## Root cause

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

## What changed

`packages/integration-tests/src/harness/node-fixtures.ts` already had a
`relayAddrs` option on `controlNodeConfig` (`ControlNodeOpts.relayAddrs`,
node-fixtures.ts:63) wired through to `network.relayAddrs` — nothing there
needed to change.

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
  then waiting for the `/p2p-circuit` addr to appear) were removed as
  provably redundant, since `Rx.start()` itself now blocks until the
  reservation lands or throws. The existing `expect(circuitAddr).toBe(rxCircuitAddr)`
  check (that the reservation matches the address record `L` vouched for) was
  kept, reading from the already-captured `controlAddrs(Rx)` snapshot instead
  of re-polling.
- Removed the now-unused `RESERVATION_WAIT` const and `waitUntil` import.
- Updated the file's header comment (the "Scenario 2 — NAT receiver listen
  address" paragraph) and the inline comment above `Rx`'s construction to
  describe the `relayAddrs`/SEARCH-route shape instead of the rejected
  CONFIGURED one.

`relay-addrs.ts` was not touched — the guard added by
`control-db-bring-up-runs-before-first-connection` is correct and out of this
ticket's scope; it's listed under `files:` only because the ticket's root
cause lives there.

## Verification (re-run during review handoff, 2026-08-20)

```
$ cd packages/integration-tests && yarn vitest run src/scenarios/push-wake-e2e.integration.ts
 ✓ wakes a hibernating member over a real direct control dial                       1962ms
 ✓ delivers a wake to a NAT'd receiver over a circuit-relay (signaling-first) dial   1869ms
 ✓ rejects a wake and strand-addr from a peer whose membership row exists but whose voucher owner is unanchored   476ms
 ✓ wakes a member whose authorization and address were learned by control-DB replication, not local seeding       2600ms
 Test Files  1 passed (1)
      Tests  4 passed (4)

$ cd C:/projects/sereus && yarn eslint packages/integration-tests/src/scenarios/push-wake-e2e.integration.ts
(no output — clean)

$ cd packages/integration-tests && yarn tsc --noEmit -p .
(no output — clean)
```

All four scenarios in the file pass, including the two documented pre-existing
intermittent-failure cases noted in `tickets/.pre-existing-known.md` (lines
111-113) — those were green on this run too (intermittent, not deterministic).
No `.pre-existing-error.md` was written; nothing failed.

Only this one test file was run, not the full `integration-tests` suite — the
prior fix-stage full-suite run (`tickets/.logs/garden-integration-2026-08-20.log`)
already isolated this scenario as the one live regression outside the
documented pre-existing set. Re-running the full suite here would be the kind
of long-running validation this ticket workflow flags as not necessarily
agent-runnable inside one pass; reviewer's call whether to re-run it.

## Use cases this scenario protects (for review's benefit)

- A control node with no direct listen address and a configured relay
  (`relayAddrs`) must reach an active `/p2p-circuit` reservation by the time
  `start()` returns, or `start()` must throw — never return with a half-live
  node. Covered by `Rx.start()` blocking on `driveControlRelayReservation`
  plus the new "every live addr contains `/p2p-circuit`" assertion.
- A sender with only a signaling/relay path to a receiver must be able to
  complete the full push-wake round trip (dial, `WAKE_PROTOCOL` handle,
  half-close, multi-chunk framing, ack) over a libp2p "limited" (circuit)
  connection — this is the one scenario in the file that exercises that
  transport; the other three dial directly.
- The relay-vouched address record's ordering (circuit sorts ahead of a
  synthetic direct addr) still resolves correctly on the sender side
  (`resolved[0]` contains `/p2p-circuit`), unaffected by moving `Rx` off the
  CONFIGURED listen shape.

## Known gaps / things flagged for review's judgment

- **Scope creep flag**: the two `waitUntil` removals are a behavior-neutral
  simplification riding along with the required config-shape fix, not
  something the root-cause ticket asked for. They're provably redundant
  (`Rx.start()` already blocks on the reservation) but review should decide
  whether that's acceptable scope or should have been split out.
- **Not re-verified this pass**: the full `integration-tests` suite (see
  Verification section above) — only this one file was run. If review wants
  full-suite confidence, budget for a long-running run outside the 10-minute
  agent idle-timeout window (log it under `tickets/.logs/` if so).
- The file's own header comment (lines 83-97) documents a known, separate gap:
  scenario 2's NAT'd receiver wakes an already-active strand rather than a
  hibernating one, because strand-cluster discovery over the control network
  for a NAT'd/relayed cohort is not yet implemented (`control-network-cohort-discovery`
  is called out as TODO in the comment). That gap is pre-existing and out of
  this ticket's scope — flagging so review can judge whether it warrants its
  own backlog ticket (a search of open tickets under `backlog/`, `fix/`,
  `plan/`, `implement/` for `control-network-cohort-discovery` or
  `strand-cohort discovery` didn't turn up an existing one when this handoff
  was written, but review should re-check before filing since the board can
  move under a running ticket).
