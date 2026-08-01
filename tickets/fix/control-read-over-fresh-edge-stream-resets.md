----
description: When a device reads shared data over a connection it opened only moments earlier, the read sometimes keeps failing for a full minute because the other side repeatedly drops the request stream — it works on some runs and fails on others with no code difference.
prereq: transactor-key-network-ignores-network-scoping
files: packages/integration-tests/src/scenarios/control-cohort-edge-carries-data.integration.ts, packages/integration-tests/src/harness/forced-cluster.ts, packages/cadre-core/src/cadre-node.ts, ../optimystic/packages/db-core/src/transactor/network-transactor.ts, ../optimystic/packages/db-p2p/src/repo/coordinator-repo.ts
difficulty: hard
----

# Control-DB read over a freshly reconciled connection intermittently fails with repeated stream resets

## Symptom

In `control-cohort-edge-carries-data.integration.ts` (the "edge carries data"
scenario), node B — freshly reconnected to node C via
`CadreNode.reconcileControlCohort`, with the batch coordinator pinned to C by
the `pinCoordinator` test harness — polls a `CadrePeer` read every 250 ms for
60 s. On roughly **half** of the runs that get past boot, every one of those
~240 reads fails with the same aggregate transactor error, and the poll times
out:

```
QuereusError: Error during query on table 'CadrePeer': Query failed:
Some peers did not complete:
12D3KooWBkxetzv16fD2997rSFQfqDQJYX7NFhmcwhk3AEfqr1VU[block:PaWaynQLVfuwhcw4tGh0uX_BDGPyoXWs-VPZOs0OpGk](in-flight)
cause=The stream has been reset; root: The stream has been reset
```

The peer id named in the error is **C itself** (confirmed by the peer-id map
the scenario now appends to its failure message). So B's read, routed to
coordinator C over the just-formed B→C connection, dies because the stream to
C is reset — and it is not a one-off: the reset repeats identically for the
full 60 s window. On other runs of the exact same code the read succeeds in
under a second and the whole scenario passes green.

## Context that may matter

- B had been fully isolated (zero connections) and rejoined the network via a
  single reconcile-formed outbound connection to C. Nothing else about B's
  state differs between passing and failing runs; peer ids (and therefore
  FRET ring positions and coordinator choices) are freshly randomized per run,
  which is the prime suspect for the run-to-run difference.
- The `(in-flight)` tag in the error suggests the transactor considers an
  operation on that block still pending on C when the stream dies.
- The boot-time coordinator-cache poisoning bug tracked by
  `transactor-key-network-ignores-network-scoping` (blocked; fix lives in
  `../optimystic/tickets/fix/coordinator-cache-poisoned-by-boot-time-self-selection.md`)
  is still unfixed. An unverified hypothesis: C's own coordinator cache for
  the block's key may name a peer C cannot usefully reach (e.g. the
  addressless B, which becomes a FRET candidate for C only after the new edge
  forms), sending C's side of the read somewhere that hangs or recurses and
  getting the stream torn down. Verify or kill this with logs before building
  on it.

## Measurement caveat — re-measure before chasing

All observations were taken while `../optimystic` carried **uncommitted
in-flight edits from its own runner** that were built into the dist sereus
consumes (the `corroboration-floor-uses-assumed-cluster-size` /
`announce-addrs-option` line of work; the stale-build guard tripped twice
mid-measurement as those files changed under us). That is exactly the
half-edited-sibling situation the `transactor-key-network-ignores-network-scoping`
ticket warns not to chase symptoms against — hence the `prereq:` on that
ticket: once it unblocks (optimystic settled + rebuilt), first re-run the edge
scenario ~6 times and re-measure. If the carry step no longer fails, close
this ticket with that finding.

## Reproduce / diagnose

From `packages/integration-tests` (each run ~30-90 s; expect the known
boot-gate flake to eat some runs before the carry step is even reached):

```
yarn vitest run src/scenarios/control-cohort-edge-carries-data.integration.ts
```

A failing carry run prints the error above with a `peers: A=… B=… C=…` map.
For depth, add
`DEBUG='optimystic:db-p2p:libp2p-key-network,sereus:cadre:node' OPTIMYSTIC_VERBOSE=1`
and establish: WHO resets the stream (C's membership admission gate? C's repo
protocol handler throwing? the muxer on either side?), and what C's
coordinator cache holds for the failing block's key at that moment.

## Done means

- Root cause of the repeated reset is named with log evidence (not inferred).
- Either a product fix lands (cadre-core or an optimystic ticket is filed and
  referenced here), or the cause is shown to have been the half-edited sibling
  dist and the ticket is closed with ~6 consecutive carry-clean runs as
  evidence.
- `tickets/.pre-existing-known.md` entry for this slug is removed when done.
