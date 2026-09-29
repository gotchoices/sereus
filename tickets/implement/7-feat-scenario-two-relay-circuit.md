description: Add a test where two people's phones each use a DIFFERENT forwarding (relay) server and still form a shared workspace and exchange data. Today every relay test puts both phones on the same relay, which is the convenient case, not the usual one.
architecture: docs/strands.md
files: packages/integration-tests/src/scenarios/blind-relay-phone-to-phone-e2e.integration.ts, packages/integration-tests/src/harness/dedicated-relay.ts, docs/testing.md, docs/strands.md, docs/architecture.md, docs/reference-app-rn.md
difficulty: medium
----

# Two phones, two different relays — a third arm of the blind-relay scenario

## Why

Both relay scenarios in the suite (`strand-circuit-same-party-e2e.integration.ts`, `blind-relay-phone-to-phone-e2e.integration.ts`) start ONE dedicated relay and point both machines at it. Two strangers who each configured (or were handed) their own relay will not share one. Then the path is asymmetric:

- A reserves on relay 1, so every address A publishes (control and strand) names relay 1.
- B reserves on relay 2, so every address B publishes names relay 2.
- B reaching A means B dialling *through relay 1*, a relay B holds no reservation on — B is only a client of its hop.
- A reaching B (for example a strand redial from the peer book) means dialling through relay 2.
- Each node holds, at the same time, a reservation on its own relay and possibly an outbound client connection to the other party's relay.

Nothing in cadre-core is known to break here. Research for this ticket found:

- The connection gater (`packages/cadre-core/src/membership-connection-gater.ts`) composes `denyDialPeer` only for the bring-up quiet period — nothing refuses dialling a relay a node does not reserve on.
- Control nodes resolve `relayAddrs` to one bare `/p2p-circuit` search listener; strand nodes run one reservation supervisor per configured relay (`relay-addrs.ts`, `relay-reservation.ts`, `strand-network-config.ts`). Neither registers anything for a relay the node was not configured with.
- One thing could plausibly change the slot count: `relay-reservation.ts`'s module doc records that libp2p writes the relay-hop protocol into the peer store when OUR OWN outbound stream negotiates it, after which libp2p's relay discovery "CAN refill a freed slot on its own". B's CONNECT through relay 1 writes that record against relay 1. The expectation is that discovery only fills a pending or freed slot and B's single control slot is already held on relay 2, so no reservation on relay 1 appears — but that is a prediction, and the per-relay counts this scenario asserts are what measures it.

So the scenario either passes as predicted (and becomes the regression gate for the ordinary case), or it finds something (see "If it does not work" below).

## Design

Parameterise the existing runner instead of copying it. The one-relay body is ~400 lines and the two shapes differ in only a handful of places; a second file would duplicate all of it.

`runBlindRelayPhoneToPhone(latency?: WsLatencyOptions)` becomes `runBlindRelayPhoneToPhone(opts: { latency?: WsLatencyOptions; relays: 'shared' | 'per-party' })`.

Inside:

- `relayA = await startDedicatedRelay()`; `relayB = opts.relays === 'per-party' ? await startDedicatedRelay() : relayA`. A's `relayAddrs` is `[relayA.dialAddr]`, B's is `[relayB.dialAddr]`. Every other difference follows from these two variables — no `if (perParty)` scattered through the body. `harness/dedicated-relay.ts` needs no change (each instance binds its own ephemeral port and key).
- The "relay speaks no strand-addr protocol" assertion runs for each distinct relay.
- **Reservation checkpoints become per-relay tallies.** Replace the four `expect(relay.reservationCount()).toBe(n)` lines with a small helper that records "one more reservation expected on relay X" and then asserts EVERY distinct relay's `reservationCount()` against its tally. The call sites stay the same four (after A's control start, after A founds the strand, after B's control start, after B's strand node reserves), each naming the relay that node reserves on. Shared arm: 1, 2, 3, 4 on the one relay (unchanged numbers). Per-party arm: relay 1 goes 1, 2 and then must STAY 2 while relay 2 goes 1, 2. Checking every relay at every checkpoint is what catches a node reserving on a relay it never configured. Suggested shape (adjust freely):

  ```ts
  function reservationTally(relays: readonly DedicatedRelay[]) {
  	const expected = new Map(relays.map((r) => [r, 0] as const)); // Map dedupes the shared arm
  	return (reservedOn: DedicatedRelay, label: string): void => {
  		expected.set(reservedOn, expected.get(reservedOn)! + 1);
  		for (const [relay, n] of expected) expect(relay.reservationCount(), `${label}: ${relay.peerId}`).toBe(n);
  	};
  }
  ```

- **Re-check the per-relay counts once more at the final sweep**, after rows have crossed both ways. A discovery-driven extra reservation (the risk above) would appear only after B's CONNECT through relay 1 has run, which is after the last existing checkpoint.
- **Prove the formation actually crossed relays.** After `formStrand`, assert every connection B's control node holds to A's control peer has a `remoteAddr` containing `/p2p/${relayA.peerId}/p2p-circuit` — B reached A through A's relay. (In the shared arm this is trivially true; in the per-party arm it is the cross-relay proof.) Assert this on B's outbound side only — the inbound side's `remoteAddr` shape is libp2p's and not what the scenario is about. Do NOT pin which relay the strand connections ride: after the peer-book swap A may dial B through relay 2 as well, and either is legitimate.
- **The final sweep takes a set of relay peer ids.** `expectOnlyRelayDirect(node, relayPeerId, label)` becomes `expectOnlyRelayDirect(node, relayPeerIds: ReadonlySet<string>, label)`: a direct connection is allowed only to a configured relay — either one in the per-party arm. B's direct connection to relay 1 (its hop client link) is expected and legitimate.
- The console log line reports the count per relay (e.g. `relay 1: 2, relay 2: 2`).
- `finally`: stop both nodes, then every distinct relay (`new Set([relayA, relayB])`), then `link?.restore()` — same ordering as today.

Registration: the two existing `it`s pass `relays: 'shared'`; add a third, loopback only:

```ts
it('forms the strand when each stranger reserves on a DIFFERENT relay, and replicates both ways', async () => {
	await runBlindRelayPhoneToPhone({ relays: 'per-party' });
}, 300_000);
```

Rename the `describe` from "one dedicated relay" to something that covers both shapes. No latency × two-relay arm: the latency arm tests link sensitivity, which is orthogonal to which relay each party uses, and a fourth full run costs another ~10 s for no new question. Note in the file header that `WS_SEND_DELAY_MS` (docs/testing.md line ~53) now pins all three tests in the file.

The file header's "Out of scope, deliberately" paragraph loses its TWO-relay sentence; the header's topology/flow description gains one paragraph on the per-party arm: what differs, the per-relay slot numbers measured, and that no node reserved on a relay it did not configure (or what was measured instead).

## If it does not work

The ticket is not allowed to land as a silent skip. If the per-party arm fails for a reason in cadre-core (not a scenario bug):

- Keep the arm, rewritten to pin today's behaviour: assert the observed failure explicitly (e.g. `formStrand` rejects with the observed error, or the mesh gate times out and the per-relay counts are X/Y), with a comment naming the bug ticket. Do not `it.skip`.
- File a bug ticket in `tickets/fix/` with `repro: verified`, naming the code site that refuses the cross-relay path and the scenario arm as the reproduction.
- Docs record the shape as "known broken, ticket <slug>" rather than "covered".

If it WORKS but the per-relay counts differ from 2/2 (e.g. B also reserves on relay 1): pin the measured counts, and file a backlog `bug-` ticket (a node taking a slot on a third party's relay it never configured costs that relay's capacity and is not requested behaviour) with `severity`, `likelihood`, `tradeoffs`, and the libp2p mechanism if found (`@libp2p/circuit-relay-v2`'s reservation store / relay discovery — read in `node_modules`, never build the sibling repos).

## Edge cases & interactions

- **Shared arm unchanged.** The two existing tests must assert the same numbers as today (1→2→3→4 on one relay; sweep allows only that relay). Verified by running them — they are the regression guard for the refactor.
- **Reservation on a relay a node never configured** (discovery refill after the CONNECT through the foreign relay). Verified by the every-relay-every-checkpoint tally plus the final-sweep re-check.
- **Formation dial through a relay the dialer does not reserve on.** Verified by the `formStrand` success plus the `/p2p/${relayA.peerId}/p2p-circuit` remote-address assertion on B's control connection.
- **Seeded strand mesh across relays, both directions, no hand-dial.** Verified by the existing mesh gates (B→A and A-accepts) running unchanged in the per-party arm.
- **Peer-book entries** — each side's signed entry for the other must hold only circuit addrs ending in the other peer's id. In the per-party arm A's entry for B names relay 2 and B's for A names relay 1; the existing assertion covers this without change (do not add relay-specific assertions to it).
- **Unlimited relayed connections on both relays.** Both fixtures ship `applyDefaultLimit: false`; `expectAllPathsRelayed`'s `conn.limits` check covers connections via either relay, unchanged.
- **Direct-connection sweep with two relays.** Verified by the set-based `expectOnlyRelayDirect`; make sure the per-party arm passes both relay ids to every node's sweep (A's control and strand nodes may legitimately hold a direct connection to relay 2 after dialling B through it).
- **Teardown with a shared object.** In the shared arm `relayA === relayB`; stopping the same relay twice must not happen — dedupe via a `Set`.
- **Latency shim** is process-wide and installed before any node. The per-party arm passes no `latency`, so `link` is `undefined` and the unchanged `link?.restore()` is a no-op; by inspection.
- **Delegate admission** stays a non-participant: neither dedicated relay speaks `/sereus/strand-addr/1.0.0`; asserted per distinct relay.

## Tests

No new test file and no unit tests. The new arm IS the test; the per-relay tally is the only new assertion logic and it runs in all three arms. Don't add a test for the tally helper.

## Docs (all four places that say "untested", plus the RN doc)

- `docs/testing.md` — the cross-party relayed line (~line 603–617): replace "One SHARED relay only; the two-relay shape … is not covered" with the per-party arm's coverage and measured per-relay counts; delete the "**Uncovered**: the two-relay circuit shape" bullet (~line 680).
- `docs/strands.md` (~line 67–94) — the "proven end to end (one shared relay)" paragraph gains the two-relay result and per-relay slot cost; remove TWO relays from "Still open" (roaming stays open).
- `docs/architecture.md` Relay Integration (~line 982) — replace "Untested: the two-relay shape…" with the result.
- `docs/reference-app-rn.md` line ~178 — "One relay per phone, and both ends are assumed to share it … untested" becomes: each phone's own relay is supported and tested (keep the always-on-node sentence).

If the arm pins a failure instead, each of these says "known broken" with the bug ticket slug.

## Running

```
yarn workspace @serfab/integration-tests exec vitest run blind-relay-phone-to-phone-e2e
```

Foreground, no redirection (or `| tee tickets/.logs/feat-scenario-two-relay-circuit.test.log`). Run it at least 3 times to see the per-party arm is stable, and record its wall-clock in the handoff. Also `yarn workspace @serfab/integration-tests typecheck` and `yarn lint`. If the stale-build guard reports a sibling (`../optimystic`, `../quereus`) `dist` is stale, stop and record the block — never build a sibling.

## Related open tickets touching this file (do not absorb)

`debt-relay-scenarios-never-see-link-latency`, `debt-hoist-strand-read-helpers-integration`, `debt-strand-relay-redrive-on-party-run-relay-unscenarioed`, `feat-phone-relays-through-its-own-always-on-node` — all in backlog, none conflicts with this change.

## TODO

- Refactor `runBlindRelayPhoneToPhone` to take `{ latency?, relays: 'shared' | 'per-party' }`, deriving `relayA` / `relayB`; point B at `relayB`.
- Replace the four reservation-count assertions with the per-relay tally helper; add the final-sweep re-check.
- Add the formation cross-relay remote-address assertion on B's control connection.
- Change `expectOnlyRelayDirect` to take a set of relay peer ids; update all four sweep calls.
- Per-relay log line; dedupe relay teardown.
- Register the third `it` (per-party, loopback); update the `describe` name.
- Update the file header (flow description, per-party measurement, remove the out-of-scope sentence, `WS_SEND_DELAY_MS` note).
- Run the scenario 3× (all arms green, shared-arm numbers unchanged), typecheck, lint.
- If the per-party arm fails or the counts differ from 2/2: pin measured behaviour and file the bug ticket as described above.
- Update `docs/testing.md`, `docs/strands.md`, `docs/architecture.md`, `docs/reference-app-rn.md` with the measured result.
