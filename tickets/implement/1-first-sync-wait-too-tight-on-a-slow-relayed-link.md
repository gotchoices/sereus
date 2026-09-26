description: A phone joining a shared workspace through a relay on a slow connection usually needs longer to receive that workspace's data than the wait we allow, so the join reports "not ready yet" and the app has to ask again. Give the wait enough room for a slow relayed link.
architecture: docs/strands.md#joining-no-writes-before-the-first-sync
files:
  - packages/cadre-core/src/strand-first-sync-gate.ts (DEFAULT_STRAND_FIRST_SYNC_TIMEOUT_MS, and the doc comment that carries its measurement)
  - packages/cadre-core/src/types.ts (StrandFirstSyncConfig's doc, around line 745)
  - packages/cadre-core/src/cadre-node.ts (addStrand / whenStrandWritable, around lines 4649-4674 — reader only, no change expected)
  - docs/strands.md ("Joining: no writes before the first sync")
  - docs/reference-app-rn.md (the paragraph on the widened ping deadline — same kind of phone-shaped default)
  - .release-notes.pending.md
----

# A joining machine's wait for its first sync is shorter than a relayed slow link needs

## What is wrong

A machine that has never held a strand's data must not write to it, so `CadreNode.addStrand` withholds the database until the strand's rows have arrived from another member, and rejects with the retryable `StrandAwaitingFirstSyncError` if that has not happened within `strandFirstSync.timeoutMs` — `DEFAULT_STRAND_FIRST_SYNC_TIMEOUT_MS`, 30 seconds. The comment at that constant justifies 30 s from a measurement over a **direct** connection (about 1.3 s) plus an unquantified allowance for a relayed path.

Measured on 2026-09-26 (see "Measurements" below), a first sync between two relay-only nodes on a link with a 1.8 second round trip takes **23, 27, 31 and 41 seconds** over four runs — so the 30 second default is inside the run-to-run spread, and roughly half of those joins would have been rejected as "not writable yet" even though the sync was progressing normally and completed. The reference React Native chat app sets nothing for this, so it takes the 30 s default; the app that reported the upstream issue had raised it to 120 s, which is why its symptom was a two-minute wait rather than a 30 second one.

This is not the cohort read deadline the sibling ticket is about. It is sereus's own budget, and it is the limit that binds first on a relayed slow link today.

## Expected behaviour

A relay-only machine joining a strand over a link with a round trip of a couple of seconds completes `addStrand` without the caller having to retry. The rejection stays reserved for "no other member has been reachable at all", which is what it is for.

## Measurements

One Windows developer machine, two relay-only `CadreNode`s (`listenAddrs: []`, a shared loopback dedicated relay), the reduced blind-relay topology, one-way per-frame outbound delay of 900 ms applied with `harness/ws-latency.ts` in `pipelined` mode — so a round trip costs about 1.8 s. Time is measured from `addStrand` to the strand becoming writable, for a machine that holds nothing of the strand yet:

| cohort read deadline in force | first sync completed after |
| --- | --- |
| 1000 ms (today's default) | 22.9, 27.5, 31.1, 41.0 s |
| 5000 ms (the sibling ticket's candidate) | 35.0, 42.3, 45.9 s |

The second row matters for the value chosen here: raising the cohort read deadline makes a consult against a peer that cannot answer cost longer, and this phase runs several of those, so the band this default has to clear moves up with it. Pick a value that clears the band at whatever the sibling ticket lands, not just today's.

## Recommendation

120 seconds, which is what the reporting app had already chosen for itself, against a worst measured sample of 46 s. State the cost at the constant: the wait is what an app's `addStrand` sits in before it is told "not yet", so a larger value makes a genuinely unreachable strand take longer to report — bounded by the fact that the rejection is retryable, the strand stays launched and keeps probing, and `strand:writable` fires the moment the sync lands, so an app that listens for the event rather than awaiting the call is unaffected either way.

## Do

- Raise `DEFAULT_STRAND_FIRST_SYNC_TIMEOUT_MS` and rewrite its doc comment to carry the measured band above, the machine and link it was measured on, and what the larger value costs. Keep the existing direct-connection measurement — it is still the fast case.
- Check `packages/cadre-core/test/strand-first-sync-gate.spec.ts` and the strand-instance-manager specs for anything that asserts the 30 s number or leans on it for timing, and update rather than loosen.
- No new test. The value is a constant with no branching, the gate's own behaviour is already covered, and the band above was measured with an instrument this repo does not commit for it (see the sibling ticket on where those numbers live).
- `docs/strands.md` ("Joining: no writes before the first sync") and `docs/reference-app-rn.md`: say what the default now is and why a relayed phone needs it. The React Native doc already explains the widened ping deadline for the same kind of reason; this belongs beside it.
- One line in `.release-notes.pending.md`: a phone joining a shared workspace over a relay is no longer told "not ready yet" while its first sync is still arriving normally.
