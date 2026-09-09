description: Any app that stores a stream of events — chat messages, ledger entries, document edits — needs to show them in a sensible order, and today each app has to invent that from scratch using clocks its own users could lie about. Offer a reusable, tamper-evident way to record what an author had already seen when they wrote something.
files: docs/schema-guide.md, schemas/chat-simple.qsql, packages/quereus-plugin-sereus/src/strand-schema.ts
tradeoffs: It is a schema pattern an app can already write for itself in about twenty lines, so making it a shared facility buys consistency and correct edge-case handling but adds surface area to maintain — and if commit order ever gets exposed at the SQL layer, part of the motivation evaporates.
----

# A shared way for sApps to record causal history

## Where this came from

Raised by the reporter of **gotchoices/sereus#5** while asking whether the stack already
provides message ordering. It does not, at the SQL layer — the verified answer is written up in
`docs/schema-guide.md` under "Ordering Events (There Is No Commit-Order Column)" (landed by the
`document-commit-order-answer` ticket), and `tickets/blocked/expose-commit-order-to-sql-decision.md`
holds the open question of whether it should. The reporter had already designed the fallback, noted it needs nothing from us, and
observed that **every** app storing a sequence of events will want the same thing. This ticket is
that observation.

## The problem an app faces today

An app that shows a list of events in order has one tool: a timestamp the writing device puts in
the row about itself. Nothing verifies it. A device with a wrong clock silently scrambles the
order for everyone; a device with a dishonest one can insert an entry that appears to predate
entries its author had demonstrably already read, and no participant can tell.

## The pattern

When an author writes an entry, they also record the identifiers of the entries they had already
received. That turns the event stream into a graph of "this was written after that", built from
statements each author signs about their own knowledge rather than from clocks.

What it gives you:

- **It does not establish absolute time.** Nobody learns when something was written.
- **It does establish what an author had seen.** An entry claiming a position before something
  its author already referenced is self-contradictory and detectable by anyone.
- **It bounds a dishonest clock from both sides.** An entry sits after everything it names and
  before everything that names it, so honest neighbours pin a liar into an interval.
- **It converges.** Every participant that receives the same entries builds the same graph, with
  no coordination and no agreement round.

This is a well-travelled shape, not an invention: Matrix's `prev_events`, Secure Scuttlebutt's
per-feed hash chains, Merkle-CRDTs, and Kleppmann's Byzantine-fault-tolerant CRDT work all use
it.

## What "a shared facility" might mean

Deliberately not designed here — that is a `plan/` ticket's job if this is promoted. The
question to answer first is *what shape* is worth sharing, and the candidates differ a lot in
cost:

- **Documentation only** — a worked pattern in `docs/schema-guide.md` that an app copies. This
  is already partly covered by the implement ticket above, which sketches it as "Pattern B".
- **A schema fragment** an app includes, the way every strand already gets the membership tables
  (`packages/quereus-plugin-sereus/src/strand-schema.ts` applies `schemas/strand.qsql`
  unconditionally). An app would opt in rather than get it automatically — most tables are not
  event streams.
- **Helper functions or views** on top of that: computing the parent set for a new entry,
  detecting a contradiction, and producing a stable linear order from the graph for display.
  The last one is where the real work is — a topological order with a deterministic tiebreak,
  which is also where a naive app most likely gets it wrong.

## Open questions for whoever plans this

- What is the display order? A graph does not linearize on its own; the tiebreak between
  concurrent entries has to be deterministic so every participant renders the same list.
- How many parents does an entry record — every entry not yet referenced, or a bounded
  frontier? Unbounded parent sets grow with the number of concurrent writers.
- What happens when an entry names a parent this replica has not received? The display order has
  to remain sensible mid-sync, which is the normal state, not an exception.
- Does this interact with signing? An unsigned parent list is worth much less — anyone can
  rewrite it. The strand schema already carries member keys; whether entries are signed is an
  app decision today.
- Does it belong to the app at all, or should it eventually be a storage-layer concern? Depends
  on the outcome of `tickets/blocked/expose-commit-order-to-sql-decision.md`.
