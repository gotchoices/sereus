----
description: When a second machine is added to someone's party, there is a very brief moment during the hand-off where a freshly saved change could fall between two delivery mechanisms and be missed. Our test hopes to hit that moment by writing quickly; it has no way to make sure it ever does.
files: packages/integration-tests/src/scenarios/strand-late-cadre-join.integration.ts, packages/cadre-core/src/peer-join-backfill.ts
difficulty: medium
tradeoffs: The existing test already fails loudly if any write is lost during a real join, so this buys a guarantee that a specific narrow window was covered rather than fixing a known defect — and the lever for widening the window (shrinking the push batch size) is a test-only configuration that may not resemble how the code behaves in production.
----

# The window this test aims at is never proven to have been hit

## Background, for a reader with no context

When a machine is added to a party that already runs a strand, the strand's data reaches it two
different ways:

- Everything already written arrives by a **one-shot catch-up push**
  (`packages/cadre-core/src/peer-join-backfill.ts`). It lists the sender's whole block store once,
  pushes the blocks in batches, and then records that peer as caught up for the rest of the
  runtime.
- Everything written from then on arrives by **ordinary replication**, because the new machine's
  strand node is now one of the machines each write is copied to.

Between those two there is a moment: the catch-up has already listed the store and moved past a
given block's id, but has not yet finished and marked the peer done. A block saved inside that
moment is not in the list the catch-up is working from, so the catch-up will never push it —
ordinary replication is the only thing that can deliver it. If those two mechanisms do not meet
cleanly there, the user's change is silently missing on the new machine.

## What the current test does, and what it does not

`strand-late-cadre-join.integration.ts`'s third test ("loses no row written while the newcomer is
still catching up") keeps the founder writing a row every 100 ms throughout the whole enrollment,
then proves that every row it wrote is physically present on the new machine and readable there
with the founder shut down. That is a genuine and valuable property, and it would fail loudly if
anything were lost.

What it cannot do is **force** a write into the moment described above. The store being enumerated
holds around 9 blocks and the default batch size is 64, so the whole enumerate-and-push runs as one
batch and is over in a few milliseconds. A writer ticking every 100 ms has a small chance per run of
placing a commit inside it. Across 18 measured runs (2026-09-08) nothing observed whether that ever
happened, and the coverage check has never once seen an outstanding gap — it is satisfied on its
first look every time. So the run is green either way, and a break confined to that narrow moment
could sit undetected.

## What "done" would look like

A test that can state, rather than hope, that a write landed after the catch-up passed its block and
before the catch-up finished — and that the write still arrived. Two levers exist without adding
test-only hooks to production code, and either or both may be enough:

- **`PeerJoinBackfillConfig.maxChunkBlocks`** (default 64) is already reachable from a test through
  `CadreNodeConfig.strandBackfill`. Set to 1 it turns one batch into one network round trip per
  block, stretching the window by orders of magnitude and making a mid-window commit likely rather
  than rare.
- **`PeerJoinBackfillConfig.debounceMs`** shifts when the window opens relative to the writer, which
  matters if the difficulty turns out to be arriving on time rather than the window's width.

Whatever shape it takes, the test should end up able to say *which* run hit the window — an
assertion or a recorded observation, not a log line a reader has to interpret. If it turns out the
window genuinely cannot be observed from the outside, that is a useful answer too, and the honest
outcome is to write it down where the current test's comments already discuss the seam rather than
to leave the question open.

## Where this came from

The review of `scenario-strand-writes-straddle-a-late-join` (2026-09-08). The implementation
handoff raised it as a known gap and the review confirmed it rather than dismissing it: the
scenario's headline claim is broader than what the scenario can force to happen.
