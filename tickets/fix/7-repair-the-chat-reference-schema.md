----
description: schemas/chat.qsql is the richer chat reference and is not superseded — it simply was never brought to maturity, and it shows. It has a primary key over a column that does not exist, identifier columns typed datetime, and other signs it has never been loaded. Make it correct, and prove it by loading it.
files: schemas/chat.qsql, schemas/chat-simple.qsql, packages/quereus-plugin-sereus, docs/schema-guide.md
difficulty: medium
tradeoffs: repairing a demonstration schema costs time that adds no runtime capability; leaving it costs every reader who takes it as authoritative
likelihood: certain
----

# Repair `schemas/chat.qsql`

Answers **gotchoices/sereus#7**, where an outside consumer used our schemas as a reference, hit the
defects, and lost time to the detour.

## The ruling that unblocks this (owner, 2026-09-09)

> "chat-simple.qsql wasn't intended to replace chat, but rather evolved as part of bringing the
> reference app to maturity. The reason it seems more evolved is because the original chat app wasn't
> really brought to maturity."

So the earlier framing — "retired, delete it" — is **wrong** and must not be acted on.
`schemas/chat.qsql` is the richer design (invitations, member keys, signature verification); it is
the *immature* one, not the *obsolete* one. Repair it.

## Reproduce first

The defects below all have the flavour of a file that has never been executed. Before fixing
anything, establish whether `schemas/chat.qsql` **loads at all** under Quereus today, and capture the
first error. That answer sizes the rest of the ticket: a file that parses and has three bad columns
is a different job from a file that has never parsed.

Load it the way a consumer would — through `@serfab/quereus-plugin-sereus` — not through a bespoke
harness, so the reproduction matches the reported experience.

## Known defects (the floor, not the list)

1. **A primary key over a column that does not exist** — `schemas/chat.qsql:92`: `Attachment`
   declares `primary key (MessageId, Sequence)` with no `Sequence` column in the table. Decide
   whether attachments are ordered (add `Sequence`) or keyed some other way.
2. **Identifier columns typed `datetime`** — `Response.OriginalId` and `Response.ResponseId` both
   hold message ids but are declared `datetime`.
3. **`Member.UpdateValid` calls `verify(...)`** while every other constraint in the file calls
   `valid(...)`. At most one of those is the real function name.
4. **`Member.UpdateValid` reads `MemberSignature` / `MemberKey` unqualified** where the sibling
   `InsertValid` reads `context.InviteKey` / `context.InviteSignature`. If context columns need the
   `context.` prefix, the update path has never been exercised.
5. **`new.Id = old.id`** — inconsistent identifier case in the same expression.
6. **A strict integer sequence on `Message`** (`Id = 0 or exists(Id - 1)` in spirit) that cannot hold
   under concurrent writers. The earlier framing of this item leaned on the owner's answer to **#5**
   — *"sApp developers can impose their own monotonic scheme using ints and constraints"* — to argue
   the constraint was demonstrating a viable pattern. **That premise has since been refuted and
   documented** (see `docs/schema-guide.md`, "Ordering Events (There Is No Commit-Order Column)",
   the "Not a third pattern" paragraph): a concurrent duplicate key is not refused here, it is
   silently last-writer-wins, so the scheme loses rows without an error. The constraint cannot be
   "made to hold" under concurrent writers. Keeping it as a demonstration of constraint syntax is
   still fine, but it must carry a comment saying plainly that the pattern itself is unsafe on this
   stack — matching the wording now at `chat-simple.qsql:14-18` (silently last-writer-wins, losing
   row lost with no error), not the older "would collide" phrasing — so a reader does not copy it
   into a multi-writer strand and lose messages in production.

Treat 1-5 as certain and 6 as a documentation obligation. Expect the load attempt to surface more.

## Also: say which file is which

Both files ship, and a reader currently has no way to tell that one is a matured working reference
and the other a richer draft. Add a short header comment to each — `chat.qsql` says it is the fuller
design including invitations and signature verification; `chat-simple.qsql` says it is the schema the
reference app actually runs and deliberately omits application-level crypto (it already says the
second half at `chat-simple.qsql:1-3`). Two lines each. Do **not** add a pointer that reads as a
deprecation.

## Edge cases & interactions

- **Do not converge the two schemas.** They are different by intent. Fixing `chat.qsql` means making
  *its own* design correct, not making it resemble `chat-simple.qsql`.
- **Signature/`valid()` semantics.** Constraints 3 and 4 turn on what
  `@optimystic/quereus-plugin-crypto` actually exports and how context columns are addressed inside
  check constraints. Confirm against the plugin's source rather than inferring from either file.
- **Lowercase SQL reserved words** (repo rule) — `chat.qsql` mostly complies; keep it that way in
  anything added.
- **`InsertValid` on `Invite` references `MemberKey`/`MemberSignature` context columns declared in
  the trailing `with context (...)` clause.** Check the same qualification question there as in
  defect 4 — if the fix changes one, it likely changes all of them.
- **No runtime consumer.** Nothing loads `chat.qsql` in the product, so repairing it cannot regress
  the apps — but that is also why nothing has caught the defects. Whatever proves the repair must be
  a checked-in test, or the file drifts straight back.

## TODO

- [ ] Attempt to load `schemas/chat.qsql` through `@serfab/quereus-plugin-sereus`; record the first
      error and every subsequent one in the implement ticket.
- [ ] Enumerate the full defect list from that run — the six above are a floor.
- [ ] Decide `Attachment`'s key (add `Sequence`, or key on something real).
- [ ] Decide `Response`'s id types.
- [ ] Resolve `valid` vs `verify` and the `context.` qualification question against the crypto plugin.
- [ ] Keep or repair the `Message` sequence constraint; either way comment its concurrency limits.
- [ ] Add the two-line orientation headers to both schema files.
- [ ] Add a checked-in test that loads both schemas, so neither can rot again.
