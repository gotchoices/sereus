----
description: We have proved that a second machine can still answer questions about a shared dataset after the first machine is switched off — but only for the handful of rows created when the dataset was first set up. Nothing yet proves the same for rows written afterwards.
files: packages/integration-tests/src/scenarios/strand-membership-closed-strand-e2e.integration.ts
difficulty: medium
----

> **Promoted from `backlog/` 2026-09-03, and the "why it is parked" paragraph below is now out of
> date.** It says this is "a coverage extension rather than a suspected defect" and "very likely to
> pass". Tonight established that the analogous claim on the **control** network was false:
> `complete/control-network-peer-join-block-catch-up` found that a node which had fully converged
> the control database over the network could be missing the storage blocks behind it, and read
> whole tables as **empty, silently, with no error** once it restarted with no connections. The
> cause was that nothing copied a peer's existing blocks to a peer that joined later, and the
> control network — unlike a strand — had no catch-up wired at all.
>
> Strands *do* have that catch-up (`peer-join-backfill.ts`, formerly `strand-backfill.ts`), which is
> why the setup rows in the sixth test are readable offline. But the case below is the one the
> catch-up does **not** cover: rows written *after* the join, which ride along with each commit
> instead of arriving in the sweep. That is now a specific, motivated question rather than a
> formality — and the failure mode it would expose is a silent empty read, the kind a passing test
> suite hides.
>
> Do not assume it passes. If it fails, that is a defect on the same axis as the control one, and it
> gets a `fix/` ticket rather than an adjusted assertion.

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

## Edge cases & interactions

- **Never read through the joiner's database to decide the store is covered.** Doing so can pull
  the very bytes the check waits for and turn a real gap into a pass. Gate on the raw block store,
  as `control-offline-read-after-restart.integration.ts` and the file's own fourth test do.
- **Prove the joiner is genuinely alone** — poll to zero strand connections before reading, rather
  than assuming the founder's `stop()` took effect.
- **Cover a row the catch-up sweep cannot have carried**: write it *after* whole-store coverage has
  already been observed, so a pass cannot be explained by the sweep.
- **Read a table, not just a row count.** The control-side failure presented as an empty table with
  no error, so assert the row's content, not merely that some rows exist.
- **This file is 1600+ lines and four of its tests are intermittently red** on
  `blocked/strand-unique-index-sync-stale-revision`. Run the file several times; a single red run
  matching that fingerprint is not yours. If the new test itself is flaky, that is a finding.
- **Do not extend the sixth test in place if it costs its own clarity** — a seventh test alongside
  it is explicitly allowed by the body above.
