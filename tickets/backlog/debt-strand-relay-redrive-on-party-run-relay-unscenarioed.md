description: When a relay run by one of the party's own machines restarts, a shared workspace's node has to re-introduce itself to that relay before it can get its slot back; the code does this, but no end-to-end test restarts such a relay and watches the slot come back, so a regression there would only show up as a slow recovery in production.
files: packages/integration-tests/src/scenarios/strand-circuit-same-party-e2e.integration.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/delegate-admission.ts, packages/cadre-core/src/strand-instance-manager.ts, packages/cadre-core/src/relay-reservation.ts
difficulty: medium
tradeoffs: Every link in the chain is pinned piecewise (hook wiring in the manager spec, hook-before-drive ordering in the supervisor spec, the announce helper is a dozen lines), and the failure mode is a slower recovery rather than a wrong result, so a maintainer may accept the piecewise proof and spend the scenario budget elsewhere.
----

# The re-announce-then-re-reserve sequence against a party-run relay has no scenario

## Background

A cadre relay comes in two kinds. A **dedicated** relay (the `ops/docker/libp2p-infra` deployment, and the fixture both relay scenarios use) admits any peer. A **party-run** relay is a storage-profile `CadreNode` with `enableRelay` on, and it admits a strand node only on a **delegate grant**: the strand's control node announces the strand node's peer id to the relay over the strand-addr RPC (`delegate-admission.ts`), and the relay's connection gate keeps that grant in memory.

`bug-strand-relay-reservation-not-resupervised` (landed 2026-09-14) gave every strand node one relay-reservation supervisor per configured relay. Because a relay restart drops every in-memory grant, each supervisor's `beforeRedrive` hook is `CadreNode.announceDelegateToRelay`: an unthrottled announce of that strand's delegate peer id to exactly the relay about to be re-dialed, awaited before every re-drive after the first attempt.

## What is pinned today

- `packages/cadre-core/test/strand-instance-manager-relay.spec.ts`: the manager hands each supervisor a hook that calls the announce callback with that relay and that node's peer id.
- `packages/cadre-core/test/relay-reservation.spec.ts` (`beforeRedrive` describe): the hook runs before every re-drive and never before the first attempt, runs BEFORE the drive, and a throwing hook does not stop the drive.
- `packages/integration-tests/src/scenarios/strand-circuit-same-party-e2e.integration.ts`: the relay restart end to end, but over the dedicated relay, where the announce folds to an empty result because that relay serves no strand-addr RPC.

## What is not

No scenario restarts a **party-run** relay under a running strand and observes: the grant is gone, the strand supervisor's re-drive announces first, the relay's gate admits the strand node again, and the reservation is re-acquired within the supervisor's backoff (2 s doubling to 60 s) rather than after the periodic grant refresh (up to 15 min). Two things a scenario would settle that reading the code cannot:

- Whether a relay that **rejects** the reservation for a lapsed grant leaves anything poisoned on the client (the reservation store's relay filter, a connection the gate closed) that the next attempt has to clear. The supervisor un-poisons the filter before every drive, so this should be fine, but it is inferred.
- Whether the announce itself succeeds against a relay that has just come back: `announceDelegateToRelay` dials the relay's control node over the control mesh, and the restarted relay may still be bringing its own control database up when the first re-drive fires.

## Expected

- A scenario (a phase appended to the same-party circuit scenario, or a sibling that swaps in a party-run relay) that restarts the relay under a running strand and asserts the strand node's circuit addr is back, the relay's reservation count reaches its pre-restart value, and recovery happened within the supervisor's backoff window rather than the 15 min refresh.
- The scenario names which relay kind it runs against in its title, so the dedicated-relay scenario and this one are not mistaken for each other.
