----
description: We have proved that a second machine can still answer questions about a shared dataset after the first machine is switched off — but only for the handful of rows created when the dataset was first set up. Nothing yet proves the same for rows written afterwards.
files: packages/integration-tests/src/scenarios/strand-membership-closed-strand-e2e.integration.ts
difficulty: medium
----

## The gap

The closed-strand end-to-end file now holds two adjacent proofs that do not quite meet:

- The **fourth** test proves that blocks the founder writes *after* the second machine
  connects physically land in that machine's own storage. That is a storage claim only — it
  says nothing about whether those blocks can be read back.
- The **sixth** test proves the second machine can answer reads entirely on its own once the
  founder is stopped. But the only rows it reads are the three the founder created while
  setting the strand up: the header, the founding member, the founding manager.

So nobody has demonstrated the combination: **write a row after the two machines are
connected, stop the founder, and read that row back from the second machine alone.** That is
the case an application actually lives in — a strand is set up once and written to for the
rest of its life — and it exercises a different path than the setup rows do, because setup
rows reach the second machine through the catch-up sweep while later rows ride along with
each commit.

## What the work looks like

An extension of the sixth test, or a seventh alongside it: bring up the strand, admit a
member and write an application row from the founder, wait for whole-store coverage through
the raw block store (never through the second machine's database — reading through it can
pull the very bytes the check is waiting for), stop the founder, poll the second machine down
to zero strand connections, then read the *newly written* row back.

## Why it is parked rather than urgent

The two existing proofs together make it very likely to pass, and it is a coverage extension
rather than a suspected defect. It becomes worth doing whenever someone needs to state the
durability guarantee for ordinary writes rather than for setup data.

Note that four of the six tests in this file are intermittently red on a platform fault
tracked in `blocked/strand-unique-index-sync-stale-revision`; a new test in this file inherits
that flakiness risk if it performs writes.
