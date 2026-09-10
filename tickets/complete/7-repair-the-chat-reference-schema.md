description: The richer of the two example chat database schemas had never been run and was broken from its first line; it is now repaired, covered by a test that writes rows through every rule it declares, and reviewed.
files: schemas/chat.qsql, schemas/chat-simple.qsql, docs/reference-app-rn.md, packages/quereus-plugin-sereus/test/e2e/chat-schema.e2e.spec.ts, packages/quereus-plugin-sereus/test/helpers/qsql-body.ts, packages/quereus-plugin-sereus/test/strand-schema-drift.spec.ts
----

# Complete: repaired `schemas/chat.qsql` + its first write-through test

Answers **gotchoices/sereus#7**. All eleven defects from the fix ticket are addressed; the
schema now bootstraps, admits members, and refuses what it claims to refuse. `chat.qsql` keeps
its own design — it was **not** converged toward `chat-simple.qsql`.

## What landed

**`schemas/chat.qsql`** — repaired in place:

- `Attachment` gained the `Sequence integer` column its primary key already named. That single
  missing column is why the file had never loaded at all (D1).
- `Response.OriginalId` / `Response.ResponseId` / `Attachment.MessageId` retyped from
  `datetime` / `string` to `integer`. Both tables gained `InsertOnly` + referential-existence
  checks, and `Attachment` gained the same `TimeValid` window `Message` has (D2).
- The two `valid(...)` calls — a function that does not exist — became `verify(...)` (D3).
- All four `verify(...)` calls now pass `'ed25519'` explicitly; without it the function
  defaults to secp256k1 and every genuinely signed write was refused (D7).
- Both bootstrap branches rewritten with the committed/live count pair from
  `schemas/strand.qsql`. A CHECK is evaluated with the new row already present, so the old
  `not exists (select 1 from Invite)` was false even for row one — the schema could not be
  started (D8).
- Every inserted-row reference inside a check is `new.`-qualified and every context value
  `context.`-qualified. In `Invite.InsertValid` this is load-bearing: bare `Key` / `CanInvite`
  bound to `MemberKey.Key` and `Member.CanInvite` from the subquery's own `from` clause, so the
  digest covered the *inviting* member instead of the new invitation (D9).
- `UsedInvite.ValidUsage` compares the redemption count against a limit instead of using a bare
  `count(1)` as a boolean, so a one-time invitation is redeemable exactly once (D10).
- `Message.IdValid` kept, now commented that the gapless-sequence pattern is unsafe on this
  stack (a concurrent duplicate key is silently last-writer-wins, not refused) (D6).
- `old.id` → `old.Id` (D5). Two-line orientation header added.
- The stale `-- insert into Member ...` example replaced with the real two-statement
  transaction.

**D11 (the `Member` / `UsedInvite` cycle) was resolved by documenting, not by breaking it.**
`UsedInvite.MemberValid` is a real integrity check and dropping it widens what `UsedInvite`
accepts, so both tables carry a comment stating that redeeming an invitation is one transaction
inserting both rows. The test proves that shape works.

**D4 closed as no-change**, as the fix ticket predicted. Quereus registers both `X` and
`context.X` for every mutation-context variable, ahead of column symbols, so the bare spelling
always resolved to the context value. The file unifies on `context.` for readability only, and
a comment at `Member.UpdateValid` says so in as many words.

**`schemas/chat-simple.qsql`** — header comment only. No schema change.

**`packages/quereus-plugin-sereus/test/e2e/chat-schema.e2e.spec.ts`** — new, 3 tests. Writes
rows rather than only applying DDL: applying DDL does not plan CHECK constraints, so a call to
a nonexistent function, a name bound to the wrong table, and a wrong signature curve all load
perfectly and fail only on a write. A load-only guard would have stayed green through every
defect above except D1. Keys are real ed25519 pairs and every signature is produced through SQL
(`select sign(digest(...), ?, 'ed25519')`) so the test's digest is built by the same code path
the constraint checks against. Every negative case asserts the **constraint name**, not a bare
`rejects.toThrow()` — a bare throw-assertion also passes when the statement never reached the
engine, and keeps passing after the constraint it was meant to prove is deleted.

**`packages/quereus-plugin-sereus/test/helpers/qsql-body.ts`** — new. The comment/string-aware
`declare schema <name> { ... }` body extractor moved here out of `strand-schema-drift.spec.ts`,
which now imports it. Behaviour unchanged.

## Review findings

Reviewed the implement diff first, then the files it should have touched. Lint, typecheck and
the full package suite were run at HEAD before any review edit (green: 111 passed | 1 todo,
10 files) and again after (same). No pre-existing failures surfaced.

### Verified rather than taken on trust

The implementer's mutation sweep (eight defects re-introduced one at a time, each failing the
suite) was re-read but not re-run. The three claims that mattered most were re-established
independently instead:

- **The unauthenticated write paths in "Known gaps".** Re-probed from scratch with a throwaway
  spec (deleted; no artifact left in the tree) rather than accepting the handoff's word. All
  confirmed accepted, and a fourth was found — see below.
- **The three review-added negative cases have teeth.** Each was mutation-checked
  individually: widening `Attachment.TimeValid`'s window, widening `Message.TimeValid`'s
  window, and pointing `Response.OriginalExists` at the wrong column each produce exactly one
  failure naming that constraint. Tree restored between each.
- **`test/helpers/` is not picked up as a spec.** `vitest.config.ts` includes only
  `test/**/*.spec.ts`, so the extracted helper cannot fail as an empty suite.

### Minor — fixed in this pass

- **A test comment stated the wrong rule.** The final invitation case was commented as "a
  member may not mint an invitation that grants a privilege they lack". The actual refusal is
  that `Invite.InsertValid` requires the *inviting* member to hold `CanInvite` at all — `m2` is
  refused even for an invitation granting nothing. Comment rewritten to say what the constraint
  does.
- **Three constraints were declared but never exercised.** `Response.OriginalExists`,
  `Message.TimeValid` and the newly added `Attachment.TimeValid` had no case. All three added,
  and all three mutation-checked as above. `OriginalExists` is asserted against a `ResponseId`
  that does exist, so the refusal can only be the one named.
- **`docs/reference-app-rn.md` was stale in two ways.** It called `schemas/chat.qsql` "the
  production schema" — nothing loads it, and the diff had just re-labelled both files — and its
  embedded copy of `chat-simple.qsql` was missing the `Member.Role` column and wrapped in a
  `declare schema Chat { ... }` the real file does not have. Both corrected, with a line naming
  the file as the source of record.
- **`MemberKey` kept a trailing comma after its `primary key`** that the same diff had removed
  from `Attachment`. Removed for consistency.

### Major — filed as tickets

**`tickets/backlog/bug-chat-schema-authorizes-inserts-only.md`** — `chat.qsql` gates the insert
path and nothing else. Four holes, all re-verified by running them (`repro: verified`):
unauthenticated `Message` update is accepted and rewrites the content; unauthenticated `Message`
delete is accepted; anyone may register a signing key against any member id via `MemberKey`,
which defeats every `verify(...)` in the file; and anyone may burn an unspent one-time
invitation by pairing it with an already-seated member in `UsedInvite`, permanently locking out
its intended holder. The fourth was not in the handoff's list.

Per *Architecture first*, this is filed at the class rung, not as four instances: the ticket's
main arm is a **general sweep** in the e2e suite — for every declared table, attempt an
unauthenticated insert, update and delete and assert a named refusal, with an explicit
allow-list for anything legitimately open — so the next unguarded operation fails the suite
instead of being discovered the same way these were. Types/representation offers no higher rung
here; a `.qsql` file has no type system to make the bad state unrepresentable. The one design
question inside it (are chat messages editable at all?) is stated with a recommended default
and does not block the other three arms, so it is promotable and does not belong in `blocked/`.

**`tickets/backlog/debt-chat-simple-schema-copies-drift-unguarded.md`** — `chat-simple.qsql`
exists four more times as hand-typed copies (three reference apps plus the doc block fixed
above) with no guard, while the security-critical `strand.qsql` has had one since
`strand-schema-drift.spec.ts`. Two copies have already drifted: `Member.Role` is present in the
file and the React Native constant, absent from the web and NativeScript ones. Dormant today —
`grep -rn '\bRole\b'` over both apps' `src/` returns nothing — so it is filed as `debt-`, and
filed at the guard rung rather than as "retype two columns", because retyping leaves the
mechanism that produced the drift completely intact. Checked first that no open ticket claims
these sites: `debt-schema-guide-examples-never-executed` and `feat-shared-causal-history-for-sapps`
both list `schemas/chat-simple.qsql` in `files:` but neither concerns the embedded copies.

### Conditional — recorded as a tripwire, not a ticket

The suite is single-writer and single-session: it never reopens the strand and never opens a
second peer, so it proves neither warm-reopen re-hydration (which `strand-schema.e2e.spec.ts`
proves for `Strand`) nor serialization of two concurrent redeemers of one invitation. Neither
matters while nothing loads `chat.qsql`. Parked as a `NOTE:` in the spec's header docblock,
naming both cases to add if an app ever loads the file.

### Considered and declined

- **`chat.qsql`'s remaining concurrency assumptions** (`UsedInvite.ValidUsage`'s
  `committed` arm, both bootstrap branches, `Message.IdValid`) claim nothing that
  `schemas/strand.qsql`'s `Member.Authorized` does not already claim with the identical idiom,
  and the root cause is tracked at `tickets/blocked/optimystic-concurrent-same-pk-insert-silent-lww.md`.
  Re-filing would be the Nth instance of a class that already has a ticket. The schema comments
  already point a reader at it.
- **`inTransaction`'s empty rollback `catch`** brushes the repo's "don't eat exceptions" rule,
  but the original error is rethrown unchanged and the comment states why a post-failure
  rollback is a no-op. No information is lost; left as written.
- **Whether `chat.qsql` and `chat-simple.qsql` should converge.** Settled by the owner in the
  fix ticket and out of a reviewer's hands.

### Checked and clean

Lowercase SQL reserved words throughout both the schema and the test's SQL (repo rule, not
machine-checkable). No `any`, no inline `import()`, no unused args. The extractor move is a pure
move — the drift guard's own extractor tests still live in `strand-schema-drift.spec.ts` and
still pass. Function decomposition in both new files is small and single-purpose; neither file
is near a size worth splitting (`chat-schema.e2e.spec.ts` 470 lines, `qsql-body.ts` 152 lines,
by `wc -l`). Resource cleanup in `afterEach` shuts down the strand, closes the database and
removes the temp directory, each guarded so one failure cannot skip the next.

## Validation

```
yarn lint                                              # exit 0
yarn workspace @serfab/quereus-plugin-sereus typecheck  # exit 0
yarn workspace @serfab/quereus-plugin-sereus test       # 111 passed | 1 todo, 10 files
```

Just the chat suite: `yarn workspace @serfab/quereus-plugin-sereus vitest run --project e2e
test/e2e/chat-schema.e2e.spec.ts` (~13s).

## Interactions

- `tickets/backlog/debt-schema-guide-examples-never-executed.md` is the same *class* of problem
  (schema examples nobody executes) at `docs/schema-guide.md`. This ticket is evidence for it,
  not a replacement — left untouched.
- No runtime consumer loads `chat.qsql`, so no app can regress from these edits. That is also
  why this test is the only thing standing between the file and re-rotting.
