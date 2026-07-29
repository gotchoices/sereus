----
description: Two nodes belonging to the same party only find each other if a test dials one to the other by hand. Left to themselves, as they would be in production, they never connect, so data written on one never reaches the other.
files: packages/integration-tests/src/scenarios/control-cohort-auto-convergence.integration.ts, packages/integration-tests/src/scenarios/control-write-while-alone-convergence.integration.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/peer-record.ts
difficulty: medium
----

# Cadre peers do not dial each other without a manual dial

## Why this is filed now

Until tonight this was invisible: **every** control-DB convergence scenario failed, for a
replication reason tracked as `control-db-convergence-optimystic-p2p`. That root cause is fixed
(four upstream changes in `../optimystic`, `50af693` → `559df6a`), and the integration suite went
from ~18 failures to 3. These two are what was left underneath.

They are **not** the same bug as the one just fixed. Replication now works — the scenarios that
dial manually pass, including `control-db-two-node-convergence`, which converges in 1.3 s where it
previously timed out at 30 s. These two fail earlier, at *connection establishment*.

## The two failures

Both from a full `npx vitest run` in `packages/integration-tests` on 2026-07-29:

```
control-cohort-auto-convergence.integration.ts
  > B converges on an owner-written CadrePeer row via in-node reconcile (production cold-start only)
  Error: Timeout waiting for B observes the X CadrePeer row with no manual control dial after 45000ms

control-write-while-alone-convergence.integration.ts
  > re-replicates an owner CadrePeer row written while alone, once the cohort forms
  Error: Timeout waiting for writer control node sees inbound connection from reader after 15000ms
```

The second names the problem outright: the writer never observes an inbound connection from the
reader. The first is the same thing seen from the other end — its own name says
"no manual control dial" and "production cold-start only", so it is the scenario deliberately
written to cover the case where nothing hand-wires the two nodes together.

Note the second scenario's sibling assertion — the `DeviceToken` case in the same file — was on
the known-failure list before tonight and now **passes**. So that file is not wholly broken;
only the path that waits for an inbound connection is.

## What to work out

The scenarios are the specification here: they encode what production is supposed to do, which is
that a node learns its cadre siblings from the party's own control database (`CadrePeer` rows,
with their signed `PeerAddressRecord` addresses) and dials them, without a test harness
introducing them.

Start by establishing which half is missing, because they need different fixes:

- **Does the reader ever learn the writer's address?** It needs a `CadrePeer` row *and* a usable
  address record. There is a chicken-and-egg risk worth checking explicitly: if the address is
  only learnable *through* the control database, and reaching the control database requires the
  connection, then cold start cannot bootstrap and something else (a seed, a stored anchor) has to
  supply the first address. Establish which mechanism is intended — `docs/architecture.md` covers
  seeds and `SeedTrustPolicy` — and whether it runs in these scenarios.
- **Does it learn the address but not dial?** Then the gap is in whatever should trigger the dial
  on a cold start, and the question is what drives it and how often.

`control-write-while-alone` adds a wrinkle: the row is written while the writer is **alone**, so
it commits solo. That is the same condition that produced the bug fixed upstream in `d6a22d2`,
and the reader must later pull a revision it never saw. That part should now work — but confirm
it rather than assume, because if the connection is fixed and this still fails, the remaining
fault is in re-replication, not dialing, and this ticket should be split.

## Deliberately out of scope

`bug-strand-three-party-replication` — the third remaining failure. Different subsystem
(three-party strand formation), tracked separately. Do not chase it here.

## TODO

- [ ] Determine whether the reader learns the writer's address at all, and by what mechanism.
- [ ] Determine what is supposed to trigger the cold-start dial, and whether it ever runs.
- [ ] Confirm whether the two scenarios share one cause or two; split the ticket if two.
- [ ] Verify the write-while-alone re-replication half separately, now that the upstream fix has landed.
- [ ] Both scenarios green, and the rest of the integration suite no worse (24 of 27 files pass today).
