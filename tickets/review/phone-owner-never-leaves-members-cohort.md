description: The any-member invitation scenario now runs with a phone-shaped owner (no listen address), the household shape the feature is for, and the architecture doc states when a member stops waiting on an owner that went offline.
prereq: fret-evicts-an-address-less-peer-that-disconnects
architecture: docs/architecture.md#enrollment-flow-invitation-redeemed-at-any-member
files: packages/integration-tests/src/scenarios/cadre-invite-any-member.integration.ts, docs/architecture.md (Enrollment Flow: Invitation Redeemed at Any Member, new paragraph "The member writes without the absent owner only once the owner has left its cohort")
difficulty: easy
----

# Phone-shaped owner in the any-member invitation scenario

## What changed

- `cadre-invite-any-member.integration.ts`: `buildA` passes `listenAddrs: []`, so owner A is phone-shaped; its control storage and bootstrap peer store still carry across the restart, and the restarted A reconnects by dialing M from that store.
- The invitation expectation changed: with no listen address, `createCadreInvitation` emits only M's addresses (`resolveInviteAddresses` returns `getMultiaddrs()`, which is empty). The test now asserts `members` is non-empty and every address ends in `/p2p/<M>`, replacing `members[0] === A.getMultiaddrs()[0]`.
- Header "Why this shape" rewritten: the phone-plus-member household is the shape under test; eviction is described as leave notice (graceful stop) or dead verdict after three uncontactable ticks, citing the FRET ticket. The "P's first dial fails" paragraph was replaced (the invitation names only M). The `COHORT_EVICTION_MS` comment states both timings.
- `docs/architecture.md`: one paragraph in the any-member enrollment section stating the constraint: a member writes to the peers its FRET ring believes alive; a stopped owner leaves on its leave notice or after three probe ticks (~5 s) regardless of having an address; a write inside that window waits the commit budget and fails retryably.

## Validation

- Linked FRET (`../optimystic/packages/db-p2p/node_modules/p2p-fret` → `../Fret`, version 1.0.2) carries both arms in its `dist`: `nearProbeTargets` returns `uncontactable` and `strikeUncontactable` strikes them (arm 1); the libp2p facade runs its shutdown in `beforeStop` so leave notices go out before connections close (arm 2).
- Scenario run three times (one with `DEBUG='optimystic:fret*,sereus:integration:cohort'`), all passed. The eviction time printed was 1013, 1014 and 1015 ms. That is the first 1 s poll, so the leave notice evicts A. P was admitted on attempt 1 each time, in 673–748 ms. The returning A listed P about 1.56 s after it reconnected.
- `yarn lint` and the integration-tests `typecheck` pass.

## Known gaps / for the reviewer

- **Arm 1 (dead verdict for an address-less peer that sends no leave notice) is not exercised here.** The scenario stops A gracefully, so the leave notice evicts it first. The ticket's expectation of "~5 s, same as addressed" no longer describes this scenario: eviction is now ~1 s. Arm 1 is pinned in FRET's own suite (`../Fret/packages/fret/test/address-less-departure.spec.ts`, "marks a vanished address-less member dead after three spaced ticks"). Exercising it here would need a way to kill a CadreNode without its libp2p `beforeStop` running; I did not add one.
- The debug run logged one error on M during A's stop: `fret/1.0.0/leave handler error - StreamStateError: Cannot write to a stream that is closed`. The leave was processed, because the cohort dropped A at the next poll. The handler's reply write failed because A had already closed the stream. This is noise on FRET's side, not a sereus defect; the reviewer may decide whether it is worth a note in the FRET repo.
- The doc says a write in the window "fails retryably" without naming the code. I did not confirm whether the `Some peers did not complete` failure maps to `conflict` or `internal`; both are retryable.

## Tests

No new test. The existing integration scenario is the reproduction, now in the phone-owner shape.
