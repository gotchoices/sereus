description: A new test proves two people whose phones each use a DIFFERENT forwarding (relay) server can still form a shared workspace and exchange data both ways; it passed on the first try with no product change. Review the test refactor and the doc updates.
architecture: docs/strands.md
files: packages/integration-tests/src/scenarios/blind-relay-phone-to-phone-e2e.integration.ts, docs/testing.md, docs/strands.md, docs/architecture.md, docs/reference-app-rn.md, tickets/backlog/feat-phone-relays-through-its-own-always-on-node.md
----

# Two phones, two different relays — third arm of the blind-relay scenario

## What landed

`blind-relay-phone-to-phone-e2e.integration.ts` now runs one body three ways. `runBlindRelayPhoneToPhone(opts: { latency?, relays: 'shared' | 'per-party' })` derives `relayA` (the relay A reserves on) and `relayB` (B's; the same object when shared). Every other difference between the shapes follows from those two variables.

- The two existing `it`s pass `relays: 'shared'`. A third `it` (loopback, no latency) passes `relays: 'per-party'`.
- Reservation counts are checked per relay with a small `reservationTally` helper: `reserved(relay, label)` records one more expected slot and checks EVERY relay; `check(label)` re-checks without recording. Checkpoints: after A's control start, after A founds the strand, after B's control start, after B's `addStrand` resolves (this moved earlier — it used to be the single `toBe(4)` after the peer-book swap), a re-check after the book swap ("with the strand meshed"), and a final re-check after rows crossed both ways.
- After `formStrand`, every connection B's control node holds to A's control peer must have a `remoteAddr` containing `/p2p/<relayA>/p2p-circuit` (B's outbound side only). In the per-party arm this proves the formation dial went through a relay B holds no reservation on.
- `expectOnlyRelayDirect` takes a set of relay peer ids; each node's sweep gets every relay's id.
- The strand-addr "relay speaks no delegate protocol" check runs per distinct relay; teardown stops each distinct relay once (`new Set([relayA, relayB])`).
- The log line reports counts per relay (`relay 1: 2, relay 2: 2`).

## Measured result

Worked with no cadre-core change. Three consecutive full-file runs on 2026-09-29 (Windows dev machine), all three tests green each time:

| arm | wall-clock per run | per-relay reservations |
| --- | --- | --- |
| shared, loopback | 3.55–3.76 s | relay 1: 4 |
| shared, 10 ms `pipelined` | 6.9–7.5 s | relay 1: 4 |
| per-party, loopback | 2.82–2.87 s | relay 1: 2, relay 2: 2 |

Whole file ~25 s. No node took a slot on the relay it only dials through. The mechanism was confirmed in `node_modules/@libp2p/circuit-relay-v2/dist/src/transport/reservation-store.js` (v4.1.3, `addRelay`): a relay nominated by discovery is refused with `HadEnoughRelaysError` while no pending reservation is waiting, and each node's single pending slot is already filled by its own relay.

## Docs updated

- `docs/testing.md` — the cross-party relayed line now describes the per-party arm and its measured counts; the "Uncovered: two-relay circuit shape" bullet is removed; the `WS_SEND_DELAY_MS` sentence says "all three tests". The `WS_FRAME_STATS=1` "Read the right line" paragraph changed too: the per-party test runs after the latency arm and `restore()` does not zero the counters, so the last line of the run is no longer the 10 ms arm's total. The paragraph now names the line printed at that arm's `restore()` as its total.
- `docs/strands.md` — the phone-to-phone paragraph gains the per-party result; "TWO relays" is removed from "Still open" (roaming stays open).
- `docs/architecture.md` Relay Integration — "Untested: the two-relay shape" replaced with the result.
- `docs/reference-app-rn.md` — "both ends are assumed to share it … untested" replaced with "the two ends need not share it", citing the arm.
- `tickets/backlog/feat-phone-relays-through-its-own-always-on-node.md` — its two references to this ticket as "the shape nothing has ever tested" are updated. They now say the two-relay shape is covered over dedicated ungated relays but NOT through each party's own membership-gated cadre node, which is what that ticket still has to make work.

## Validation

- `yarn workspace @serfab/integration-tests exec vitest run blind-relay-phone-to-phone-e2e` — 3×, all green (see table).
- `yarn workspace @serfab/integration-tests run typecheck` — clean.
- `yarn lint` — clean.
- The first run hit the stale-build guard on `@serfab/cadre-host`. It is this repo's own package, left stale by the already-committed port-allocator ticket, so I rebuilt it with `yarn workspace @serfab/cadre-host build`. No sibling repo was built or touched.

## Tests added

None beyond the new arm. The per-party `it` is the test for the two-relay shape. The tally helper has no test of its own (it runs in all three arms).

## Known gaps / things for the reviewer

- **Tripwire, parked as a `NOTE:` in the scenario header:** a node that LOSES its own reservation re-opens a pending slot, which libp2p discovery could fill from the foreign relay (the hop protocol is recorded against it after the cross-relay dial). This arm never loses a reservation, so that path is not reached. It matters only if reservation loss is ever scenarioed in the per-party shape.
- The strand connections' relay is deliberately NOT pinned (after the book swap, A may dial B through relay 2, and either path is legitimate). Only the control formation path is pinned to relay A.
- Only the loopback link is covered for the per-party arm (no latency × two-relay arm, by design: link sensitivity does not depend on which relay each party uses).
- The mid-flow "after B strand node reserves" checkpoint now runs right after `addStrand` resolves instead of after the book swap, using the same "circuit address is announced ⇒ relay has stored the reservation" reasoning as the A-strand checkpoint. The old post-swap position is still checked by `tally.check('with the strand meshed')`.
- Run logs are in `tickets/.logs/feat-scenario-two-relay-circuit*.log` (git-ignored, pruned by the runner).
