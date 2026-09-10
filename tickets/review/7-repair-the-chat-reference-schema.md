description: The richer of the two example chat database schemas had never been run and was broken from its first line; it is now repaired and covered by a test that actually writes rows through every rule it declares.
files: schemas/chat.qsql, schemas/chat-simple.qsql, packages/quereus-plugin-sereus/test/e2e/chat-schema.e2e.spec.ts, packages/quereus-plugin-sereus/test/helpers/qsql-body.ts, packages/quereus-plugin-sereus/test/strand-schema-drift.spec.ts
difficulty: medium
----

# Review: repaired `schemas/chat.qsql` + its first-ever write-through test

Answers **gotchoices/sereus#7**. All eleven defects from the fix ticket are addressed; the
schema now bootstraps, admits members, and refuses what it claims to refuse. `chat.qsql` keeps
its own design — it was **not** converged toward `chat-simple.qsql`.

## What landed

**`schemas/chat.qsql`** — repaired in place:

- `Attachment` gained the `Sequence integer` column its primary key already named. That single
  missing column is why the file had never loaded at all (D1).
- `Response.OriginalId` / `Response.ResponseId` / `Attachment.MessageId` retyped from
  `datetime` / `string` to `integer`, matching the `Message.Id` values they hold. Both tables
  gained the `InsertOnly` + referential-existence checks the rest of the file's style implies,
  and `Attachment` gained the same `TimeValid` window `Message` has (D2).
- The two `valid(...)` calls — a function that does not exist — became `verify(...)` (D3).
- All four `verify(...)` calls now pass `'ed25519'` explicitly. Without it the function defaults
  to secp256k1, so every genuinely signed write was refused (D7).
- Both bootstrap branches rewritten with the committed/live count pair from
  `schemas/strand.qsql`. A CHECK is evaluated with the new row already present, so the old
  `not exists (select 1 from Invite)` was false even for row one — the schema could not be
  started (D8).
- Every inserted-row reference inside a check is now `new.`-qualified and every context value
  `context.`-qualified. In `Invite.InsertValid` this is load-bearing: bare `Key` / `CanInvite`
  bound to `MemberKey.Key` and `Member.CanInvite` from the subquery's own `from` clause, so the
  digest covered the *inviting* member instead of the new invitation and no correct signature
  could ever match (D9).
- `UsedInvite.ValidUsage` now compares the redemption count against a limit instead of using a
  bare `count(1)` as a boolean, so a one-time invitation is redeemable exactly once (D10).
- `Message.IdValid` kept, now carrying a comment that says plainly the gapless-sequence pattern
  is unsafe on this stack (a concurrent duplicate key is silently last-writer-wins, not
  refused), matching the `chat-simple.qsql` wording and pointing at `docs/schema-guide.md` (D6).
- `old.id` → `old.Id` (D5). Two-line orientation header added.
- The stale `-- insert into Member ...` example at the bottom of the `Member` block was
  replaced: it showed a single unsigned insert, which cannot work. It is now the real
  two-statement transaction.

**Decisions the reviewer should sanity-check, both called out in the fix ticket as open:**

- **D11 (the `Member` / `UsedInvite` cycle) was resolved by DOCUMENTING, not by breaking it.**
  `UsedInvite.MemberValid` is a real integrity check and dropping it widens what `UsedInvite`
  accepts, so both tables now carry a comment stating that redeeming an invitation is one
  transaction inserting both rows. The test proves the transaction shape works.
- **D4 was closed as no-change, as the fix ticket predicted.** Quereus registers both `X` and
  `context.X` for every mutation-context variable and registers them ahead of column symbols,
  so the bare spelling always resolved to the context value. The file unifies on `context.` for
  readability only — `MemberKey` is also a table name here, so the bare form misleads a human.
  A comment at `Member.UpdateValid` says this in as many words so nobody reads it as a bug fix.

**`schemas/chat-simple.qsql`** — header comment only, now saying which of the two files it is.
No schema change; the reference apps' embedded copies are unaffected.

**`packages/quereus-plugin-sereus/test/e2e/chat-schema.e2e.spec.ts`** — new, 3 tests.

**`packages/quereus-plugin-sereus/test/helpers/qsql-body.ts`** — new. The comment/string-aware
`declare schema <name> { ... }` body extractor moved here out of `strand-schema-drift.spec.ts`,
which now imports it. Behaviour unchanged; the drift guard's own extractor tests still live in
that spec and still pass.

## How to validate

```
yarn workspace @serfab/quereus-plugin-sereus test     # 111 passed | 1 todo, 10 files
yarn lint                                             # exit 0
yarn workspace @serfab/quereus-plugin-sereus typecheck # exit 0
```

Just the new suite: `yarn workspace @serfab/quereus-plugin-sereus vitest run --project e2e
test/e2e/chat-schema.e2e.spec.ts` (~14s).

### What the test actually does, and why it is shaped that way

Applying DDL does not plan a table's CHECK constraints. A call to a nonexistent function, a
name bound to the wrong table, and a wrong signature curve all **load perfectly** and only fail
when somebody writes a row — which is exactly how these defects survived. A load-only guard
would have stayed green through every defect above except D1. So the suite writes rows:
bootstrap invite → founding member + UsedInvite in one transaction → member key → signed
rename → message at `Id = 0` → message at `Id = 5` refused → attachment + response → second
member-signed invitation → second member joins → second redemption of the one-time invitation
refused → member delete refused. Keys are real ed25519 pairs from
`generatePrivateKey` / `getPublicKey`; every signature is produced through SQL
(`select sign(digest(...), ?, 'ed25519')`) so the test's digest is built by the same code path
the constraint checks against.

Two details worth knowing if you extend it:

- Boolean fields in a signed digest are written as SQL `true` / `false` **literals**, not bound
  parameters. `digest` tags BOOLEAN and INTEGER differently, so a JS boolean that arrived as an
  integer would produce a digest no constraint could match.
- Every negative case asserts the **constraint name** in the failure
  (`expectRefusedBy(fn, 'IdValid')`), not a bare `rejects.toThrow()`. A bare throw-assertion
  also passes when the statement never reached the engine — a typo, a `with context` clause in
  a position the parser rejects — and keeps passing after the constraint it was meant to prove
  is deleted.

### Evidence the test has teeth (mutation sweep)

Each defect was re-introduced one at a time into `chat.qsql` and the suite re-run. All eight
mutations fail the suite; the tree was restored between each:

| re-introduced | result |
| --- | --- |
| D1 missing `Sequence` column | 2 failed |
| D3 `valid(` instead of `verify(` | 1 failed |
| D7 curve argument dropped | 1 failed |
| D8 `not exists` bootstrap (Invite) | 1 failed |
| D8 `not exists` bootstrap (Member) | 1 failed |
| D9 unqualified names in the subquery | 1 failed |
| D10 bare `count(1)` as a boolean | 1 failed |
| D2 `Response` columns back to `datetime` | 1 failed |

Every negative case was also confirmed to reject for the *intended* reason, by logging the
engine's message once during development: `UpdateValid`, `IdValid`, `MessageExists`,
`ResponseExists`, `InsertValid` (Invite), `ValidUsage`, `InsertValid` (Member),
`CantDelete (false)`. Those names are now asserted, so the check is permanent.

## Known gaps — please read before signing off

**1. Three unauthenticated write paths remain in `chat.qsql`. They are NOT regressions and were
NOT in the fix ticket's defect list, so they were deliberately left alone rather than
guessed at — but a consumer reading this file as a security reference will be misled.** All
three were verified by running them against the repaired schema (probe run, since deleted):

- `update App.Message set Content = '...' where Id = 0` with a garbage `MemberKey` /
  `MemberSignature` is **ACCEPTED** and the content is rewritten. `MessageAuthorized` is
  `check on insert` only, and neither `IdValid` nor `TimeValid` looks at the signer.
- `delete from App.Message where Id = 0` unauthenticated is **ACCEPTED**; the row is gone.
  `Message` has no `on delete` constraint at all (unlike `Member.CantDelete`).
- `insert into App.MemberKey (MemberId, Key) values ('m1', <attacker key>)` is **ACCEPTED**.
  `MemberKey` carries no constraints whatsoever, so anyone can register a signing key against
  any member id and then sign as that member — which defeats every `verify(...)` in the file.

These are one theme with three arms — *`chat.qsql` authorizes inserts but not updates or
deletes, and `MemberKey` is entirely unguarded* — and should be **one** ticket, not three. It is
a design question (are messages editable? what authorizes registering an additional member key
— the member's existing key, or the invitation?), which is why it was not settled here.

**2. Concurrency.** `UsedInvite.ValidUsage`'s `committed.UsedInvite = 0` arm and both bootstrap
branches inherit the same conflict-detection assumptions as `schemas/strand.qsql`'s
`Member.Authorized`, which uses the identical idiom. Nothing new is claimed for them, and the
test is single-writer in-process — it does not exercise two concurrent redeemers. Same caveat
applies to `Message.IdValid`, which is now commented to say so.

**3. Coverage the suite does not have.** It exercises the `local` transactor only (no cohort, no
peer round trips), and it never restarts the strand, so nothing proves the chat schema
re-hydrates cleanly on a warm reopen the way `strand-schema.e2e.spec.ts` proves for `Strand`.
`Attachment.TimeValid` is newly added and only its accepting path is covered — an
out-of-window attachment timestamp is not tested.

**4. Nothing in the product loads `chat.qsql`.** That is unchanged, and is why this test is the
only thing standing between the file and re-rotting.

## Interactions

- `tickets/backlog/debt-schema-guide-examples-never-executed.md` is the same *class* of problem
  (schema examples nobody executes) at `docs/schema-guide.md`. This ticket is evidence for it,
  not a replacement — it was left untouched.
- No runtime consumer loads `chat.qsql`, so no app can regress from these edits.
- `chat-simple.qsql` changed only in its comment header; the embedded copies in
  `reference-app-rn` / `reference-app-ns` / `reference-app-web` were not touched and did not
  need to be.
