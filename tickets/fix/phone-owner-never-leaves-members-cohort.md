description: When a phone that owns a cadre goes offline, the always-on members keep treating it as present for at least five minutes, so every change they try to save, including admitting a new device by invitation, waits on the absent phone and fails. A machine with a dialable address is forgotten within seconds; a phone has no address to fail against.
architecture: docs/architecture.md#enrollment-flow-invitation-redeemed-at-any-member
files: packages/integration-tests/src/scenarios/cadre-invite-any-member.integration.ts, packages/cadre-core/src/cadre-node.ts (`admitInboundControlConnection`, `reconcileControlCohort`, the `peer:disconnect` handling of the control node), packages/integration-tests/src/harness/control-cohort.ts (`readCohort`), ../Fret/packages/fret/src/service/fret-service.ts (dead-state verdict, read-only sibling), ../Fret/packages/fret/src/service/probe-backoff.ts (read-only sibling)
repro: verified
difficulty: hard
----

# A phone-shaped owner is never evicted from its members' control cohorts

## What was observed

Measured on 2026-10-07 while writing `cadre-invite-any-member.integration.ts` (the implement pass of `cadre-invitations-redeemable-by-any-member`), with the same scenario in three shapes. In each, owner A founds the cadre, admits always-on member M (`storage` profile, listening on WebSocket) through `addDrone` plus seed delivery, mints a cadre invitation, waits until M holds the invitation's row, and stops; the scenario then polls `readCohort(M)` (the harness helper over FRET's `findCluster`) until A is gone from M's control cohort.

| Owner A | Members | A left M's cohort after |
| --- | --- | --- |
| phone-shaped (`listenAddrs: []`) | M alone | not within 300 s |
| phone-shaped (`listenAddrs: []`) | M and a second member N, connected to each other | not within 300 s |
| listening on a loopback WebSocket port | M alone | about 5 s |
| listening on a loopback WebSocket port | M and N | 4 to 5 s |

While A is still in M's cohort, every control write M makes is offered to a cohort that names A. A device that redeemed the invitation at M in that state saw the member's write wait for the whole commit budget and then fail with `Transaction commit failed: Some peers did not complete: <A>` (about 50 s), answered as the retryable refusal `conflict`; the device had already given up at its 28.5 s per-address deadline. M's own control reads failed `cohort-unreachable` for about 25 s after A stopped before the retry loop got them through.

The scenario file's header records the same, and the committed scenario gives A a listen address for this reason.

## Why it happens (as far as the implement pass could see)

FRET marks a peer `dead` only after a run of failed contacts (`deadAfterFailures`, default 3, with a minimum spacing between the failures that count), and only a dead peer leaves every ring view. A contact is a ping or a probe dial. A peer with no address cannot be dialed, so no contact against it ever fails, and it is never marked dead; a disconnect alone is deliberately not a liveness verdict there. A peer with an address is dialed, refused, and dead within seconds.

This is the common household shape the invitation feature is for: a phone owner plus one or two always-on nodes. Until the phone returns, no member can admit a device, remove one, or save any other control change. The symptom is not specific to invitations; `addDrone`'s row or a self-address republish on a member would stall the same way.

## What the fix stage should settle

- Whether cadre-core should tell FRET that an address-less peer is gone when its connection closes (a connection-close verdict for peers that cannot be probed), or FRET should count "no address to dial" as a failed contact for a disconnected peer, or the control write should exclude unreachable cohort members itself. The first two are sibling changes (`../Fret`), so this may route to `blocked/` as an upstream dependency; name the proposed rule if so.
- Whether a member's reads and writes should degrade sooner than the commit budget when a cohort member has no address.

## How to reproduce

In `cadre-invite-any-member.integration.ts`, pass `listenAddrs: []` in `buildA` and run the file: the wait "the stopped owner leaves <member>'s control cohort" times out. Dropping the second member changes nothing. Logs from the implement pass: `tickets/.logs/cadre-invitations-redeemable-by-any-member.any-member.evict.log` (owner alone, 300 s wait) and `...any-member.debug.log` (the write failure with the handler's debug output).
