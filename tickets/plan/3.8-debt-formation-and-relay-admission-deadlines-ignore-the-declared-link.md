description: When two parties set up a shared workspace, the first step gives up connecting to the other machine after 5 seconds, which is too short when they reach each other only through a relay over a slow connection. A deployment that states it is on such a connection still gets a setup that can never finish. A relay-side limit on how quickly a newly connected machine must ask for relay service is also a fixed number that was never checked against a slow link.
architecture: docs/architecture.md#relay-integration
files:
  - packages/cadre-core/src/strand-formation-protocol.ts (DEFAULT_STEP_TIMEOUT_MS 5 000 bounds the formation dial at ~830; DEFAULT_SESSION_TIMEOUT_MS 30 000; resolveProvisionTimeoutMs ordering)
  - packages/cadre-core/src/strand-formation-manager.ts (sessionTimeoutMs / stepTimeoutMs config, ~113, ~235, ~299)
  - packages/cadre-core/src/membership-connection-gater.ts (RELAY_ADMISSION_RESERVE_DEADLINE_MS 5 000 ~212)
  - packages/cadre-core/src/link-budget.ts (where the counts and the derivation belong)
repro: static
severity: edge-case
likelihood: unusual
tradeoffs: Formation over a relay also depends on the relay allowing unrestricted relayed connections (the formation stream does not accept limited ones), so the case that fails may be narrower than the arithmetic suggests. Converting the formation deadlines is a per-step judgement across a three-layer deadline ordering (step, provision, session) that a maintainer may reasonably want a slow-link measurement for first.

# Formation and relay-admission deadlines are still fixed milliseconds

Found while planning `debt-three-more-dial-deadlines-ignore-the-declared-link` (now `wake-addr-seed-deadlines-count-round-trips`). This is the same kind of problem: a deadline over exchanges on the machine-to-machine link, written as a fixed number rather than derived from `NetworkConfig.linkRoundTripMs` (default 3500 ms; sereus supports relayed links up to a 3-second round trip) through `packages/cadre-core/src/link-budget.ts`. It is filed separately because each site needs its own count and they are in two unrelated subsystems.

## Strand formation: the dial is cut off at 5 s

`dialFormation` (`strand-formation-protocol.ts` ~830) opens the connection to the other party's machine under `withTimeout(stepTimeoutMs, 'Formation dial-connect', …)`, and `stepTimeoutMs` defaults to `DEFAULT_STEP_TIMEOUT_MS` = 5 000 ms. The name describes a single frame read or write, but the timeout also covers the dial. A relayed dial costs 4 link round trips (`RELAYED_DIAL_ROUND_TRIPS`, measured by `packages/integration-tests/src/scenarios/relayed-dial-cost-by-latency.integration.ts`). So 5 000 ms cannot open a relayed connection above a 1.25-second round trip, well below the 3-second link sereus supports. `StrandFormationManager` passes `config.stepTimeoutMs`, which is unset in production, so the default applies.

Two details matter for the fix:

- `withTimeout` does not pass an abort signal into `dialProtocol`, so an expired dial keeps running in the background and its result is discarded. `withDeadline` in `control-stream.ts` passes the signal, as the wake, strand-address and seed senders do.
- `DEFAULT_SESSION_TIMEOUT_MS` (30 000) must contain the dial, the contact exchange and the provisioning wait. `resolveProvisionTimeoutMs` enforces an ordering between the three layers, so deriving the dial part means re-checking that the session layer still contains the rest. `DEFAULT_PROVISION_TIMEOUT_MS` is owned here whole, including its relation to Optimystic's read and commit bounds. See "Added section: provisioning holds Optimystic reads and a commit" below.

`repro: static`: arithmetic from the measured count, not observed. To confirm, run formation between two nodes that reach each other only through a party-run relay (unlimited relayed connections: the formation stream does not set `runOnLimitedConnection`) with the relayed-dial-cost scenario's frame delay at 1 500 ms one-way, and look for `Formation dial-connect` timing out.

## Relay admission: 5 s to ask for a reservation

`RELAY_ADMISSION_RESERVE_DEADLINE_MS` (5 000 ms, `membership-connection-gater.ts` ~212) is how long a party-run relay keeps a connection it admitted only so that the peer could reserve relay service, before closing it as not reserving. The client's reservation request reaches the relay about one link round trip after the relay finishes the connection upgrade: identify, then protocol negotiation, then the request. `link-budget.ts` measures "request a reservation on an open relay connection" at 1 link round trip. That is 3.5 s at the default declaration, and more when all of the link's delay is on the client's own hop, as for a phone on a congested mobile link. So 5 000 ms probably fits at the supported link, but the margin was never counted. The failure mode would be quiet: the relay drops the connection and the client's reservation drive retries on its own backoff.

The relay's own declaration is the right input here, since the relay decides. The relay container (`ops/docker/libp2p-infra/src/main.ts`) sets libp2p's connection limits by hand rather than through cadre-core, so whatever derivation is chosen has to reach that path as well.

## What done looks like

Each deadline is either derived from a round-trip count in `link-budget.ts` or carries a stated reason why it does not scale with the link. For formation, that means one count for the dial (4) and the frame steps under `withDeadline`. If `link-deadline-literal-lint-gate` has landed, these sites carry `link-bound, not yet derived: debt-formation-and-relay-admission-deadlines-ignore-the-declared-link` disable comments, which the conversion deletes.

## Added section (2026-09-29, from the audit of cadre deadlines against Optimystic's bounds): provisioning holds Optimystic reads and a commit

`files:` add `packages/cadre-core/src/strand-formation-manager.ts` (`provisionUnbound` ~607, `resolveInviteSAppId`) and `PROVISION_SETTLE_GRACE_MS` in `strand-formation-protocol.ts` (~87).

The responder's provisioning budget (`DEFAULT_PROVISION_TIMEOUT_MS`, 12 000 ms, of which the last 2 000 ms is the settle grace) wraps control-database work, not just the approval hook. The provisioning hook reads the invitation (`isTokenValid`, and `resolveInviteSAppId` on the fallback path), then commits the `FormationUsage` row. Each read can consult the cohort about a block it does not hold, and on a consult one silent peer costs one per-peer cohort read deadline: 7 000 ms (`cohortReadDeadlineMs`, two link round trips at the default declared link; 5 000 ms before it was derived), against 1 000 ms when this budget was sized. A commit costs several link round trips, about 6 s or more at the supported 3 s round trip.

The protocol already documents one open window (`settleWithinGrace`'s NOTE): the work budget expires after the `FormationUsage` insert was issued, and the commit outlasts the grace. The joiner is then told "timed out" while its one-time invite is spent, and no retry can recover it. A 2 000 ms grace is shorter than one commit at the supported link, so on a slow link that window is the likely outcome whenever the reads eat most of the work budget, not an unlucky edge. `repro: static`: reasoning from the deadlines above, not observed.

What done looks like, for this part: the provisioning budget, or at least its grace, is sized to contain one control commit at the declared link, with any reads before it counted, or the insert is made the first thing the hook does so a late expiry aborts before it. Either way, keep the step < provision < initiator < session ordering intact. The directive on `DEFAULT_PROVISION_TIMEOUT_MS` names this ticket's slug (`cadre-deadline-ladder-recorded` retargets it).
