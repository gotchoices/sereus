description: A public issue on our own tracker still points readers at a warning we have since corrected — it says a certain kind of concurrent write silently loses data, which is no longer true. Somebody with access needs to post the correction there.
files: docs/schema-guide.md
difficulty: easy
----

# Human action: post the correction to gotchoices/sereus#5

## Why this is a human's call, not an agent's

Posting to a public issue tracker writes under a person's account, in our project's name, to somebody who asked us a question and acted on the answer. An agent should not do that on its own. Everything needed is below; what is missing is a person to send it.

## What changed and why the issue is now wrong

Issue **gotchoices/sereus#5** asked whether an sApp can read its rows in commit order. Two completed tickets answered it in `docs/schema-guide.md` (`complete/1-document-commit-order-answer`, `complete/6-write-down-why-a-monotonic-int-sequence-is-unsafe`), and the reply posted on the issue pointed readers at that section.

Part of what that section said is no longer true. It warned that if two machines insert a row with the same primary key at the same moment, both are told they succeeded and one row is silently lost, and it called that a tracked, unresolved limitation. The underlying library fixed it; the fix was re-measured against two real machines on 2026-09-17 and holds, and a permanent two-machine regression test now guards it (`packages/integration-tests/src/scenarios/control-concurrent-same-pk-insert.integration.ts`). The loser of that race now gets the ordinary "unique constraint failed" error and nothing is lost.

The narrower gap the same section used to describe — a secondary `unique` column raced at the same instant by two different primary keys — is also fixed now, the same way and re-measured the same day (`packages/integration-tests/src/scenarios/control-concurrent-unique-column-race.integration.ts`, 6 of 6 rounds). One detail is worth passing on: a *concurrent* refusal, on the primary key or a secondary column, can arrive as a plain `Error` rather than the engine's `ConstraintError` type (a sequential one always comes back as `ConstraintError`), so code that classifies the error should match the `UNIQUE constraint failed: <Table>.<Column>` text rather than the error's type.

Anyone who read the issue and chose a design around "a duplicate key is silently last-writer-wins" made that choice on information we have since corrected — the hazard they were warned about is gone. That is the reason this is worth posting rather than leaving for whoever next reads the guide.

## Draft comment, for a human to review and post

> Following up on the concurrency warning this thread pointed at in `docs/schema-guide.md`.
>
> **The primary-key part of that warning is fixed and no longer applies.** It said that when two peers concurrently insert the same primary key, both are told they succeeded and one row is silently lost. That was true when it was written and is not true now: the storage layer refuses the loser with the ordinary `UNIQUE constraint failed: <Table>.<Column>` error, and nothing is lost. We re-measured it on two real machines on 2026-09-17 and added a permanent regression test so it cannot quietly come back.
>
> The practical consequence for a schema author: a `max(id) + 1` integer key is now *correct*, but it is *contended* — the refused writer has to catch the error, recompute against its new view and write again, and the refusals get more frequent the more peers post at once. A locally generated key (a UUID) still never contends and still needs no retry loop, so it remains the recommendation.
>
> **The narrower gap this thread also flagged — a secondary `unique` column raced at the same instant — is fixed too.** A column that is `unique` but is *not* the primary key now refuses a same-instant duplicate exactly like the primary key does: the losing writer is told its insert failed, and its row lands nowhere on either machine. One detail worth knowing if you write code against either race, primary key or secondary column: a *concurrent* refusal can come back as a plain `Error` rather than the engine's `ConstraintError` type (a *sequential* duplicate always comes back as `ConstraintError`), so match on the `UNIQUE constraint failed: <Table>.<Column>` text in the error's message rather than on its type.

## Before posting

Re-read the "Ordering Events (There Is No Commit-Order Column)" section of `docs/schema-guide.md` as it stands, so the comment and the guide agree.
