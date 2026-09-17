description: About half a minute after a machine joins a two-party chat strand, it sends a burst of network traffic equal to five saves, in every run, with nobody saving anything. Over a slow relay to a phone that burst costs tens of seconds. Find which timed job does it and whether it is needed.
files:
  - tickets/complete/relay-round-trips-remeasure-optimystic-012573a2.md (the measurement)
  - packages/integration-tests/src/scenarios/blind-relay-phone-to-phone-e2e.integration.ts (the topology)
  - packages/cadre-core/src/strand-first-sync-gate.ts (first-sync probing after join)
  - packages/cadre-core/src/strand-instance-manager.ts
repro: verified
----

# A joiner sends 45 `/cluster` streams about 25–30 s after joining

## Observed

Remeasure at optimystic `012573a2` (`complete/relay-round-trips-remeasure-optimystic-012573a2`). Two parties connected only through a loopback relay, with the founder on `transaction`. In **every run**, about 25–30 s after B joined, B opened one burst of 45 `/cluster` streams with no insert running. A save costs 9 `/cluster` streams, so this is about 5 commits' worth.

Optimystic's reading (optimystic-87, 2026-09-17) is that this is a sereus/cadre timed job, not optimystic's.

## Where to look

- Which sereus code writes to the strand, or to the control database, on a timer after joining? Candidates: the first-sync gate probing (`strand:writable`, 30 s `strandFirstSync` default), the peer-record refresh (`startRecordRefresh`), participant/membership writes, and hibernation or presence stamps.
- Count commits on B's node, with the collection name and the caller's stack, in the 20–40 s after join. Check whether the burst repeats later on a longer period.
- If the writes are needed, can they be batched into one transaction? If a write stores a value that hasn't changed, skip it.

## Note from optimystic on TornActionError

Until optimystic `fix/concurrent-inserts-from-two-members-tear-and-some-torn-writes-land` (`240cfda0`) lands, a `TornActionError` on a concurrent strand insert may have saved the row anyway. Code that retries a write automatically must not treat that error as "not saved". As of this ticket, no sereus code matches `TornActionError` by name. Check whether this job's writes, or `control-write-retry`'s classifier, would retry after one.
