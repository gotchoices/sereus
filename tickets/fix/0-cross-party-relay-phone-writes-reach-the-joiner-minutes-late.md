description: In a private chat between a phone and a second party connected through a relay, messages now arrive on both sides, but messages from the phone take one to four minutes to show up on the other party, while messages the other way show up about ten seconds after they are saved. One write on the other party also took four minutes to finish.
files:
  - packages/cadre-core/src/strand-instance-manager.ts (joiner strand runtime)
  - packages/quereus-plugin-sereus (strand block storage / read path)
  - ../optimystic/packages/quereus-plugin-optimystic (live read arm refreshes over the network before reading)
  - tickets/complete/rn-cross-party-relay-run.md (the run, logs, timings)
repro: verified
----

# Phone writes reach a cross-party joiner minutes late

## What was run (device + PC, 2026-09-16 23:02–23:23)

Phone (founder, `transaction` profile, relay-only) created a closed chat strand; a PC party
(`storage` profile, `listenAddrs: []`, same loopback dedicated relay) redeemed the invitation, and
both chatted. Setup and scripts: `complete/rn-cross-party-relay-run`. Every strand connection
between the two was `relayed`; the relay held 4 reservations throughout.

## Measured

Convergence is fixed: every message reached both sides and no `cohort-unreachable` /
`BlockUnavailableError` appeared. Latency is lopsided.

| Direction | Send → visible on the other side |
|---|---|
| PC → phone (4 messages) | 8–16 s after the PC's insert resolved, as far as UI polling could resolve it (insert itself 6.5–16 s, once 237 s, see below) |
| Phone → PC, phone sending alone | 59 s (round 1), 80 s (round 2) |
| Phone → PC, both sides sending within 3 s | 163 s (round 2), ~260 s (round 1) |

The PC reads the phone's message on a 2 s poll of its own local database, so the delay is not the
poll. Between 05:20:13 and 05:22:43 the PC's `select` over `App.Message` returned promptly and
repeatedly without the phone's `r2-phone-3` (sent 05:20:00), which the phone itself already showed.

Also seen on the PC:

- Reads of `App.Message` taking 18 s and 24 s with nothing else running on that node
  (05:18:08, 05:18:32).
- Round 1: an `insert into App.Message` sent while the phone was also sending took **236 776 ms**
  to resolve (05:10:07 → 05:14:43). Caveat: that round's poll loop was not guarded against overlap,
  so several reads may have been queued with it. Round 2 used a non-overlapping loop and its
  concurrent insert took 6.5 s; the phone-to-PC delay (163 s) remained.

## Where to look

- Which side is slow: does the phone's commit reach the PC's block storage late (write-side
  propagation from a `transaction`-profile phone over the circuit), or does the PC hold it and its
  reads serve a stale tree (read-side refresh)? Log, on the PC, when the phone's transaction's
  blocks arrive versus when a read first returns the row.
- The asymmetry points at the phone as the writer. A `transaction`-profile node stores nothing for
  others; check whether its commit is pushed to the PC's cohort at commit time or only picked up by a
  later pull.
- Headless: `blind-relay-phone-to-phone-e2e` has the same topology but asserts arrival within a 60 s
  gate and never times it. Add a timing log there with party A on `profile: 'transaction'` to see
  whether this reproduces without a device.
