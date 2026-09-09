description: Documented, where app authors will actually find it, why an app cannot ask its database "give me my rows in the order they were committed" today — and what to do instead.
files: docs/schema-guide.md, docs/architecture.md, schemas/chat-simple.qsql, packages/reference-app-web/src/lib/chat-dml.ts, packages/reference-app-rn/src/chat-operations.ts
----

# Commit-order answer, documented

Closes the implement ticket `document-commit-order-answer`, itself from upstream report
**gotchoices/sereus#5**. Documentation only — no behavior changed.

## What shipped

**New section in `docs/schema-guide.md`**, `### Ordering Events (There Is No Commit-Order
Column)`, between `### Indexes` and `### Common Table Expressions`. It states:

- A strand table has exactly the columns you declared — no rowid, no auto-increment, no
  commit-sequence column, no function that returns one. `StampId()` names the current
  transaction; it does not order transactions against each other.
- You cannot fake a server timestamp: non-deterministic functions (`RANDOM`, current-time) are
  rejected in defaults / checks / generated columns at `CREATE TABLE` time, because peers
  re-execute a transaction's statements to validate it and must reach the same answer. The
  sanctioned channel for a client clock is **mutation context** (`with context ( ... )`) — which
  moves *where* the value comes from, not how much it is worth.
- The ordering *does* exist one layer down: each table is one Optimystic collection whose
  append-only log assigns a monotonic revision number to every committed transaction, agreed by
  every replica. Real, and currently unreachable from SQL.
- Two caveats stated so the guarantee is not over-read: it is **commit** order, not send or
  causal order; and it is scoped to one table's collection — no defined order across tables.
- **Pattern A** (what the reference apps do): `order by Timestamp asc, Id asc`, with its honest
  weakness stated — the timestamp is self-asserted and nothing checks it.
- **Pattern B**: a happened-before graph (`MessageParent(MessageId, ParentId)` edges), same
  shape as Matrix `prev_events` / Scuttlebutt hash chains. Sketch only; the open design question
  is parked in `tickets/blocked/expose-commit-order-to-sql-decision.md` and the buildable
  version in `tickets/backlog/feat-shared-causal-history-for-sapps.md`. Neither is named from
  the doc itself (no ticket slugs in user-facing docs).

**`schemas/chat-simple.qsql`**: `Message.Timestamp` carries a `NOTE:` — client-asserted, no
server-assigned alternative, pointing at the new guide section.

**Two reference-app query sites** (`chat-dml.ts`, `chat-operations.ts`) each got a `NOTE:` line
pointing at the same section. The `order by M.Timestamp asc, M.Id asc` queries are unchanged.

**Citations** in the implement handoff were re-verified against the sibling `../optimystic`
checkout (row codec, `StampId`, `LogEntry`/`ActionEntry`, `TreeReplaceAction`, `correctness.md`
§6.3 and §1.4, `Collection.selectLog`, `Log.select`, the default `tree://default/<TableName>`
URI, index and schema-catalog collections). One line-number drift found and corrected
(`compose-strand.ts` default-vtab call is line 266, not 265). No citation was materially wrong.

## Review findings

### Checked

Read the implement diff (`478fa77`) before the handoff summary. Re-derived the doc's factual
claims against the `../quereus` and `../optimystic` sources rather than trusting the handoff.
Read every file the change touched plus the ones it should have touched (`docs/architecture.md`,
`docs/strands.md`, `docs/cadre-consistency.md`, both reference-app query sites, both schemas in
`schemas/`). Verified the reference-app diffs are comment-only. Ran lint and both reference-app
suites.

### Major — fixed in this pass

**The guide contradicted itself: ten examples used a default the new section says is rejected.**
`docs/schema-guide.md` declared `created_at text default datetime('now')` (and `sent_at`,
`joined_at`, `created`) in ten table declarations across five schema blocks. Quereus rejects a
non-deterministic expression in a `DEFAULT` at `CREATE TABLE` time — `datetime` is registered
`deterministic: false` (`../quereus/packages/quereus/src/func/builtins/datetime.ts:496`), the
gate runs unconditionally unless `pragma nondeterministic_schema` is set
(`../quereus/packages/quereus/src/schema/manager.ts:2910`), that pragma is set nowhere in this
repo, and the engine's own suite asserts the rejection
(`../quereus/packages/quereus/test/logic/44-determinism-validation.sqllogic:19`). The repo's
real schemas (`chat-simple.qsql`, `control.qsql`) already avoid time defaults, corroborating it.
Fixed: the defaults are removed, the first occurrence explains why and points at the new
section, and the new section now names the sanctioned alternative (mutation context) with a
worked example whose syntax was checked against
`../quereus/packages/quereus/test/logic/46-mutation-context.sqllogic:47`.

### Major — filed as a ticket

**Nothing ever executes the guide's SQL examples**, which is why the above rotted silently. Went
up the ladder rather than filing the instance: the root cause is a missing property ("every
schema example in the guide is accepted by the engine"), not ten bad lines. Filed
`tickets/backlog/debt-schema-guide-examples-never-executed.md` for an extract-and-apply test. It
cites a second, unfixed instance of the same class found while checking: three examples
reference mutation-context variables (`default actor_name`, `check (tenant =
context.current_tenant_id)`) without the `with context ( ... )` clause the engine requires to
resolve them — bare *and* qualified forms both need it
(`../quereus/packages/quereus/test/logic/46-mutation-context.sqllogic:47`,
`50-declarative-schema.sqllogic:567`). Left unfixed deliberately: fixing them one at a time is
the symptom.

### Minor — fixed in this pass

- **Wrong precision claim in both reference apps.** The comments said `Timestamp` "has second
  resolution", but both apps write `new Date().toISOString()` — millisecond. Reworded in
  `chat-dml.ts` and `chat-operations.ts`; the `Id` tiebreak rationale is unchanged and still
  correct, just rarer than the comment implied.
- **Unqualified default-order claim.** The new section said rows "come back in primary-key
  order" as a flat statement. True of the common plan, not of one served by a secondary index.
  Reworded to say the order is whatever the plan produced and to write the `order by` you mean.
- **Pattern B's sketch was not a schema block.** Every other table example in the guide is
  wrapped in `schema "..." version N using (...) { }`; this one was bare, so the block a reader
  copies would not have applied. Wrapped.
- **The guide was unreachable.** `docs/schema-guide.md` was linked from no other doc and no
  README — awkward for a ticket whose premise is "documented where app authors will find it".
  Added it to the Internal Documentation list in `docs/architecture.md`.
- **Stale ticket path.** `tickets/backlog/feat-shared-causal-history-for-sapps.md` pointed at
  `tickets/implement/1-document-commit-order-answer.md`, a file that no longer exists. Repointed
  at the doc section and the slug.

### Tripwires

None recorded. The concerns found were either already wrong (fixed above) or wrong the moment
someone copies an example (a ticket, not a tripwire) — nothing in this change is a "fine now,
matters if X later" shape.

### Considered and declined

The new section omits the `pragma nondeterministic_schema` escape hatch that would let
`default datetime('now')` through. Deliberate and left as-is: setting it would break the
re-execution validation the whole strand model rests on, so advertising it in an sApp-facing
guide would be an attractive nuisance. Not marked with a `NOTE:` — the section's own text
("peers re-execute ... and must reach the same answer") already carries the reason.

### Not checked

The guide's non-schema examples (window functions, LATERAL/JSON, VALUES-based views, `declare
schema` / `diff schema` workflow) were not verified against the engine. Out of scope here and
covered by the filed debt ticket's harness.

## Validation

- `yarn lint` — clean, exit 0.
- `yarn workspace @serfab/reference-app-web test` — 3 files, 66/66 passed (unchanged count).
- `yarn workspace @serfab/reference-app-rn test` — 10 files, 192/192 passed (unchanged count).
- No `.pre-existing-error.md` written; nothing failed.

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

## Known gaps

- Pattern B is a sketch, not a design — the buildable version is
  `tickets/backlog/feat-shared-causal-history-for-sapps.md` (e.g. no story for pruning old
  parent edges).
- `docs/strands.md` and `docs/cadre-consistency.md` untouched: read, and neither claims or
  implies an ordering guarantee that would need correcting.
- `tickets/blocked/expose-commit-order-to-sql-decision.md` pre-dates this ticket (filed by the
  `is-commit-order-available-to-sapps` plan stage) and was left un-pre-empted.
