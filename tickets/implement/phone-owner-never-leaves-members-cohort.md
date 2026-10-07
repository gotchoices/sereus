description: Once the peer-discovery library can give up on a phone that went offline, switch the any-member invitation scenario to a phone-shaped owner, the household shape the feature is for, and state the eviction timing in the architecture doc.
prereq: fret-evicts-an-address-less-peer-that-disconnects
architecture: docs/architecture.md#enrollment-flow-invitation-redeemed-at-any-member
files: packages/integration-tests/src/scenarios/cadre-invite-any-member.integration.ts, docs/architecture.md (Enrollment Flow: Invitation Redeemed at Any Member), packages/integration-tests/src/harness/control-cohort.ts (`readCohort`), packages/cadre-core/src/cadre-node.ts (`createCadreInvitation`, the `members` list), ../optimystic/packages/db-p2p/package.json (`p2p-fret` version)
difficulty: easy
----

# Scenario and doc follow-up once FRET evicts an address-less peer

## Context

Ticket `fret-evicts-an-address-less-peer-that-disconnects` (in `blocked/`) carries the measurements and the proposed rule: a member's FRET table marks a stopped peer `dead` after three failed contacts, a peer with no address is never contacted, and the departing peer's own leave notice is sent after libp2p has already closed its connections. Until FRET ships both arms, a phone-shaped owner stays in its members' control cohorts indefinitely and every member write waits on it. The committed scenario gives owner A a loopback WebSocket port for that reason and says so in its header.

This ticket is the sereus side after the FRET change lands and links into this workspace. Nothing in cadre-core changes.

## What to do

**Scenario.** Make A phone-shaped (`listenAddrs: []` in `buildA`), keeping its control storage and bootstrap peer store so the restart still reconnects to the members by dialing them. Expect the cohort eviction wait to resolve in the same few seconds for a phone-shaped owner as for an addressed one (measured 5.05 s for the addressed shape), and tighten the `COHORT_EVICTION_MS` comment to say so. The invitation's `members` list puts the issuer's own address first; with no listen address, confirm what `createCadreInvitation` emits and adjust the `members[0]` expectation (the members' addresses should still be named). Rewrite the header's "Why this shape" paragraph: the phone-plus-members shape is now the one under test, and the eviction rule lives in the FRET ticket. The scenario already runs with the single member M: `redemption-write-tears-on-a-member-whose-cohort-just-shrank` landed (the member pushes its control store to the device before writing the admission) and removed N.

**Architecture doc.** In the "Enrollment Flow: Invitation Redeemed at Any Member" section, state the constraint the design rests on, as a fact and not a history: a member offers its control writes to the peers its ring still believes alive; a stopped owner leaves that set within about three probe ticks (about 5 s) whether or not it had a listen address; a member write made inside that window waits on the absent owner for the commit budget and fails retryably. Name the FRET ticket slug as the reason this is true for an address-less owner and stop there.

## Out of scope

Whether a member's reads and writes should degrade sooner than the commit budget while a just-departed peer is still in the cohort. After the FRET change that window is about 5 s; `redemption-write-tears-on-a-member-whose-cohort-just-shrank` did not take up its `busy` proposal (its tear came from the device joining the cohort holding no blocks, not from the cohort shrinking), so the question has no owner yet; it stays out of scope here.

## Tests

No new unit test: the integration scenario is the reproduction at the lowest layer with a real network, and the FRET rule is pinned in FRET's own suite.

## TODO

- Confirm the linked `p2p-fret` build carries both arms (a stopped address-less peer reaches `dead` within about 5 s; a leave notice is received by the member), by running the scenario once with `DEBUG='optimystic:fret*,sereus:integration:cohort'`.
- Switch `buildA` to `listenAddrs: []`; fix the `members[0]` expectation; tighten the `COHORT_EVICTION_MS` comment; rewrite the header paragraph.
- Run `cadre-invite-any-member` three times and record the eviction time the scenario prints.
- Update the architecture section as described; run `yarn lint` and the integration-tests typecheck.
