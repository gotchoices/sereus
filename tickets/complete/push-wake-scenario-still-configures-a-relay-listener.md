description: A test scenario that stands up a NAT'd receiver behind a relay was using a configuration shape a recent guard now rejects; it was switched to the accepted shape, reviewed, and passes.
files: packages/integration-tests/src/scenarios/push-wake-e2e.integration.ts, packages/integration-tests/src/harness/node-fixtures.ts, packages/cadre-core/src/relay-addrs.ts
----

# `push-wake-e2e`'s NAT'd-receiver scenario now uses `network.relayAddrs`

## What the problem was

`control-db-bring-up-runs-before-first-connection` (commit `370ad30`) added a guard
in `packages/cadre-core/src/relay-addrs.ts` (`rejectConfiguredCircuitListenAddrs`)
that throws when a control node's `network.listenAddrs` names a relay directly as
`<relay>/p2p-circuit`. That shape makes libp2p dial the relay from inside
`listen()` — before control-database bring-up accepts any connection — so the guard
is correct and stays.

`push-wake-e2e.integration.ts`'s scenario 2 ("delivers a wake to a NAT'd receiver
over a circuit-relay (signaling-first) dial") still configured its receiver `Rx`
that exact way, so the scenario died in ~1.4 s before reaching any push-wake
behaviour.

## What changed

Scenario 2's `Rx` moved to the prescribed replacement, `network.relayAddrs`:

- `listenAddrs: ['<relay>/p2p-circuit']` became `listenAddrs: [], relayAddrs: [lAddr]`.
  `resolveListenAddrs(..., 'search')` turns that into a single bare `/p2p-circuit`
  search listener, and `CadreNode.start()` drives the reservation explicitly after
  bring-up (`driveControlRelayReservation`, `cadre-node.ts:4614`), throwing
  `RelayReservationFailedError` if the first 10 s attempt lands nothing.
- Added an assertion right after `await Rx.start()`: `controlAddrs(Rx)` is non-empty
  and every entry contains `/p2p-circuit` — the receiver is reachable ONLY via the
  relay, not merely "the relay address happens to work".
- Removed two now-redundant `waitUntil` polls (relay connection, `/p2p-circuit` addr
  appearing) plus the `RESERVATION_WAIT` const and `waitUntil` import; `start()`
  already blocks until the reservation lands or throws.
- Updated the file header comment and the inline comment above `Rx`'s construction
  to describe the search-route shape.

No production code changed — this was a test-configuration fix.
`packages/integration-tests/src/harness/node-fixtures.ts` already exposed
`relayAddrs` on `controlNodeConfig` and needed no edit.

## Review findings

**Where the code actually landed.** The implement-stage commit (`bbcd541`) touched
only the ticket file; the code edit landed one commit earlier, in the fix-stage
commit `1b875ee`. Reviewed that diff. Not a defect, but noted so the audit trail is
followable.

**Correctness — confirmed, nothing found.**

- The `waitUntil` removals the implementer flagged as possible scope creep are
  provably safe: `start()` awaits `driveControlRelayReservation`, which throws
  unless `reserveRelays` returns `status === 'reserved'`, and `reserveRelays` only
  reaches that status once the `/p2p-circuit` address has appeared. Accepted as-is.
- `controlNodeConfig` uses `opts.listenAddrs ?? [default]`, so the explicit `[]`
  survives rather than being replaced by the default direct listener. Verified.
- The new "every live addr is a circuit addr" assertion held on 4 consecutive runs
  of the scenario — not flaky.

**Repo sweep for the same defect class — clean.** Searched every `listenAddrs`
usage carrying `/p2p-circuit` across `packages/`. The remaining ones are all the
bare `/p2p-circuit` search address (`relay-only-control-addr.integration.ts`,
`reference-app-web`, `reference-app-rn`), which the guard deliberately allows, or
cadre-core unit tests that assert the rejection itself. No other site still uses the
rejected shape.

**Class-level guard already exists — no ticket filed.** The regression can only
recur as a loud config-time throw, and `packages/cadre-core/test/relay-addrs.spec.ts`
already covers both arms (rejects a hand-written configured circuit entry; resolves
`listenAddrs: []` + `relayAddrs` to the search listener). Nothing to add above the
instance.

**Docs — checked, already current.** `docs/architecture.md` (the relay-reservation
route table around line 834 and the `NetworkConfig` commentary near line 985) was
brought up to date by the guard's own ticket and correctly describes the search
route. `docs/testing.md` does not enumerate individual scenarios. Nothing stale.

**Minor findings — fixed inline in this pass.** The scenario file carried three
dangling references to long-finished tickets that a future reader cannot resolve:
two "this ticket fixed it" phrasings about the `runOnLimitedConnection` change
(header comment and the wake-dial comment), and "See the review handoff for the
follow-up this should spawn". Rewrote the first two to name the change directly,
and pointed the third at the existing backlog ticket that actually tracks the gap.

**Deferred-gap check — existing ticket covers it, no new ticket.** The implementer
asked whether scenario 2's "NAT'd receiver wakes an already-active strand, because
strand-cluster discovery for a relayed cohort is unimplemented" gap needs a ticket.
It does not: `tickets/backlog/strand-network-nat-relay-reachability.md` section 1
("Per-strand NAT reachability") already specifies exactly that work. The file
comment now points there.

**Tripwires — none recorded, deliberately.** The one conditional thing noticed —
`startAddrs.find((a) => a.includes('/p2p-circuit'))` picks the first circuit addr,
so it would become order-dependent if this scenario ever configured a second relay —
would fail loudly and legibly at the assertion if it ever mattered, and a `NOTE:` at
the site would cost more attention than it saves. Nothing parked.

**Blocked/major findings — none.** No finding in this pass rose above minor.

## Verification

```
$ yarn eslint packages/integration-tests/src/scenarios/push-wake-e2e.integration.ts \
              packages/integration-tests/src/harness/node-fixtures.ts     # clean
$ cd packages/integration-tests && yarn tsc --noEmit -p .                 # clean

$ yarn vitest run src/scenarios/push-wake-e2e.integration.ts              # 4 passed (x2, pre-edit)
$ yarn vitest run src/scenarios/relay-only-control-addr.integration.ts    # 5 passed
$ cd packages/cadre-core && yarn vitest run test/relay-addrs.spec.ts \
    test/cadre-node-control-node-options.spec.ts \
    test/cadre-node-announce-addrs-warning.spec.ts                        # 85 passed
```

After the inline comment edits, `push-wake-e2e` ran twice more. Scenario 2 — this
ticket's subject — passed every time (4 runs total). One of the two post-edit runs
had scenario 4 ("wakes a member whose authorization and address were learned by
control-DB replication") fail on `Block default/OwnerKey is unavailable
(claimed-elsewhere)`. That is the documented pre-existing intermittent already
tracked in `tickets/.pre-existing-known.md:112` under the blocked slug
`control-db-cross-node-convergence-halted`; per the workflow rules it is not
re-reported and no `.pre-existing-error.md` was written. Comment-only edits cannot
have caused it, and it was green on the run immediately before.

**Full `integration-tests` suite: not run, by measurement.** The prior full run
(`tickets/.logs/garden-integration-2026-08-20.log`) took 696 s wall clock, which
exceeds the 600 s ceiling on a single agent shell call, so it cannot complete in one
pass. Ran the two most relevant integration scenario files plus the three cadre-core
relay-config unit specs instead. The change touches one test file and no production
code, so the blast radius outside those files is nil. That prior full run's eight
failures were this scenario plus seven documented pre-existing ones; the expectation
for the next full run is seven, all documented.
