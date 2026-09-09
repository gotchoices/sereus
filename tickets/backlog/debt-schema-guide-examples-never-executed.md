description: The schema guide teaches people how to write a database schema entirely through copy-pasteable examples, but nothing ever runs those examples, and several of them are rejected by the engine as written.
files: docs/schema-guide.md, packages/quereus-plugin-sereus/src/compose-strand.ts, schemas/chat-simple.qsql
tradeoffs: The guide is prose-first and deliberately compact, so a checker that demands every snippet be executable may push the examples toward completeness over readability — and some snippets are fragments on purpose (a lone constraint, a bare select) that a naive extractor would flag as broken.
----

# The schema guide's examples are never executed

## What is wrong

`docs/schema-guide.md` is the file a schema author actually opens, and it teaches almost
entirely by example — roughly twenty fenced SQL blocks. Nothing in the repository ever runs
them. They have drifted from what the engine accepts, and a reader has no way to tell which
lines work.

Two concrete classes were found while reviewing an unrelated documentation change:

**Non-deterministic defaults.** Ten table declarations used `default datetime('now')`. Quereus
rejects a non-deterministic expression in a `DEFAULT` at `CREATE TABLE` time (the behaviour is
asserted in the engine's own suite at
`../quereus/packages/quereus/test/logic/44-determinism-validation.sqllogic:19`, and the same
gate covers `CHECK` and generated columns). Every one of those declarations would have failed
when applied. Fixed in place by the `document-commit-order-answer` review pass; the class is
what this ticket is about.

**Context variables used without being declared.** A table may only reference a mutation-context
variable — bare (`default actor_name`) or qualified (`check (tenant = context.current_tenant_id)`)
— if the table declares it in a `with context ( ... )` clause. The guide's own tail section
("Explicit table context declaration") shows the clause correctly, but three earlier examples
use context variables without it and would be rejected:

- the `protected_records` table in the "Roles & Permissions" section,
- the `documents` table in the audit/signature section (`default actor_name`,
  `default operation_signature`),
- the `conversations` table in the "Putting It All Together" section.

These are **not** fixed — fixing them one at a time is the symptom, not the cause.

## Why a checker, not a round of edits

The examples were correct-looking at some point and rotted silently because the only thing
holding them to reality is a human re-reading them. The same rot will recur the moment the
engine's accepted syntax moves again. What is wanted is the property "every schema example in
the guide is accepted by the engine", enforced automatically, so the guide cannot drift without
something failing.

## Expected behaviour

A test extracts the schema-shaped SQL blocks from `docs/schema-guide.md` and applies each one
against an in-memory Quereus database. A block the engine rejects fails the test, naming the
block by its heading so the author knows which example to fix.

Design questions the implementer will have to settle (deliberately not decided here):

- **Which blocks are schema blocks.** Some fences are complete `schema { ... }` declarations,
  some are bare `table ...` fragments, some are lone constraint lines or plain `select`
  statements meant to be read, not run. The extractor needs an unambiguous rule — an explicit
  marker on the fence is likely cleaner than inferring from content.
- **Application-provided functions.** Several examples call user-defined functions the guide
  says the app supplies (`has_role`, `verify_signature`, `SignatureValid`, `Digest`). The
  harness needs stub registrations, or those blocks need to be marked as not-executable.
- **Where the test lives.** The guide describes Quereus behaviour reached through the Sereus
  plugin; a plain in-memory Quereus database is probably enough and avoids pulling a strand
  runtime into a docs test.

## Out of scope

Auditing the rest of `docs/` the same way. The schema guide is the one doc whose whole value is
that its examples are copy-pasteable; other docs are prose about design and are not claiming to
compile.
