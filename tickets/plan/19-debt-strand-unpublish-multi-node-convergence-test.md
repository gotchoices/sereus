description: When one member of a group removes a shared network, the other members' apps are supposed to notice and shut their copy down — nothing tests that this actually happens across two machines.
files: packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/strand-watcher.ts, packages/cadre-core/test/strand-unpublish.spec.ts, packages/integration-tests
difficulty: medium
----

# Two-node convergence coverage for strand removal

## What is untested

`CadreNode.unpublishStrand` deletes the shared `Strand` row and converges the *local* node
immediately (it forces a watcher poll and stops any still-running local instance). The
party-wide half of the contract — a **sibling** node, which learns of the removal only by
seeing the row missing on its own next poll, then stops its own running instance and emits
`strand:stopped` — has no test at all. Every existing assertion lives on the node that
issued the removal.

So the documented promise "every cadre node watching the table sees the row vanish on its
next poll and stops its own instance" rests entirely on inspection of
`StrandWatcher.poll` → `CadreNode.handleStrandRemoved`.

## What a test should establish

Two nodes sharing a control network, both running the same strand:

- Node A unpublishes; node B's watcher observes the missing row within a bounded wait.
- Node B stops its local instance and emits `strand:stopped` exactly once.
- Node B does **not** re-add the strand on a later poll (the row is gone, and its tombstone
  should not be mistaken for a discovery).
- A node whose strand filter never admitted the strand is unaffected and logs nothing alarming.

## Where it belongs

Most likely `packages/integration-tests` rather than the `cadre-core` unit suite, since it
needs two real nodes with control-network sync between them. Related existing work:
`plan/10-joiner-db-closed-strand-lifecycle-e2e` builds a comparable multi-node strand
lifecycle scenario, so check whether that harness can host this case instead of standing up
a second one.

Flagged by the implementer of the removal API and confirmed during its review.
