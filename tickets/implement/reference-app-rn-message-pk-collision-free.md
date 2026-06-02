----
description: Replace the RN chat Message integer PK (max(Id)+1 local read) with a collision-free key for concurrent peers
prereq:
files: packages/reference-app-rn/src/chat-strand.ts, packages/reference-app-rn/src/chat-operations.ts, packages/reference-app-rn/src/use-chat.ts, schemas/chat-simple.qsql, packages/integration-tests/src/scenarios/websocket-chat.integration.ts, packages/integration-tests/src/scenarios/convergence-stress.integration.ts
----

## Problem

`insertMessage` computes the next message primary key as `max(Id)+1` read from
the **local** database (`packages/reference-app-rn/src/chat-operations.ts:89-90`):

```ts
const maxRow = await db.get('select max(Id) as MaxId from App.Message');
const nextId = ((maxRow?.MaxId as number | null) ?? 0) + 1;
```

`Message.Id` is declared as `integer primary key` in the embedded `CHAT_SCHEMA`
(`chat-strand.ts:20-26`) and the on-disk `schemas/chat-simple.qsql:10-15`. The
bug is currently masked only because strand convergence is broken (see
`reference-app-rn-discovered-strand-join`). Once two peers genuinely share a
strand and post concurrently, they independently compute the same `max(Id)+1`
and collide on the integer primary key.

## Design

Make the message primary key collision-free for concurrent peers. Use a
**text UUID** primary key — it is the simplest globally-unique option, the app
already depends on `uuid()` for strand IDs (`use-cadre.ts` / `createStrand`
caller), and it removes the local-read assumption entirely. (A composite
`(MemberId, seq)` key is the alternative, but it still requires a per-member
local-monotonic `seq` read and complicates ordering joins; prefer the UUID.)

Schema becomes:

```sql
table Message (
    Id text primary key,
    MemberId text not null,
    Content text not null,
    Timestamp datetime not null,
    foreign key (MemberId) references Member(Id)
);
```

`insertMessage` generates the UUID locally and inserts it directly — no
`max(Id)` read:

```ts
const id = uuid();
await db.exec(
  `insert into App.Message (Id, MemberId, Content, Timestamp) values (?, ?, ?, ?)`,
  [id, memberId, content, now],
);
```

### Ordering consequence

`queryMessages` currently orders by `M.Id asc` (`chat-operations.ts:123`),
relying on the integer PK being monotonic with insertion order. A UUID PK is
**not** chronologically sortable, so switch the ordering to
`order by M.Timestamp asc, M.Id asc` (Timestamp as the primary sort, Id as a
stable tiebreak). The `Timestamp` column is already populated with a
second-resolution `YYYY-MM-DD HH:MM:SS` string; second-level ties between
concurrent peers fall back to the deterministic Id tiebreak. This is acceptable
for the reference app; note the limitation in a code comment.

### Type changes

- `ChatMessage.Id` becomes `string` (`chat-operations.ts:15`).
- `insertMessage` returns the generated string `Id`.
- `use-chat.ts` optimistic-append path (`send`, line 126-128) already consumes
  the returned message object — no change beyond the `Id` type flowing through.

### Callers / tests to update

- `schemas/chat-simple.qsql` — change `Message.Id` to `text primary key`.
  Update the file header comment if it references the integer key.
- The integration tests insert literal `Id = 1` against the chat schema and
  must move to text IDs:
  - `packages/integration-tests/src/scenarios/websocket-chat.integration.ts:157-178`
    (`insert ... values (1, 'drone-1', ...)` and the `where Id = 1` assertions).
  - `packages/integration-tests/src/scenarios/convergence-stress.integration.ts`
    — grep for the chat `Message` inserts / `Id` assertions and switch to text
    IDs. Confirm whether `CHAT_SAPP_CONFIG` there embeds its own copy of the
    schema (it imports/embeds the chat schema) and update that copy too.

Search the repo for any other embedded copy of the chat `Message` DDL or
`App.Message` integer-Id assumptions before finishing (`grep -rn "App.Message"`
and `grep -rn "Message (" schemas packages`).

## References

- `packages/reference-app-rn/src/chat-operations.ts:80-104` — `insertMessage`.
- `packages/reference-app-rn/src/chat-strand.ts:14-27` — embedded `CHAT_SCHEMA`.
- `schemas/chat-simple.qsql` — on-disk schema.
- `packages/integration-tests/src/scenarios/websocket-chat.integration.ts:148-179`.

## TODO

- Change `Message.Id` to `text primary key` in `chat-strand.ts` `CHAT_SCHEMA`
  and `schemas/chat-simple.qsql`.
- Rewrite `insertMessage` to generate a UUID and drop the `max(Id)+1` read; add
  the `uuid` import (match the import style already used for strand IDs).
- Change `ChatMessage.Id` to `string`; thread the type through `use-chat.ts`.
- Change `queryMessages` ordering to `order by M.Timestamp asc, M.Id asc` with a
  comment on the second-resolution tiebreak limitation.
- Update the integration tests (`websocket-chat`, `convergence-stress`) to use
  text message IDs and update their `where Id =` assertions.
- Grep for any other embedded chat-schema copy / integer-Id assumption and fix.
- Build + typecheck the RN package and run the affected integration test(s);
  stream output with `tee`. Hand off honestly about anything not runnable in-agent.
