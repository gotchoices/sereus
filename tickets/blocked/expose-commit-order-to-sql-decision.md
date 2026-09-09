description: Our storage engine already knows the exact order in which every write to a table landed, but applications cannot see that order — so every app that stores a sequence of events (chat messages, ledger entries, edits) has to invent its own ordering. Deciding whether to expose it is a product call, and the change would land in a neighbouring codebase we do not normally edit from here.
files: docs/schema-guide.md, packages/quereus-plugin-sereus/src/compose-strand.ts, ../optimystic/packages/quereus-plugin-optimystic/src/plugin.ts, ../optimystic/packages/db-core/src/log/log.ts
----

# Decision: should applications be able to read their rows in commit order?

## What a human needs to decide

Two things, in order:

1. **Do we want applications to be able to ask for their rows in the order those rows were
   committed?** Today they cannot, and the workaround every app reaches for is to order by a
   timestamp the writing client supplied about itself.
2. **If yes, do we accept that the change lands in the Optimystic repository rather than this
   one?** `AGENTS.md` describes `../optimystic` as a workspace kept alongside Sereus "for
   reference/debug". This feature cannot be built on the Sereus side; the ordering lives inside
   Optimystic and only Optimystic can publish it.

This is filed here rather than in `backlog/` because the shape is settled but the *whether* is
not, and because the second question is about which repository owns a piece of work — neither is
an agent's call.

## Background, in plain terms

Every table in a strand is stored by Optimystic as a "collection". Each collection keeps an
append-only log of the transactions that have been committed to it, and each of those entries
carries a **revision number**: 1, then 2, then 3, assigned at the moment the network agrees to
commit, never reused, never reordered afterwards. Every replica of that table agrees on the same
numbering. It is, precisely, the answer to "which of these two writes landed first".

Applications never see it. What a query returns is the columns the schema declared and nothing
else. So an app that wants to display messages in order has to store its own timestamp and sort
on that — a number the writing device asserts about itself, which nothing in the stack checks.
That is what our own reference chat apps do today
(`order by M.Timestamp asc, M.Id asc`).

The full evidence for those claims, with file-and-line citations, is in
`tickets/implement/1-document-commit-order-answer.md`.

## What "yes" would cost

**Recommended shape: a read-only table-valued function over the collection log.** Optimystic's
Quereus plugin would register something like `CommitLog('Message')` returning one row per
committed transaction — `(rev, actionId, timestamp, key)` — which an app joins against its own
table:

```sql
select M.*, L.rev
from Message M
join CommitLog('Message') L on L.key = M.Id
order by L.rev;
```

Why this shape:

- **Nothing about how data is stored changes.** The log already exists and already carries
  revision, timestamp and the keys each transaction wrote. This is a reader, not a new
  structure — no migration, no change to what a row contains, no change to the write path.
- **Quereus already supports it properly.** Table-valued functions can declare their columns and
  can advertise physical properties including ordering, so the planner can satisfy
  `order by L.rev` without a sort step.
- **The plumbing is short.** The revision-bearing walk exists as `Log.select`. Two things
  currently hide it: `Collection.selectLog` throws the revision away, and `Tree` has no
  accessor at all. Both are additive fixes inside `db-core`.

**Costs and open engineering questions, honestly stated:**

- **Reading the order costs a walk of the log.** The log is a chain of blocks with no
  compaction that we found; answering "what order did these rows land in" therefore scans the
  table's whole commit history, not just the current rows. For a chat strand with a million
  messages that is a million-entry walk per query. A production version would want a bounded
  form (`CommitLog('Message', fromRev)`) or a cached projection. **Not measured** — no
  benchmark was run; this follows from the structure, not from a timing.
- **Log retention has not been proven.** Nothing found prunes the log, and a peer joining late
  is backfilled at the block level, so the history *should* be complete on every replica. That
  was not tested. If a node can ever hold current rows without holding the full log, the
  function would answer differently on different machines — which would be worse than not
  having it. Confirming this is a prerequisite to building it.
- **The cheaper-sounding alternative does not work.** The obvious design — add a hidden `_rev`
  column and stamp each row with the revision it was written at — was considered and rejected.
  The revision is not known until commit succeeds, and a commit that loses a race is retried at
  a higher revision, so the row's own bytes would have to change between attempts. Worse, it
  breaks a property the protocol depends on: validating peers re-execute a transaction's
  statements and must produce identical bytes, and a `_rev` value is not derivable from the
  statements. Recorded here so it is not re-proposed.

## What "no" means

It means ordering is permanently the application's job, and the honest follow-on is that we
should give apps a *shared* way to do it rather than have each one reinvent it — filed as
`tickets/backlog/feat-shared-causal-history-for-sapps.md`. That is not a substitute for commit
order (it records what an author had seen, not a global sequence), but it is strictly better
than a self-asserted clock and it is buildable entirely on our side.

Choosing "no" is defensible: the causal-history pattern is what a Byzantine-tolerant system
actually wants, commit order is a serialization order rather than a causal one, and exposing it
invites applications to depend on a number whose meaning ("which commit won the race") is subtler
than it looks.

## Not blocking anything

`tickets/implement/1-document-commit-order-answer.md` documents the current state and can land
whatever is decided here. It is written to say "the app's problem today, exposing it is under
consideration" and does not pre-announce an outcome.
