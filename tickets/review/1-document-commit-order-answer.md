description: Documented, where app authors will actually find it, why an app cannot ask its database "give me my rows in the order they were committed" today — and what to do instead.
files: docs/schema-guide.md, schemas/chat-simple.qsql, packages/reference-app-web/src/lib/chat-dml.ts, packages/reference-app-rn/src/chat-operations.ts
prereq:
----

# Commit-order answer, documented

Closes the implement ticket `1-document-commit-order-answer`, itself from upstream report
**gotchoices/sereus#5**. Pure documentation change — no behavior touched, nothing to run beyond
lint and the two reference-app test suites.

## What shipped

**New section in `docs/schema-guide.md`**, `### Ordering Events (There Is No Commit-Order
Column)`, placed between `### Indexes (Performance & Uniqueness)` and `### Common Table
Expressions (CTE), Recursive, and Hints`. States plainly:

- A strand table has exactly the columns you declared — no rowid, no auto-increment, no
  commit-sequence column, no function that returns one. `StampId()` names the current
  transaction; it does not order transactions against each other.
- You cannot fake a server timestamp either — `RANDOM`/current-time are rejected by the
  determinism validator at schema definition time (peers re-execute statements to validate a
  transaction and must reach byte-identical results).
- The ordering *does* exist one layer down: each table is one Optimystic collection, and that
  collection's append-only log assigns a monotonic revision number to every committed
  transaction, agreed by every replica. It is real and currently unreachable from SQL.
- Two caveats stated explicitly so nobody over-reads the guarantee even if it does surface
  later: it is **commit** order, not send order or causal order (concurrent writers are
  ordered by whichever commit the cohort accepted first); and it is scoped to one table's
  collection — no defined order between two different tables.
- **Pattern A** (what the reference apps do today): `order by Timestamp asc, Id asc`, with its
  honest weakness stated — the timestamp is self-asserted, a bad clock silently reorders
  history, nothing checks it.
- **Pattern B**: a happened-before graph (`MessageParent(MessageId, ParentId)` edges) recording
  what each row's author had already seen, same shape as Matrix `prev_events` / Scuttlebutt
  hash chains. Sketch only, no full design — the open design question is parked in
  `tickets/blocked/expose-commit-order-to-sql-decision.md` and the buildable version of this
  pattern is `tickets/backlog/feat-shared-causal-history-for-sapps.md`. Neither is referenced
  by name from the doc itself, per the implement ticket's instruction not to leak ticket slugs
  into user-facing docs.

**`schemas/chat-simple.qsql`**: `Message.Timestamp` now has a `NOTE:` comment — client-asserted,
no server-assigned alternative exists, points at the new guide section. `Message.Id`'s existing
comment untouched.

**Two reference-app query sites** (`chat-dml.ts:67` area docstring, `chat-operations.ts:160`
area comment block) each got one added `NOTE:` line pointing at the same guide section. The
`order by M.Timestamp asc, M.Id asc` queries themselves are byte-for-byte unchanged — verify
with `git diff` if in doubt, only comment lines moved.

## Citations verified against the sibling `../optimystic` checkout

Every file:line/symbol cited in the implement ticket was re-checked against the current
`../optimystic` tree before writing the docs (that repo moves independently and a stale line
number is worse than none):

- `RowCodec.encodeRow` walking `schema.columns` —
  `../optimystic/packages/quereus-plugin-optimystic/src/schema/row-codec.ts` — confirmed, no
  hidden/rowid column anywhere in `optimystic-module.ts` or `optimystic-adapter/vtab-connection.ts`
  (`grep -rn "hidden\|rowid"` over both returns nothing).
- `StampId()` — `.../src/functions/transaction-id.ts` — confirmed: 16-byte peer-id hash + 16
  random bytes, returns `NULL` outside a transaction.
- `LogEntry` / `ActionEntry` — `../optimystic/packages/db-core/src/log/struct.ts` — confirmed,
  carries `timestamp` and the action payload.
- `TreeReplaceAction` — `.../src/collections/tree/struct.ts:20` — confirmed.
- `../optimystic/docs/correctness.md` §6.3 "Ordering Guarantees" — confirmed verbatim: "Within a
  collection: transactions are totally ordered by revision number... Across collections: no
  total order... Timestamps are metadata."
- "Commit revision staleness" — confirmed as a heading-less bolded paragraph in §3 area of
  `correctness.md`, describing the reject-on-restaked-revision behavior.
- §1.4 Execution Model — confirmed: "Non-deterministic SQL functions (RANDOM, datetime-now) are
  rejected by the determinism validator at schema definition time."
- `Collection.selectLog` — `.../src/collection/collection.ts:1126` — confirmed exact line.
- `Log.select` — `.../src/log/log.ts:218` — confirmed exact line.
- Default collection URI `tree://default/<TableName>` — `.../src/optimystic-module.ts:3162` —
  confirmed exact line.
- `composeStrand` setting default vtab args with no collection URI —
  `packages/quereus-plugin-sereus/src/compose-strand.ts` — confirmed the call exists; it is at
  **line 266**, not 265 as the implement ticket stated (line 265 is the immediately preceding
  `db.setDefaultVtabName('optimystic')` call). One-line drift, corrected here, not worth its own
  finding.
- Index collections at `<tableUri>/index/<indexName>` and the plugin-global schema catalog at
  `tree://optimystic/schema` — both confirmed present in `optimystic-module.ts`.

No citation was materially wrong; only the one line-number off-by-one above.

## How to validate this ticket

- Read the new section in `docs/schema-guide.md` (search `Ordering Events`) end to end — it's
  the actual deliverable, worth eyeballing for tone/accuracy more than for mechanics.
- `git diff schemas/chat-simple.qsql packages/reference-app-web/src/lib/chat-dml.ts
  packages/reference-app-rn/src/chat-operations.ts` — confirm every change is comment-only.
- `yarn lint` — clean (run and confirmed).
- `yarn workspace @serfab/reference-app-web test` — 66/66 passed, same count as before this
  change (confirmed against the prior `strand-founding-resume-path` review's own count of 66).
- `yarn workspace @serfab/reference-app-rn test` — 192/192 passed, same count as before.
- No `.pre-existing-error.md` written — nothing failed.

## Known gaps / not done here

- The doc section does not attempt to fully design Pattern B (happened-before edges) — that is
  explicitly deferred to `tickets/backlog/feat-shared-causal-history-for-sapps.md` if/when a
  human picks it up. The schema sketch here is illustrative only, not something meant to be
  copy-pasted into a real app without thought (e.g. no story for pruning old parent edges).
- `docs/architecture.md`, `docs/strands.md`, `docs/cadre-consistency.md` were not touched. The
  implement ticket scoped the write-up to `docs/schema-guide.md` specifically (the file a schema
  author actually opens), and nothing in those three docs currently claims or implies an
  ordering guarantee that would need correcting.
- The `blocked/` decision ticket (`expose-commit-order-to-sql-decision.md`) already existed on
  the board before this ticket started (filed by the prior `plan` stage,
  `is-commit-order-available-to-sapps` per the commit log) — this ticket did not create or
  modify it, only left it un-pre-empted as instructed.

## Needs a human: reply on gotchoices/sereus#5

**Not posted from an agent run** — draft only, for a human to review and post:

> Answering the three concrete questions:
>
> 1. **Can an sApp read its rows in the order they were committed, through SQL, today? No.** A
>    strand table stores exactly the columns you declared — no rowid, no commit-sequence
>    column. The only transaction-related function, `StampId()`, identifies the current
>    transaction; it doesn't order transactions against each other. Rows come back in
>    primary-key order, which with a text/UUID key is not chronological.
>
> 2. **Does the ordering exist somewhere? Yes — one layer below SQL.** Each strand table maps to
>    one Optimystic collection, and that collection's append-only commit log assigns a strictly
>    increasing revision number to every committed transaction, agreed by every replica. It's a
>    real, total order — just not currently plumbed up to the query layer. Two of the functions
>    that would need to change to expose it (`Collection.selectLog`, and `Tree` itself) either
>    discard the revision or don't expose the log at all today.
>
> 3. **Is a strand table exactly one collection? Yes**, with two things sitting alongside it
>    that don't change the answer: each secondary index is its own collection with its own
>    independent revision counter, and there's a single plugin-global schema catalog collection.
>    So the order you'd get is total *within* one table, and undefined *between* two different
>    tables.
>
> On your causal-history design: it's the right fallback regardless of what we decide below, and
> it needs nothing from us to build — it's a pattern (recording which prior messages/events an
> author had already seen, building a happened-before graph) that lives entirely in an app's own
> schema. We've written it up as one of two documented patterns in our schema guide now, so
> other app authors hitting this same question land on it too.
>
> Whether to expose the storage-layer commit order to SQL at all is still an open question for
> us — there's a real design (a table-valued function reading the log) and real tradeoffs (log
> growth, whether every replica is guaranteed to hold full log history), and we're weighing it
> rather than committing to either direction yet. Documented the current state in the meantime
> so nobody has to rediscover this by reading source.

## Tripwires

None new. The two `NOTE:` comments added at the reference-app query sites and the schema
comment are documentation, not tripwires — they point at settled facts (no commit-order column
exists), not at conditions that could later change and need re-checking.
