---
description: A phone or laptop that cannot accept incoming connections stays reachable by asking one of the party's always-on machines to forward traffic for it. That always-on machine used to refuse the request whenever it had not yet heard the asker is a member, leaving the asker permanently addressless. Implemented: the forwarding request is now let through, and who gets forwarded is decided at the forwarding step — members and announced delegates freely, unknown peers on a small bounded budget, with unknown peers that never ask for forwarding dropped after a few seconds.
files: packages/cadre-core/src/membership-connection-gater.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/delegate-admission.ts, packages/cadre-core/src/types.ts, packages/cadre-core/src/index.ts, packages/cadre-core/test/membership-connection-gater.spec.ts, packages/cadre-core/test/membership-gate-helpers.ts, packages/cadre-core/test/control-stream-authorization.spec.ts, packages/integration-tests/src/scenarios/relay-only-control-addr.integration.ts, packages/integration-tests/src/scenarios/control-stream-authz.integration.ts, packages/integration-tests/src/harness/node-fixtures.ts, docs/architecture.md, docs/strands.md, tickets/backlog/bug-fail-fast-relay-boot-blocked-by-stream-gate.md
---

# Review: a control node's membership gate no longer denies a sibling's circuit-relay reservation

## What was built (the RECOMMENDED design from the implement ticket — not the fallback)

The relay was answering a relay question ("may this peer use my forwarding capacity?")
with a membership answer, at the encrypted-connection checkpoint where a wrong answer is
unrecoverable — a reservation is established by the reserving peer dialing the relay, so
killing the connection kills the reservation, and no outbound re-dial can ever restore it
(the reservation IS the peer's address). The two questions are now separated
(`membership-connection-gater.ts` → module doc, section "The relay-reservation seam"):

- **Verdict, not boolean.** `CadreNode.admitInboundControlConnection` now returns
  `'admit' | 'deny' | 'admit-for-relay'`. All previous admit branches are unchanged; the
  final deny branch returns `'admit-for-relay'` instead of `'deny'` when this node runs
  the circuit-relay server (`CadreNode.relayServerEnabled`, the same
  `network.enableRelay ?? profile === 'storage'` formula `buildControlNodeOptions` uses —
  now factored so the two cannot drift).
- **Reservation seam.** `createMembershipConnectionGater` composes a
  `denyInboundRelayReservation` hook (verified consulted per RESERVE by
  `@libp2p/circuit-relay-v2`'s server) alongside the existing inbound-encrypted hook.
  Base-gater hook preserved, deny-from-either-wins, same fail-open-on-error/timeout
  contract as the connection hook. Policy: `CadreNode.admitControlRelayReservation` —
  baseline admits, delegate grants, and authorized members (or the cold-start empty set)
  admit outright and uncounted; anyone else draws on the budget.
- **Bounded unauthorized budget.** `UnauthorizedReservationBudget` (same module): cap
  default `MAX_UNAUTHORIZED_RELAY_RESERVATIONS` = 8, per-node override
  `network.unauthorizedRelayReservationCap` (0 restores the strict pre-fix posture).
  Entries expire after 2 h, mirroring the relay server's own default reservation TTL, and
  a refresh never double-counts.
- **Not-reserving deadline.** An `'admit-for-relay'` connection is aborted
  (`maConn.abort`) unless a reservation for that peer is ADMITTED at the hook within
  `RELAY_ADMISSION_RESERVE_DEADLINE_MS` = 5 s. Timers are unref'd; abort on an
  already-closed connection is swallowed.

Delegate grants (`delegate-admission.ts`) now count at BOTH seams — an announced strand
delegate is admitted outright and never spends the budget nor races the deadline.

## How to validate

```
yarn workspace @serfab/cadre-core build && yarn workspace @serfab/cadre-core test   # 103 files, 1620 pass
yarn workspace @serfab/integration-tests build
cd packages/integration-tests && yarn vitest run \
  src/scenarios/relay-only-control-addr.integration.ts \      # 5 cases, all green, ~40 s
  src/scenarios/control-stream-authz.integration.ts \
  src/scenarios/membership-connection-gater.integration.ts
yarn lint    # clean
```

Key scenarios (`relay-only-control-addr.integration.ts`, was 3 cases, now 5):

- Case 1 (unchanged, green): authorized relay-only member — full 4-link address chain to a
  third party.
- Case 2 (FLIPPED): unplaced reserver on the fail-fast `relayAddrs` route boots and holds
  a `/p2p-circuit` address. ⚠️ Uses a DIFFERENT-party reserver — see "gaps" below.
- Case 3 (FLIPPED): the reported shape — unauthorized same-party member on the fail-soft
  `reserveRelays` route gets `status: 'reserved'` + circuit addr; authorizing it after
  costs nothing.
- Case 4 (new): admitted-for-relay stranger's raw control-DB `pend` is refused AND its
  never-reserving connection is dropped at the deadline, both sides.
- Case 5 (new): cap forced to 1 via the config knob — first unplaced reserver reserved,
  second refused (`PERMISSION_DENIED`), authorized member still reserves past the spent
  cap.

Unit (`membership-connection-gater.spec.ts`): both hooks' composition + fail-open, the
deadline arm/disarm/refused paths, the budget class (cap/refresh/expiry), the
relay-enabled verdict matrix, and the `admitControlRelayReservation` matrix (member and
delegate uncounted, cap, cap 0, cold start, baseline).

## Known gaps and judgment calls — the review's starting points

- **Deadline clears on reservation ADMISSION, not success.** The gate cannot observe the
  server-side `reserve()` outcome, so a peer whose admitted reservation is then refused
  for server capacity keeps a mute connection until either side closes it. Documented in
  the module doc; judged harmless (bounded, speaks nothing).
- **Budget occupancy is a mirror, not a measurement.** 2 h TTL mirrors the server's
  default reservation TTL; a disconnecting reserver holds its slot until expiry, exactly
  as it holds the server's reservation slot. Greppable `NOTE:` at
  `UNAUTHORIZED_RESERVATION_TTL_MS` covers the drift-if-reconfigured tripwire. Long-run
  TTL behavior is unit-tested with injectable `now` only — no hours-long integration.
- **Case 2 could not be flipped with a same-party reserver.** The reservation fix works
  there too, but a same-party unauthorized node's `start()` then fails DOWNSTREAM: on the
  fail-fast route its connection to the relay exists before its control DB initializes,
  the schema hydration enlists the relay, and the relay's (correct, fail-closed)
  per-stream gate refuses it → `BlockUnavailableError`, start rejects. Filed as
  `tickets/backlog/bug-fail-fast-relay-boot-blocked-by-stream-gate` (repro: verified;
  full chain in the ticket). Case 2 uses a different-party reserver — identical admission
  decision at the relay — and says so in comments; flip it back when that ticket lands.
- **Semantic shift in `control-stream-authz.integration.ts` case (a).** An un-announced
  stranger dialing a relay-enabled node is now admitted-for-relay and dropped by the 5 s
  deadline rather than denied at the upgrade. The test's observable (no surviving
  connection) is unchanged and green; its comment was rewritten. A relay-DISABLED node
  still denies at the upgrade (covered by `membership-connection-gater.integration.ts`,
  untouched and green).
- **Fail-open on the reservation hook admits WITHOUT counting.** A policy error/timeout
  during `admitRelayReservation` admits the reservation and spends no budget slot —
  consistent with the layer's fail-open contract (a DB hiccup must not partition a
  cadre), but it means the cap is best-effort under fault injection.
- **Same-party stranger nodes destabilize a relay's control cohort in tests.** Observed
  while stabilizing case 5: same-party unauthorized CadreNodes join the relay's control
  cohort (they serve the party's protocols) and a deadline-dropped one mid-write made the
  relay's own `authorizePeer` fail on a peers-unreachable `Revocation` query. Test design
  now avoids it (different-party reservers); not filed as a ticket — it is the same
  boot-ordering window the backlog ticket above owns, observed from the relay's side.
- **`security-review` not run**; the threat surface changed deliberately (strangers now
  hold brief, mute, or budget-bounded reserving connections on relay-enabled nodes) — a
  reviewer should weigh the cap default (8) and deadline (5 s) explicitly.

## Upstream hand-back (a HUMAN posts this — do not post from an agent run)

For [gotchoices/Optimystic#12](https://github.com/gotchoices/Optimystic/issues/12), which
is weighing a feature premised on our earlier (wrong) diagnosis:

> Correction to our earlier analysis on this issue. We reproduced the reported topology
> end to end (relay-providing control node, relay-only control node, and an unrelated third
> member) and the address-seeding chain is intact: the relay-only peer obtains its
> `/p2p-circuit` address, `identifyPush` carries it into the relay's peer store, and a
> third member that never connected to it directly learns the address from the cluster
> records it coordinates. No db-p2p change is needed for that.
>
> The failure is on our side: our control node composes a membership connection gater that
> refuses an inbound encrypted connection from a peer whose membership record it has not
> yet replicated. A circuit-relay reservation *is* such an inbound connection, so the
> reservation stream dies mid-handshake (`UnexpectedEOFError` inside
> `ReservationStore.#createReservation`) and the peer never obtains an address to seed. Our
> strand-layer peers were unaffected because they hold an explicit admission grant that
> control peers had no equivalent of. Tracked and fixed in Sereus: the relay now decides
> relay admission at the circuit-relay reservation hook (members and announced delegates
> outright, unknown peers on a small bounded budget) instead of slamming the connection.
