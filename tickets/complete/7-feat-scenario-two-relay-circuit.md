description: A test now proves two people whose phones each use a DIFFERENT forwarding (relay) server can still form a shared workspace and exchange data both ways; it passed with no product change.
architecture: docs/strands.md
files: packages/integration-tests/src/scenarios/blind-relay-phone-to-phone-e2e.integration.ts, docs/testing.md, docs/strands.md, docs/architecture.md, docs/reference-app-rn.md, tickets/backlog/feat-phone-relays-through-its-own-always-on-node.md
----

# Two phones, two different relays — third arm of the blind-relay scenario

## What landed

`blind-relay-phone-to-phone-e2e.integration.ts` runs one body three ways through `runBlindRelayPhoneToPhone({ latency?, relays: 'shared' | 'per-party' })`. `relayA` is the relay A reserves on, and `relayB` is B's (the same object when the relay is shared). Two existing arms (loopback, 10 ms `pipelined` latency) use `shared`. A new loopback arm uses `per-party`, so B's formation and strand dials go through A's relay, where B holds no reservation, and A reaches B through B's relay.

- Reservation counts are checked per relay at every checkpoint by a `reservationTally` helper. Every relay is checked at every step, and once more after rows have crossed both ways. Measured: 2 per relay (that party's control and strand node). No node takes a slot on a relay it only dials through.
- B's outbound control connection to A is asserted to name `/p2p/<relayA>/p2p-circuit`. In the per-party arm, that is the proof the dial crossed relays.
- The sweep that checks for direct fallback connections accepts a direct link to any relay, and teardown stops each distinct relay once.
- No cadre-core change was needed. The reason: `@libp2p/circuit-relay-v2`'s reservation store refuses a relay nominated by discovery while no pending reservation is waiting, and each node's single pending slot is already filled by its own relay.
- Docs updated: `docs/testing.md` (coverage map line, "Uncovered: two-relay" bullet removed, the `WS_FRAME_STATS` "Read the right line" paragraph adjusted for the third test running after the latency arm), `docs/strands.md`, `docs/architecture.md` Relay Integration, `docs/reference-app-rn.md`, and the backlog ticket `feat-phone-relays-through-its-own-always-on-node`.

Measured at implement (3 runs, 2026-09-29): shared loopback 3.55–3.76 s, shared 10 ms 6.9–7.5 s, per-party 2.82–2.87 s. Review run: 3.6 s / 7.1 s / 2.8 s, whole file 25.6 s, same per-relay counts.

## Review findings

Read the implement diff (`ticket(implement): feat-scenario-two-relay-circuit`) in full before the handoff, then the whole scenario file and the harness it depends on.

**Fixed inline (minor):**
- **Relay-path assertion was not limited to B's outbound side, and could pass with nothing checked.** The comment says it pins "B's outbound side only", but the filter took every B→A connection regardless of direction. In the per-party arm, an inbound connection from A (A dialling B through relay B) would carry relay B in its remote address and fail the check for no real reason. The loop also passed trivially if no connection matched. It now filters on `direction === 'outbound'` and asserts at least one such connection exists. This is the same "the formation connection is still open" assumption the existing `NOTE:` above `expectAllPathsRelayed` already covers.
- **Teardown with two relays could leak one.** `for (...) await relay?.stop()` stopped at the first rejection, which left the second relay running and skipped `link?.restore()`. That would bury the next arm's error under "already installed". It now uses `Promise.allSettled`, matching how the nodes are stopped two lines above.

**Checked, no change needed:**
- Moving B's strand reservation checkpoint to right after `addStrand`: this relies on "the circuit address is announced, so the relay has stored the reservation", the same reasoning the A-strand checkpoint already used. The relay server stores the reservation before it replies. The old post-book-swap position is still covered by `tally.check('with the strand meshed')`.
- `docs/testing.md` claim that `restore()` does not zero the frame counters: confirmed in `harness/ws-latency.ts` `restoreInstall` (it reports and resets the delay, but not the stats). The paragraph's new guidance is correct.
- Stale references: grep for `two-relay-circuit` / "TWO relays" finds only completed tickets, the garden report, and the git-ignored `packages/integration-tests/dist` build output. No live doc still calls the shape untested.
- Type safety: `expected.get(on)!` in the tally is safe because every relay passed to `reserved` comes from the tally's own list. No `any` was added.
- Tests: no test added or cut. The per-party arm is the one test for the two-relay shape, and the tally helper is exercised by all three arms. It has no branching that would justify its own test.
- Source size: the scenario file is 579 lines (`wc -l`), mostly prose header and one long linear journey. Nothing to split.

**Tripwire (already parked by the implementer, left in place):** in the per-party shape, a node that loses its own reservation re-opens a pending slot, which discovery could fill from the foreign relay. It is a `NOTE:` in the scenario header.

**Not filed:** nothing met the filing bar. No major findings.

**Validation (review):** `yarn workspace @serfab/integration-tests run typecheck` clean; `yarn lint` exit 0; `yarn workspace @serfab/integration-tests exec vitest run blind-relay-phone-to-phone-e2e` passed 3/3 (log in `tickets/.logs/feat-scenario-two-relay-circuit-review.log`, git-ignored).
