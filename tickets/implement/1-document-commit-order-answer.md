description: Answer the question "can my app read its rows in the order they were committed?" in the docs, so app authors stop guessing. The short answer is no — the ordering exists inside the storage engine but nothing at the SQL layer can see it — and that needs writing down where a schema author will meet it.
files: docs/schema-guide.md, schemas/chat-simple.qsql, packages/reference-app-web/src/lib/chat-dml.ts, packages/reference-app-rn/src/chat-operations.ts
difficulty: easy
----

# Write down the commit-order answer where app authors will find it

Raised as **gotchoices/sereus#5**. The research is done — this ticket is the write-up, not
an investigation. Everything below is already verified against the code; the implementer's
job is to render it into `docs/schema-guide.md`, fix two stale comments, and leave a draft
reply for a human to post.

## The verified answers

**1. Can an sApp read its rows in commit order through Quereus? No.** A Sereus strand table is
an Optimystic virtual table, and what that virtual table stores per row is exactly the declared
columns and nothing else: `RowCodec.encodeRow` (`../optimystic/packages/quereus-plugin-optimystic/src/schema/row-codec.ts`)
walks `schema.columns` and serializes those values alone. There is no hidden column, no rowid,
no metadata slot — `grep -n "hidden\|rowid"` over `optimystic-module.ts` and
`optimystic-adapter/vtab-connection.ts` returns nothing.

The only SQL function the Optimystic plugin registers is `StampId()`
(`../optimystic/packages/quereus-plugin-optimystic/src/functions/transaction-id.ts`), which
returns the *current* transaction's identifier and `NULL` outside a transaction. That
identifier is 16 bytes of peer-id hash plus 16 random bytes — unique, but deliberately not
ordered. Storing it in a column records *which* transaction wrote a row, never *when* relative
to another.

Rows come back in primary-key order, because the underlying structure is a B-tree keyed on the
primary key. With a UUID primary key that order is arbitrary.

**2. The ordering does exist — one layer below anything SQL can reach.** Each Optimystic
collection owns an append-only log. Every committed action appends one entry carrying a
revision number that starts at 1 and increases by one each commit, plus the committing node's
wall-clock timestamp and the list of key/row pairs that action wrote
(`LogEntry` / `ActionEntry` in `../optimystic/packages/db-core/src/log/struct.ts`;
`TreeReplaceAction` in `../optimystic/packages/db-core/src/collections/tree/struct.ts`).
`../optimystic/docs/correctness.md` §6.3 states the guarantee: within a collection,
transactions are totally ordered by revision; revision is assigned at commit time; timestamps
are metadata and clock skew does not affect correctness.

That order is stable once written. A commit names the revision it claims, and a cohort member
that already holds that revision under a different action votes to reject — so two writers
cannot both land at the same revision, and the loser retries at a higher one
(`../optimystic/docs/correctness.md`, "Commit revision staleness"). A reversal from the dispute
machinery appends a compensating entry at a *new* revision rather than rewriting history.

So the sequence is real and every replica agrees on it. It is simply not plumbed to SQL:
`Tree` (the collection type the virtual table drives) exposes no log accessor, and the one
log-walking method that does exist on the layer below it, `Collection.selectLog`
(`../optimystic/packages/db-core/src/collection/collection.ts:1126`), yields the action
payloads and **discards the revision and timestamp**.

**3. Yes — one strand table is exactly one collection.** The virtual table maps a table to the
collection URI `tree://<db>/<TableName>`, defaulting to `tree://default/<TableName>` when the
table declaration passes no argument (`optimystic-module.ts:3162`), which is the case for every
Sereus strand table: `composeStrand` sets the default vtab args to `{ networkName, transactor,
keyNetwork }` and no collection URI (`packages/quereus-plugin-sereus/src/compose-strand.ts:265`).
Strands are isolated from each other by their per-strand libp2p network and transactor, not by
the URI.

Two things sit alongside a table rather than inside it, and neither weakens the answer: each
secondary index is its own collection at `<tableUri>/index/<indexName>`
(`optimystic-module.ts:2817`) with its own independent revision line, and the schema catalog is
a single plugin-global collection at `tree://optimystic/schema`. So a table's revision sequence
covers all of that table's rows and only that table's rows. Ordering across two different
tables is not defined — the revision numbers are independent counters.

**4. Ordering is the app's problem today.** Whether it should stay that way is a decision for a
human, filed as `tickets/blocked/expose-commit-order-to-sql-decision.md`. Say in the docs and
in the reply that it is the app's problem *today* and that exposing it is under consideration —
do not announce either outcome.

## What to write

### A new section in `docs/schema-guide.md`

Place it between `### Indexes (Performance & Uniqueness)` and `### Common Table Expressions
(CTE), Recursive, and Hints`. Title it so a reader scanning the contents finds it when looking
for ordering — e.g. `### Ordering Events (There Is No Commit-Order Column)`. Cover, in this
order and in plain prose:

- The blunt statement: a strand table gives you the columns you declared. There is no
  auto-increment, no rowid, no commit-sequence column, and no function that returns one.
  `StampId()` identifies a transaction; it does not order transactions.
- Why you cannot fake a server-assigned timestamp either: Quereus rejects non-deterministic
  functions (`RANDOM`, current-time) in constraints, defaults and computed columns at schema
  definition time, because peers re-execute a transaction's statements to validate it and must
  reach the same answer (`../optimystic/docs/correctness.md` §1.4). Any timestamp in a row is
  therefore supplied by the client that wrote it.
- That the storage layer *does* keep a per-table total commit order (revision, one per
  committed transaction, agreed by every replica), and that it is not currently reachable from
  SQL. Keep this to a short paragraph with the `correctness.md` §6.3 citation — the reader
  needs to know it exists so they do not go looking for a workaround that would duplicate it,
  and needs to know it is unavailable so they do not wait for it.
- **Pattern A — client timestamp with a deterministic tiebreak.** What the reference apps do:
  `order by Timestamp asc, Id asc`. State its one real weakness plainly: the timestamp is
  asserted by the author, so a wrong or dishonest clock silently reorders the conversation and
  nothing in the stack notices. Fine for a cooperative app; not fine when back-dating matters.
- **Pattern B — record what the author had already seen.** Each row carries the identifiers of
  the rows its author had when writing, which yields a happened-before graph in the app's own
  schema. It does not establish absolute time, but it makes an insertion claiming to predate
  something its author had demonstrably already seen detectable, and lets honest participants
  bound a dishonest clock from both sides. Note it is the shape used by Matrix (`prev_events`)
  and Secure Scuttlebutt (per-feed hash chains). Give a short schema sketch — a `Message`
  table plus a child table of `(MessageId, ParentId)` edges is enough; do not design a full
  facility here, and do not reference the backlog ticket from the docs.

Keep it proportionate — this is a guide section, not an essay. Match the surrounding style:
short prose, one runnable SQL block per pattern.

### `schemas/chat-simple.qsql`

The `Message.Timestamp` column has no comment. Add a short one saying it is client-asserted,
that no server-assigned alternative exists (determinism validator), and pointing at the new
schema-guide section. Leave the existing `Id` comment alone — it is correct.

### The two reference-app queries

`packages/reference-app-web/src/lib/chat-dml.ts:73` and
`packages/reference-app-rn/src/chat-operations.ts:168` both order by `M.Timestamp asc, M.Id asc`
with nothing saying why. Add one `NOTE:` line at each site: client-asserted clock, chosen
because the engine exposes no commit-order column, with the guide section named. Do not change
the queries.

### A draft reply for gotchoices/sereus#5

Follow the precedent in `tickets/complete/strand-founding-resume-path.md` — write it into the
`review/` handoff under a `## Needs a human: reply on gotchoices/sereus#5` heading, marked as
**not posted from an agent run**. It should answer 1, 2 and 3 directly, credit that the
reporter's causal-history design is the right fallback and needs nothing from us, and say the
"should this be exposed" question is open with a human. Do not post it.

## Edge cases & interactions

- **Do not overstate the guarantee.** Revision order is *commit* order, not send order and not
  causal order. Two peers posting concurrently are ordered by which commit the cohort accepted
  first. The docs must not imply an app would get "the order messages were sent" even if
  revision were exposed — that ordering does not exist anywhere in the system.
- **Cross-table ordering is undefined.** Each collection has its own counter starting at 1.
  A reader who takes "there is a total order" and applies it across two tables will be wrong.
  Say so explicitly.
- **Do not claim the log is queryable "with a bit of work".** `Collection.selectLog` drops the
  revision, and `Tree` has no accessor for it at all. The nearest thing that surfaces revision
  is `Log.select` (`../optimystic/packages/db-core/src/log/log.ts:218`), which is internal to
  db-core. Anything reaching it is a change in the Optimystic repository, which is the blocked
  ticket's subject.
- **Indexes and the schema catalog are separate collections.** If the doc says "a table is a
  collection" without that caveat, the next reader concludes a single write touches one
  revision line. An insert into an indexed table commits into the table's collection *and*
  each affected index collection.
- **Verify every file:line citation before writing it down.** The Optimystic repository is a
  sibling workspace and moves independently; a line number that has drifted is worse than no
  citation. Cite the symbol name alongside the line so a drifted number is still recoverable.
- **Reference apps: no behaviour change.** These edits are comments only. `yarn lint` and the
  existing app tests must pass unchanged; a diff that alters a query is out of scope.

## TODO

- Verify each cited path/line/symbol in `../optimystic` still resolves; correct any that drifted.
- Write the new `### Ordering Events (There Is No Commit-Order Column)` section in
  `docs/schema-guide.md` covering the six bullets above, with both patterns as runnable SQL.
- Comment `Message.Timestamp` in `schemas/chat-simple.qsql`.
- Add the `NOTE:` line at both reference-app `order by` sites.
- Run `yarn lint` and the reference-app test suites; confirm nothing moved.
- Write the `review/` handoff, including the un-posted draft reply for gotchoices/sereus#5 and
  a pointer to `tickets/blocked/expose-commit-order-to-sql-decision.md` for question 4.
