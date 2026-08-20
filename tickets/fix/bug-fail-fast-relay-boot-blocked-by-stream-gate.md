---
description: A server that reaches the network only through a relay can fail to finish starting when it boots before the relay has learned it is a member — the relay now forwards traffic for it, but still refuses to answer its database reads, and the node treats that first failed read as fatal instead of retrying once its membership record arrives.
files: packages/cadre-core/src/control-database.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/relay-addrs.ts, packages/integration-tests/src/scenarios/relay-only-control-addr.integration.ts
repro: verified
severity: wrong-result
likelihood: unusual
tradeoffs: The window closes on its own once the membership row replicates, so "restart the node after enrollment settles" is a workable operator answer; the fail-soft browser/phone route is unaffected, and a maintainer may judge start-retry machinery (or reordering boot phases) not worth it for a server-shaped edge case.
---

# Fail-fast relay boot: control-DB first hydration dies against a sibling that has not authorized us yet

## What was observed (verified 2026-08-20)

Surfaced while flipping case 2 of `relay-only-control-addr.integration.ts` for
`control-sibling-relay-reservation-denied` (now in `complete/` once its review lands).
Topology: relay-providing control node A (owner, storage profile, armed membership gate —
non-empty anchor and authorized set), and a SAME-PARTY node C with no listener of its own,
`network.relayAddrs` naming A, booting BEFORE A has C's `CadrePeer` row.

The relay-reservation fix works: A admits C's connection for relay purposes and grants the
reservation. But `C.start()` then rejects with:

```
BlockUnavailableError: Block optimystic/schema is unavailable (cohort-unreachable):
  the repo could not determine whether it exists
```

## Root cause chain

- On the fail-fast route, the `/p2p-circuit` listener runs inside `libp2p.start()` — so C
  holds a live connection to A BEFORE its control database initializes.
- C's control-DB initialization then hydrates the Optimystic catalog (the
  `optimystic/schema` read) against a cohort that now includes A.
- A's fail-closed per-stream gate (`CadreNode.authorizeInboundControlStream`) refuses C's
  control-DB streams — correct behavior until C's membership row replicates to A.
- C cannot distinguish "the cohort refuses me (for now)" from "the cohort is gone", reports
  `cohort-unreachable`, treats the first hydration as fatal, and `start()` rejects.

The fail-soft route (bare `/p2p-circuit` search listener + `CadreNode.reserveRelays`) does
NOT hit this: the control DB initializes while the node is still alone (local, cohort of
one), and the relay connection forms only afterwards — proven green in case 3 of the same
scenario. Case 2 therefore uses a different-party reserver to keep the reservation-seam
regression guard decoupled from this defect; flip it back to a same-party member when this
lands.

## Why it matters

Every genuine member booting a `relayAddrs`-configured node sits in this window: its
circuit listener (and thus the connection to the relay) necessarily exists before its own
row could have replicated to the relay. Normally the window is seconds — but
`tickets/blocked/control-peer-row-refresh-invisible-to-third-node` documents a replication
fork under which a third node never learns a newcomer's row, making the window unbounded
for relays that are not the owner.

## Expected behavior

A member booting through a relay that has not yet authorized it should come up (possibly
degraded) and converge once its row replicates — not fail `start()` outright. Candidate
shapes, for whoever designs the fix (none chosen here):

- treat a refused/aborted stream during FIRST schema hydration as retryable (defer to the
  existing reconcile cadence) rather than fatal;
- initialize the control database before the transport listeners come up, so first
  hydration runs solo exactly as the fail-soft route does;
- a start-level retry that distinguishes "cohort refuses me" from a genuinely broken
  config.

Related (do not merge into): `tickets/backlog/bug-control-reads-not-retried-on-transient-failure`
covers retrying reads that fail on TRANSIENT network hiccups; this one is a deterministic
authorization refusal with a different converging condition (row replication, not network
recovery).
