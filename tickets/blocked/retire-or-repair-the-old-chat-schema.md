----
description: We ship two chat schema files. The reference app uses the newer one; the older one is still there and contains mistakes that will mislead the next person who reads it first. Decide whether to delete it or fix it.
files: schemas/chat.qsql, schemas/chat-simple.qsql, packages/reference-app-rn/src/chat-strand.ts
----

# Decision (a): retire `schemas/chat.qsql`, or repair it?

**Category (a) — a decision only a human should make**, and a cheap one: it is a question of intent,
not of analysis. Raised as **gotchoices/sereus#7** by an outside consumer who hit it while using our
schemas as a reference and lost time to the detour.

## The situation

`schemas/chat.qsql` appears superseded by `schemas/chat-simple.qsql` — the latter is what
`packages/reference-app-rn` actually uses — but the older file is still shipped, and it contains
three defects that a reader taking it as authoritative would copy:

1. **A primary key over a column that does not exist** (`schemas/chat.qsql:92`): `Attachment`
   declares `primary key (MessageId, Sequence)` with no `Sequence` column anywhere in the table.
2. **`datetime` used for identifier columns**: `Response.OriginalId` and `Response.ResponseId` are
   both typed `datetime` while holding message ids.
3. **A strict integer sequence on `Message`** with an `Id = 0 or exists(Id - 1)` style constraint,
   which cannot hold under concurrent writers — presumably why `chat-simple.qsql` moved to
   client-generated UUIDs.

## The decision

**Is `chat.qsql` retired, or is it still intended as the richer reference?**

- **Retired.** Delete it, or leave a one-line header pointing at `chat-simple.qsql`. Cheapest, and it
  is what the reporter suggests would have saved them the detour. A pointer header is safer than
  deletion if anything outside this repo references the path.
- **Still intended.** Then the `Sequence` column and the `Response` id types need fixing, and defect 3
  needs a decision of its own, since a strict sequence is exactly what `chat-simple.qsql` abandoned —
  keeping it would mean the richer reference teaches a pattern the working reference rejected.

Recommended default: **retire with a pointer header.** The working reference is the one the app uses,
and a second schema that disagrees with it on primary-key strategy is a liability rather than a
richer example.

## Why this is a decision rather than a fix

Whether the file is superseded is a statement about intent that only its author can make. Repairing a
file we mean to delete is waste; deleting a file we mean to keep loses design work. Either action is
a few minutes once the intent is known.

## Reversibility

Fully reversible — it is a schema artifact in version control with no runtime consumer found. A
pointer header is the lowest-risk form of the retire option.
