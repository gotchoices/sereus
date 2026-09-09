----
description: A chat app needs to show messages in the order they were sent. Our storage layer assigns every write a monotonic sequence number, but nobody knows whether an app can actually read it — so apps are ordering by client clocks instead. Find out, then say so publicly.
files: packages/quereus-plugin-sereus/src/compose-strand.ts, schemas/chat-simple.qsql, docs/cadre-consistency.md, docs/architecture.md, ../optimystic/docs/correctness.md
difficulty: medium
----

# Is per-collection revision order available to sApps?

Raised as **gotchoices/sereus#5** — a question, not a bug report. The reporter wants to know whether
message ordering is theirs to solve or whether the stack already offers it, and says plainly that
knowing which way we intend it would let them stop hedging.

## Why the question is sharp

From the app's side there is no order: `schemas/chat-simple.qsql` uses client-generated UUID keys
and a client-supplied `Timestamp`; the retired `chat.qsql` tried a strict integer sequence that
cannot work under concurrent writers; and `docs/cadre-consistency.md` proposes HLCs and causal
delivery for the *control* database and records them as unimplemented. Taken alone, that leaves an
app ordering by self-asserted clocks with no authority watching.

But one layer down the order appears to exist already. `../optimystic/docs/correctness.md` §6.3:

> **Within a collection:** transactions are totally ordered by revision number. Revision is assigned
> at commit time and increases monotonically. **Timestamps are metadata.** Transaction ordering is
> determined by log append order (revision), not by wall-clock timestamps. Clock skew does not affect
> correctness.

So the ordering the app wants may already be sitting under the SQL surface, unexposed.

## What this plan must answer

1. **Is per-collection revision order reachable from an sApp through Quereus?** Can an app read its
   rows in commit order — an equivalent of `order by <commit revision>` — rather than by a client
   timestamp?
2. If not, is exposing it plausible, and at what cost?
3. **Is a single strand table a single collection?** The reporter asks directly, and the answer
   decides whether a table's revision order is meaningful for all of its rows or only within some
   finer unit. This is the question that most changes the answer, and it should be settled first.
4. Is ordering considered squarely the sApp's problem, or is something planned?

Question 4 is a product call. If 1-3 come back "reachable" it answers itself; if they come back
"not reachable and expensive to expose", route 4 to `blocked/` with the cost, rather than deciding
unilaterally that every app reinvents ordering.

## The consequence of answering "it is yours"

The reporter has already designed the fallback: each message records the hashes of the messages its
author had already seen, giving a Merkle-DAG of causal history in the app schema — the shape used by
Matrix's `prev_events`, Secure Scuttlebutt's per-feed hash chains, Merkle-CRDTs, and Kleppmann's
Byzantine-fault-tolerant CRDT work. It does not establish absolute time, but it establishes what an
author had seen when they posted, makes back-dated insertion detectable, and lets honest participants
bound a dishonest clock from both sides.

Their point stands on its own: that is implementable entirely in an sApp schema and needs nothing
from us, but **every** sApp storing a sequence of events will want it. So if the answer is "yours",
the follow-on question is whether it should be a shared facility rather than reinvented per app —
park that in `backlog/` rather than growing this ticket.

## Deliverable

A definite answer to 1-3 with citations, recorded where an app developer will meet it —
`docs/architecture.md` or a schema-guide section, not only in this ticket — and a reply on
gotchoices/sereus#5. If ordering turns out to be exposed, a worked example in the chat schema is
worth more than a paragraph.
