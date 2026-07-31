description: The safeguard that lets a second person's join survive when two people accept the same invitation at the same moment is only tested by faking the collision on one machine. Nothing yet proves it works when the two joins genuinely arrive at two different machines, which is the only situation it was built for.
files: packages/cadre-core/src/control-database.ts, packages/cadre-core/test/control-formation-use-number-retry.spec.ts, packages/integration-tests/src/scenarios
difficulty: medium
----

## Background

An invitation to join a strand can allow several people to use it. Each acceptance is stamped
with a sequence number — first acceptance, second acceptance, and so on — and that number is
computed by looking at what has already been recorded. If two acceptances are processed at the
very same moment, both can pick the same number, and only one of them can be stored.

An invitation can also require outside approval before an acceptance is allowed: the inviting
party's node calls a web hook, which may be a queue a **human** works through. If the node
throws away an approval it already obtained just because it lost the race for a sequence
number, that person is asked to approve the very same join a second time.

`debt-formation-approval-retry-lost-race` (complete) fixed that. The node now re-uses the
approval it already holds and simply takes the next free sequence number, up to three tries.
Approvals are deliberately not tied to the sequence number, so re-using one is safe.

## What is missing

Every test of that fix stages the collision **artificially, inside a single node**:

- one test replaces the "what is the next sequence number?" lookup with a stub that hands back
  a number already taken;
- another replaces the write itself with a stub that throws an error captured earlier from a
  real collision.

Both prove the recovery *loop* behaves correctly once a collision has occurred, and both use
real database error text rather than invented strings, so a reworded engine error still breaks
them. What neither does is produce the collision the way production produces it.

That matters because the recovery only exists for writers the node's own internal write queue
cannot see. Two acceptances handled by one node are already serialized by that queue and never
collide at all. The recovery is there for **a second node of the same cadre**, or a second
database handle over the same store, committing a sequence number in the window between this
node reading one and writing it. Nothing exercises that.

So the untested question is not "does the retry loop work" — it does — but "does a genuine
two-writer race actually surface as one of the two errors the node recognises, and does the
recovery actually converge?" If a real cross-node race surfaces as some third error, the node
does not recognise it, does not retry, and the joiner is told to start over — silently
reverting to the behaviour the fix was written to remove, with every existing test still green.

## What "done" looks like

A test in `packages/integration-tests` (real network, two real nodes — this cannot live in
`cadre-core`'s unit suite) where:

- one invitation permits at least two acceptances and requires approval from a hook that
  counts how many times it is asked;
- two nodes redeem it concurrently, without either being told to wait for the other;
- both acceptances end up recorded, numbered 1 and 2, with no gap and no duplicate;
- the approval hook was asked **exactly twice** — once per joiner. A third ask is the
  regression this whole line of work exists to prevent;
- each stored acceptance still carries the joining peer's own key, signature, and disclosure
  exactly as submitted.

Worth also confirming the negative case: an invitation permitting only ONE acceptance, redeemed
concurrently by two nodes, leaves exactly one acceptance recorded and refuses the other in a way
the joiner is not told to retry.

If the race turns out to be hard to provoke reliably over a real network, say so in the ticket
rather than weakening the assertions — a flaky test here is worse than none, and the fallback
(two database handles over one store, in `cadre-core`) still covers strictly more than today.
