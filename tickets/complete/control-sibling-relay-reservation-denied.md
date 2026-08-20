---
description: A phone or laptop that cannot accept incoming connections stays reachable by asking one of the party's always-on machines to forward traffic for it. That always-on machine used to refuse the request whenever it had not yet heard the asker is a member, leaving the asker permanently addressless. The forwarding request is now let through, and who gets forwarded is decided at the forwarding step — members and announced delegates freely, unknown peers on a small bounded budget, with unknown peers that never ask for forwarding dropped after a few seconds.
files: packages/cadre-core/src/membership-connection-gater.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/delegate-admission.ts, packages/cadre-core/src/types.ts, packages/cadre-core/src/index.ts, packages/cadre-cli/src/config/types.ts, packages/cadre-core/test/membership-connection-gater.spec.ts, packages/cadre-core/test/membership-gate-helpers.ts, packages/cadre-core/test/control-stream-authorization.spec.ts, packages/integration-tests/src/scenarios/relay-only-control-addr.integration.ts, packages/integration-tests/src/scenarios/control-stream-authz.integration.ts, packages/integration-tests/src/scenarios/membership-connection-gater.integration.ts, packages/integration-tests/src/harness/node-fixtures.ts, docs/architecture.md, docs/strands.md
---

# Complete: a control node's membership gate no longer denies a sibling's circuit-relay reservation

## What shipped

The relay was answering a relay question ("may this peer use my forwarding capacity?")
with a membership answer, at the encrypted-connection checkpoint where a wrong answer is
unrecoverable — a reservation is established by the reserving peer dialing the relay, so
killing the connection kills the reservation, and no outbound re-dial can restore it (the
reservation IS the peer's address). The two questions are now separated
(`membership-connection-gater.ts` → module doc, section "The relay-reservation seam"):

- **Verdict, not boolean.** `CadreNode.admitInboundControlConnection` returns
  `'admit' | 'deny' | 'admit-for-relay'`. Every previous admit branch is unchanged; the
  final deny branch returns `'admit-for-relay'` when this node runs the circuit-relay
  server (`CadreNode.relayServerEnabled` — the `network.enableRelay ?? profile ===
  'storage'` formula, factored so the gate and `buildControlNodeOptions` cannot drift).
- **Reservation seam.** `createMembershipConnectionGater` composes a
  `denyInboundRelayReservation` hook alongside the existing inbound-encrypted hook. Base
  gater preserved, deny-from-either-wins, same fail-open-on-error/timeout contract.
  Policy: `CadreNode.admitControlRelayReservation` — baseline admits, delegate grants and
  authorized members (or the cold-start empty set) admit outright and uncounted; anyone
  else draws on a bounded budget.
- **Bounded unauthorized budget.** `UnauthorizedReservationBudget`: cap default
  `MAX_UNAUTHORIZED_RELAY_RESERVATIONS` = 8, per-node override
  `network.unauthorizedRelayReservationCap` (0 restores the strict pre-fix posture).
  Entries expire after 2 h, mirroring the relay server's own default reservation TTL; a
  refresh never double-counts, and an uncounted admission releases any slot the peer still
  held (added in review — see findings).
- **Not-reserving deadline.** An `'admit-for-relay'` connection is aborted unless a
  reservation for that peer is ADMITTED at the hook within
  `RELAY_ADMISSION_RESERVE_DEADLINE_MS` = 5 s. Timers unref'd; abort on an already-closed
  connection swallowed.

Delegate grants (`delegate-admission.ts`) count at BOTH seams — an announced strand
delegate is admitted outright, never spends the budget, never races the deadline.

## Validation (re-run in review, all green)

```
yarn lint                                                          # clean (exit 0)
yarn workspace @serfab/cadre-core build                            # clean
yarn workspace @serfab/cadre-cli build                             # clean
yarn workspace @serfab/integration-tests build                     # clean
cd packages/cadre-core && yarn vitest run \
  test/membership-connection-gater.spec.ts \
  test/control-stream-authorization.spec.ts                        # 74 pass
cd packages/integration-tests && yarn vitest run \
  src/scenarios/relay-only-control-addr.integration.ts \
  src/scenarios/control-stream-authz.integration.ts \
  src/scenarios/membership-connection-gater.integration.ts         # 10 pass, 67s
yarn workspace @serfab/cadre-core test    # 103 files, 1623 pass, 1 skipped (win32 file-mode), 110s
```

## Review findings

Read the implement diff (`6c87c5b`) before the handoff summary, then verified the
load-bearing external claims against the installed `@libp2p/circuit-relay-v2` source
rather than taking them on trust:

- `denyInboundRelayReservation` **is** consulted per RESERVE request
  (`server/index.js:123`, inside `handleReserve`, before `reservationStore.reserve`), and a
  deny returns `PERMISSION_DENIED` — the hook the design rests on behaves as claimed.
- `DEFAULT_MAX_RESERVATION_TTL` **is** 2 h, and sereus passes no `relayServerInit`, so the
  budget's TTL mirror is against the real value.
- Reservations in the server's store are keyed by peer and expire by TTL — they are **not**
  torn down when the reserver's connection closes. That is what makes "budget occupancy
  mirrors server occupancy" correct rather than merely convenient, and it is worth knowing:
  the implement handoff called the disconnect case a gap, but the server holds its own slot
  for exactly as long.

### Fixed in this pass (minor)

- **Budget slot was never given back once the peer became placeable.** A member that
  reserved during the boot-ordering window kept its slot spent for the remaining 2 h even
  after its `CadrePeer` row replicated in, so a party that restarts nodes could silt the
  budget up with peers that no longer needed it and then refuse a genuinely unplaced
  member. `UnauthorizedReservationBudget.release` added; every uncounted admission path in
  `admitControlRelayReservation` now releases first (via `admitReservationUncounted`).
  Covered by three new tests: the budget-level `release`, the row-lands case, and the
  delegate-grant-lands case.
- **New config knob was undeclared outside `cadre-core`.**
  `network.unauthorizedRelayReservationCap` was missing from the `NetworkConfig` listing in
  `docs/architecture.md` and from `cadre-cli`'s mirrored `CadreConfig`/`ResolvedConfig`
  network types — it reached a CLI-run node only as an untyped passthrough. Declared in
  both. No env var added: the loader coerces per-variable and this is an advanced knob, so
  YAML-only is the honest surface.
- **`membership-connection-gater.integration.ts` asserted a premise it never stated.** Its
  case 1 expects an outright connection deny, which is now only right because every node in
  that file takes the fixture's default `transaction` profile (relay off). Module doc now
  says so and points at the relay-enabled observable, so nobody flips a node to `storage`
  there and gets a confusing failure.

### Recorded as tripwires (conditional — not tickets)

- **The cap shares the relay server's own 15-slot reservation store.**
  `DEFAULT_MAX_RESERVATION_STORE_SIZE` is 15, so unplaced peers may occupy up to 8 of the
  slots members and delegates also compete for. Fine at the current numbers; only bites if
  either number is raised. `NOTE:` at `MAX_UNAUTHORIZED_RELAY_RESERVATIONS` alongside the
  existing TTL-drift note, since this module cannot read the server's size.
- **Disarming the not-reserving deadline is final for the connections it cancelled.** A
  peer that reserves once and lets the reservation lapse keeps a mute connection until
  either side closes it. Bounded — only a peer the reservation policy already admitted can
  reach that state — so it is a fact to know, not work to do. Recorded in the
  `PendingReserveDeadlines` class doc.

### Filed as a new ticket (major)

- `tickets/backlog/debt-relay-reservation-decision-repeatable-cost` — the reservation hook
  runs the full membership determination (two control-DB queries plus one Ed25519 verify
  per member row) on **every** RESERVE request, and nothing rate-limits how often an
  admitted-for-relay peer may send one. The accepted-tradeoff note at the connection gate
  ("connections are rare") justified the live read when it only ran per inbound connection;
  that premise does not carry to a checkpoint the requester can re-trigger for free, which
  is why this is filed rather than left to the existing note. Filed as `debt-` with the
  obvious cheap fix explicitly ruled out in the ticket: switching to the bounded-stale
  `authorizedControlPeers` snapshot would let a full budget refuse a real member its
  reservation — the exact failure this ticket existed to remove. Magnitude is stated as
  structural, not measured; no benchmark was run.

### Weighed and deliberately NOT filed

- **The threat-surface change the handoff asked a reviewer to weigh explicitly.** Strangers
  now hold brief (≤5 s), mute connections on relay-enabled nodes, or budget-bounded
  reserving ones. The per-stream gates are untouched and still fail closed on every
  members-only protocol — proven end to end by case 4 of
  `relay-only-control-addr.integration.ts`. The deadline (5 s) is generous against the
  observed reserve latency (both routes reserve in well under a second in the scenarios),
  and the cap (8) is defensible against the server's own 15. Judgment: the defaults stand;
  the one durable consequence worth writing down is the store-size coupling, recorded as a
  tripwire above. `security-review` was not run as a separate pass — the surface change is
  small, deliberate, and now has its own end-to-end coverage.
- **Fail-open on the reservation hook admits without counting.** A policy error or timeout
  admits and spends no slot, so the cap is best-effort under fault injection. Consistent
  with the layer's stated fail-open contract (a DB hiccup must not partition a cadre) and
  already documented; re-litigating it would be re-deciding the layer, not fixing a defect.
- **A second, non-reserving connection from a peer that already holds a reservation gets
  armed and dropped at 5 s.** Correct-by-default (the peer's reservation lives in the
  server's store, which survives that connection closing) and rare; suppressing it would
  need a per-peer "is reserving" set with its own lifetime problem. Left alone.
- **`cadre-node.ts` is 5291 lines.** Already owned by
  `tickets/backlog/debt-cadre-node-single-file-size`; this diff adds ~110 lines to it,
  which is evidence for that ticket, not a new one.

### Empty categories

- **No correctness defect was found in the shipped logic.** Both composed hooks, the
  verdict matrix, the budget, and the deadline behave as documented under unit and
  end-to-end exercise; the one real bug found (the un-released slot) was in what the
  policy *omitted*, not in what it did.
- **No test was found asserting the wrong thing.** The semantic shift the handoff flagged
  in `control-stream-authz.integration.ts` case (a) is legitimate: the observable (no
  surviving connection) is unchanged, only the mechanism moved, and the rewritten comment
  says which mechanism now produces it.
- **No stale documentation was found beyond the two gaps fixed above.** `docs/strands.md`,
  `delegate-admission.ts`, the `architecture.md` gate bullet, and both integration harness
  files were read against the new behavior and match it. `docs/testing.md`,
  `docs/cadre-host.md` and the package READMEs were checked and touch none of the changed
  behavior; there is no scenario index to keep in step.

## Known limits, unchanged from the handoff

- **The deadline clears on reservation ADMISSION, not success.** The gate cannot observe
  the server-side `reserve()` outcome, so a peer whose admitted reservation is then refused
  for server capacity keeps a mute connection until either side closes it. Documented in
  the module doc; bounded and speaks nothing.
- **Long-run TTL behavior is unit-tested with an injectable `now` only** — there is no
  hours-long integration test, by design.
- **Case 2 of `relay-only-control-addr.integration.ts` uses a different-party reserver.**
  The reservation fix works for a same-party one too, but its `start()` then fails
  downstream on the relay's (correct, fail-closed) per-stream gate. Tracked as
  `tickets/backlog/bug-fail-fast-relay-boot-blocked-by-stream-gate`; flip case 2 back to a
  same-party member when that lands. The same window, seen from the relay's side, is what
  makes same-party stranger nodes destabilize a relay's control cohort in tests — the
  scenarios avoid it by construction and say so in comments.

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
