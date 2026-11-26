# Writing an app schema

This guide shows how to write the schema of an sApp in Quereus's declarative SQL, and which schema patterns work on a strand, where every member's nodes re-execute and store every write. It is for app developers who know SQL; it covers what Quereus and Sereus do differently from a single-server database.

See also: [concepts](concepts.md) for the terms, [app schema versions and upgrades](strands/app-schema.md), [durability and offline mode](strands/writes.md), and the [cadre-core API guide](api.md).

## What an app schema is

An app schema is a schema body: the `table`, `index`, `unique index`, `view`, `materialized view` and `assertion` items an app passes as `SAppConfig.schema` to cadre-core, or as the `schema` option of `@serfab/quereus-plugin-sereus`. Sereus wraps the body as `declare schema App { … }`, applies it on every node that runs the app, at every connect, and chooses the storage module (Optimystic) itself. `applyAppSchema` in `packages/quereus-plugin-sereus/src/app-schema.ts` is the one place that applies it.

What follows from that:

- **Items only.** Anything that is not one of the six items is refused when the schema is applied: `create table …`, a misspelled item keyword, a `seed` item (see [Seed items are refused](#seed-items-are-refused)). Quereus alone would skip an item it does not recognize, and the app would run without it.
- **The schema has a version.** Beside the body the app passes `schemaVersion`, a whole number of at least 1 that it raises with every change to the schema. A strand refuses an app whose number is below the highest a member has applied: see [App schema versions across a strand's members](strands/app-schema.md#app-schema-versions-across-a-strands-members).
- **Tables live in schema `App`.** App code qualifies them (`App.messages`), as `packages/reference-app-web/src/lib/chat-dml.ts` does. The query examples in this guide leave names unqualified for brevity.
- **The strand has tables of its own.** Sereus also applies schema `Strand` (`schemas/strand.qsql`), which holds the strand's membership. An app table may share a name with one of them: see [Same-named tables in Strand and App](strands/app-schema.md#same-named-tables-in-strand-and-app).
- **The sApp's identity is not in the schema text.** In cadre-core the author's public key and the release string are `SAppConfig.id` and `SAppConfig.version`, beside the schema.
- **The author signs the schema.** Under a node's default `requireSignedSchemas` policy, `SAppConfig.signature` is the author's signature over `schema`, `version` and `schemaVersion`, so a change to the schema text needs a new signature.

### Quereus rules that differ from other SQL engines

- Schema declarations are order-independent: an item may refer to one declared after it.
- A column is `not null` unless it is declared `null`.
- A table can declare mutation context variables with `with context (…)`. The writer supplies them with each statement, and the table's `default` and `check` expressions read them. See [Mutation context](#mutation-context).
- An `assertion … check (…)` item states an invariant across tables.
- A `check` that reads only its own row runs when the row is written. A `check` that reads other rows or an aggregate is deferred automatically and runs at commit.

### Declaring a schema in plain Quereus

Outside Sereus, a Quereus database declares a schema, inspects the migration the engine derives from it, and applies it:

```sql script
-- Optional: ensure standard SQL nullability semantics
pragma default_column_nullability = 'not_null';  -- or 'nullable'

-- Declare the desired end-state (diffable & order-independent)
declare schema main using (default_vtab_module = 'memory') {
  table users { id integer primary key, email text unique, name text }
  index users_email on users(email)
  view v_users as select id, email from users
  seed users ((1,'a@x','A'), (2,'b@x','B'))
}

-- Compute and inspect migration DDL
diff schema main;          -- returns rows { ddl: 'CREATE TABLE ...' }

-- Apply migrations (and optionally seed)
apply schema main;         -- executes DDL
apply schema main with seed;

-- Version/hash for tracking
explain schema main;       -- returns { info: 'hash:...' }
```

Inside Sereus an app writes only the items between the braces. Sereus runs the `declare` and the `apply`, and `seed` and `with seed` have no Sereus equivalent.

### Seed items are refused

In plain Quereus a `seed` item lists rows for one table, and `apply schema … with seed` inserts them idempotently (`on conflict do nothing`):

```sql script
declare schema main using (default_vtab_module = 'memory') {
  table roles (code text primary key, label text null);

  -- One seed item per table; each row lists every column in declaration order
  seed roles (('admin', 'Administrator'), ('member', 'Member'), ('guest', null));
}

apply schema main with seed;
```

Quereus also parses a `seed <table> values (<columns>) values (...)` form, but it ignores that column list and inserts each row positionally: a row that omits a column fails, and one that lists columns out of declaration order puts its values in the wrong columns. List every column instead.

Sereus refuses an sApp schema that contains a `seed` item. The schema is applied on every node of the strand at every connect, so seed inserts would add a network write to each connect, and two nodes inserting the same seed key at once would collide. An app that needs rows when the strand is created, such as a role list, inserts them itself from the node that founds the strand.

## Tables, keys and constraints

### A minimal schema

```sql schema
-- Identities scoped to the strand; emails optional to allow pseudonyms/handles
table users (
  id          text primary key,
  display     text,         -- Handle or display name (not globally unique)
  email       text null,    -- Optional; Quereus defaults to NOT NULL unless marked null
  created_at  text           -- Caller-supplied ISO 8601; there is no server clock to default to
                             -- (see "Ordering Events (There Is No Commit-Order Column)")
);

-- Simple messages; each row belongs to a conversation (strand-local grouping)
table conversations (
  id          text primary key,
  title       text,
  created_by  text references users(id),
  created_at  text
);

table messages (
  id             text primary key,
  conversation   text references conversations(id),
  sender_id      text references users(id),
  content        text,
  sent_at        text,
  -- Prevent empty content at insert-time only
  constraint nonempty_content check on insert (length(content) > 0)
);
```

`check on insert` limits a check to one operation; `check on update` and `check on delete` do the same for the other two.

### Foreign keys, composite keys and deferred checks

```sql schema
table customers (
  id           text primary key,
  name         text,
  credit_limit real
);

table products (
  id    text primary key,
  name  text,
  price real check (price >= 0)
);

table orders (
  id          text primary key,
  customer_id text references customers(id),
  created_at  text
);

table order_items (
  order_id   text,
  product_id text,
  qty        integer check on insert (qty > 0),
  price      real    check (price >= 0),
  constraint pk_order_items primary key (order_id, product_id),
  constraint fk_order   foreign key (order_id)   references orders(id),
  constraint fk_product foreign key (product_id) references products(id),

  -- Auto-deferred example: ensure order total ≤ customer limit at COMMIT
  -- (references external row and aggregate → validated at commit time)
  constraint within_limit check (
    (select coalesce(sum(qty * price), 0.0)
       from order_items oi
      where oi.order_id = new.order_id)
    <= (select credit_limit from customers c where c.id = (select o.customer_id from orders o where o.id = new.order_id))
  )
);
```

`within_limit` reads another table and an aggregate, so the engine defers it to commit. A transaction can therefore insert several items that pass only as a set.

### Immutable ids and delete guards

`new` and `old` name the row after and before the write. A check that compares them makes a column immutable, and `check on delete (false)` forbids deletes:

```sql schema
table things (
  id   text primary key,
  name text,
  constraint id_immutable check on update (new.id = old.id),
  constraint no_delete    check on delete (false)
);
```

### Generated columns and column checks

```sql schema
table articles (
  id       text primary key,
  title    text,
  body     text,
  slug     text generated always as (lower(replace(title, ' ', '-'))) stored,
  created  text,

  -- Simple email-like check for author contact
  author_email text null check (author_email like '%@%')
);
```

Built-in functions such as `isISODatetime` and `typeof` validate a value's format or type in a check:

```sql schema
table events (
  id     text primary key,
  at     text,    -- ISO8601 UTC timestamp
  suffix text,
  n      any null,
  constraint ts_valid    check (isISODatetime(at) and at like '%Z'),
  constraint n_is_int    check (n is null or typeof(n) = 'integer')
);
```

### Indexes

An index speeds a query; a `unique index` also refuses a duplicate value. What a refused duplicate looks like when two members write at once is under [A `unique` column refuses a duplicate the same way](#a-unique-column-refuses-a-duplicate-the-same-way).

```sql schema
table users ( id text primary key, handle text );

unique index idx_users_handle on users(handle);
```

### Views

A view is a named read model. Keep write logic out of views.

```sql schema
table users ( id text primary key, email text, display text );
table user_roles ( user_id text, role text );

view v_users_with_roles as
  select u.id, u.email, u.display,
         group_concat(ur.role, ',') as roles
    from users u left join user_roles ur on u.id = ur.user_id
   group by u.id, u.email, u.display;
```

A view over `values` gives a fixed code list without a table, so no node has to insert its rows:

```sql schema
view Status as
  select * from (values
    ('new','New'),
    ('ready','Ready'),
    ('done','Done')
  ) as Status(Code, Name);
```

### Assertions across tables

An assertion states an invariant that does not belong to a write of any one table. The engine checks it at commit.

```sql schema ledger
table ledger (
  id    integer primary key,
  kind  text check (kind in ('debit','credit')),
  amt   real check (amt >= 0)
);

-- Sum(credits) = Sum(debits)
assertion balanced_book check (
  (select coalesce(sum(case when kind='credit' then amt else 0 end),0) from ledger)
  =
  (select coalesce(sum(case when kind='debit'  then amt else 0 end),0) from ledger)
);
```

## Mutation context

Mutation context is a set of variables a table declares with `with context (…)`. The writer supplies a value for each with the statement (`insert … with context name = ?, … values (…)`), and the table's `default` and `check` expressions read them. The values travel in the statement, so they are part of the transaction that every validating node re-executes. An app uses this to enforce authorization, audit columns and signatures in the schema, with no central server.

A context value is whatever the writer supplied. A check that must hold against a dishonest member therefore has to verify something the writer cannot forge, such as a signature.

### Declaring and supplying context

```sql schema
table secured_objects (
  id   text primary key,
  data text,
  constraint signed_change check (
    verify(digest(Tid, id, data), context.signature, context.user_key, 'ed25519')
  )
) with context (
  user_key  text,   -- base64url ed25519 public key
  signature text,   -- base64url signature over the digest
  Tid       int
);
```

A table must declare every context variable it reads. An undeclared bare name in a `default` fails when the schema is applied. An undeclared `context.<name>` in a `check` applies cleanly and fails only on the first write.

`digest` and `verify` are registered on every strand. Signatures and keys are base64url text, as in `schemas/strand.qsql`.

### Roles and permissions

```sql schema
table roles (
  code text primary key,           -- 'admin', 'member', ...
  sort integer default 0
);

table user_roles (
  user_id  text,
  role     text references roles(code),
  constraint pk_user_roles primary key (user_id, role)
);

-- Application-provided context (names are up to you), declared by the table that reads it
-- and supplied with each write: `insert ... with context auth_token = ?, ...`
-- You can use custom functions: has_role(token, 'admin') → 1/0

table protected_records (
  id       text primary key,
  tenant   text,
  data     text,
  created  text,

  -- Multi-tenant isolation: write must match current_tenant
  constraint tenant_guard check (
    tenant = context.current_tenant_id
  ),

  -- Require a particular role to insert/update
  required_role text default 'member',
  constraint write_auth check (
    has_role(context.auth_token, required_role) = 1
  )
) with context (
  current_tenant_id text,
  auth_token        text
);
```

`has_role` is a function the app registers with Quereus; Sereus does not supply it. Register such a function as deterministic, or the engine rejects the `check` that calls it.

### Audit columns and signature checks

```sql schema
-- The application supplies the context variables with each write:
--   insert into documents (...) with context actor_name = ?, actor_key = ?, ... values (...)

table documents (
  id        text primary key,
  tenant    text,
  title     text,
  content   text,

  -- Audit defaults derived from context
  created_by text default actor_name,
  created_at text,
  op_sig     text default operation_signature,

  -- Multi-tenant write barrier
  constraint tenant_isolation check (tenant = context.current_tenant_id),

  -- Signature check with the crypto functions every strand registers (digest, verify);
  -- signatures and keys are base64url text, the same idiom schemas/strand.qsql uses
  constraint signature_valid check (
    verify(digest(id, title, content, created_by), op_sig, context.actor_key, 'ed25519')
  )
) with context (
  actor_name          text,
  actor_key           text,   -- the signer's ed25519 public key
  operation_signature text,
  current_tenant_id   text
);
```

## Ordering Events (There Is No Commit-Order Column)

A strand table has exactly the columns its schema declares. There is no auto-increment, no rowid, no commit-sequence column, and no function that returns one. A query without `order by` returns rows in whatever order the plan produced them: usually primary-key order, because the storage is a B-tree keyed on the primary key, but not when a secondary index serves the plan. With a UUID or other text `id`, primary-key order is not chronological anyway. Always write the `order by` you mean.

`StampId()`, the one transaction-related function, returns an identifier for the current transaction. It says which transaction wrote a row, never when that transaction ran relative to another.

### A timestamp comes from the writer

Quereus rejects non-deterministic functions (`random`, the current time) in constraints, defaults and generated columns, because nodes re-execute a transaction's statements to validate it and must reach the same answer. The rejection happens when the schema is applied: `created_at text default datetime('now')` fails at apply, not at the first write.

To use a clock value in a default or check, pass it as [mutation context](#mutation-context). The writer resolves the value and sends it with the statement, so it is part of the transaction and each validating node reads the same value:

```sql schema event-clock
table events (
  id         text primary key,
  body       text,
  created_at text default now_iso
) with context (
  now_iso text
);
```

```sql query event-clock
insert into events (id, body) with context now_iso = datetime('now') values ('e1', 'hi');
```

The timestamp is still what the writing client asserted about itself. Nothing in Sereus, Quereus or Optimystic checks it.

### The storage engine's commit order is not visible to SQL

Each table maps to one Optimystic collection. That collection's append-only log gives every committed transaction a revision number that every replica agrees on (Optimystic's `docs/correctness.md`, "Ordering Guarantees"). SQL cannot read that number.

The number would not replace the patterns in this section even if SQL could read it. It is commit order, not send order or causal order: two members posting at once are ordered by whichever commit was accepted first, not by which was written first on either device. It is also scoped to one table's collection, so it defines no order between rows of two tables.

An app that needs an order uses [Pattern A](#pattern-a-client-timestamp-with-a-deterministic-tiebreak) or [Pattern B](#pattern-b-record-what-the-author-had-already-seen).

### Pattern A: client timestamp with a deterministic tiebreak

The reference chat apps order by a timestamp column and break ties on the primary key. The row's author asserts the timestamp, so a wrong or dishonest clock reorders history and nothing detects it. That is acceptable for a cooperative app and not where back-dating matters. The query runs against the `Message` table declared under [Pattern B](#pattern-b-record-what-the-author-had-already-seen):

```sql query message-graph
select Id, Content, Timestamp
  from Message
 order by Timestamp asc, Id asc;
```

### Pattern B: record what the author had already seen

Instead of a timestamp, or beside one, each row names the other rows its author had seen when writing it. The rows then form a happened-before graph in the app's own schema. The graph gives no absolute time, but a row that claims to predate something its author had demonstrably already seen is detectable, and honest participants can bound a dishonest clock from both sides. Matrix (`prev_events`) and Secure Scuttlebutt (per-feed hash chains) use this shape.

```sql schema message-graph
table Message (
  Id        text primary key,
  Content   text not null,
  Timestamp datetime not null   -- still client-asserted; the edges below are what bound it
);

-- Edges: which prior messages this message's author had already seen
table MessageParent (
  MessageId text references Message(Id),
  ParentId  text references Message(Id),
  constraint pk_message_parent primary key (MessageId, ParentId)
);
```

### An integer sequence needs a retry loop

An integer primary key assigned as `max(id) + 1` loses nothing: when two members insert the same key at once, one commits and the other is refused with `UNIQUE constraint failed: <Table>.<Column>`. But the refused writer has to recompute `max(id) + 1` against its new view and write again, and the more members post at once, the more often that happens, because each computed the same next id from the same local maximum. A "no gaps" variant (`id = 0 or exists(id - 1)`) has the same contention.

Patterns A and B key their rows on a value each member mints for itself (a UUID), which no other member can collide with, so they need no retry loop. Use that unless a gapless integer sequence is itself a requirement. If it is, the app writes the retry, with a randomized backoff: every refused member recomputes the same next id from the same view, so retries that fire at once collide again.

### A `unique` column refuses a duplicate the same way

A secondary `unique` column (a username, an email address, a claimed handle) is as safe a guard against a duplicate as the primary key, including when two members insert different rows with the same value at the same instant. Optimystic reserves a table row and each of its index entries together before it makes any of them final, so the unique index refuses the losing writer before its table row is stored. The loser's insert fails and its row lands on no machine.

Either refusal, primary key or `unique` column, reaches the writer as Quereus's `ConstraintError` with the message `UNIQUE constraint failed: <Table>.<Column>`, whether the first write committed earlier or at the same instant. With offline mode on, the refusal arrives after the commit call has returned, as the queued transaction's failure: see [Offline mode](strands/writes.md#offline-mode).

## Client-Generated Keys and Retrying a Write

The ordering patterns mint the primary key on the client. One rule follows from that: mint the key once per logical event, and keep it across every attempt to store that event. A key minted inside the insert call makes the insert unrepeatable, and any retry then stores a second row.

### A write can fail without settling whether it landed

Optimystic can raise a `TornActionError` that is not marked `final` (part of the write may be stored), a `SyncRetryExhaustedError`, or a partial-commit error. A commit can also be accepted while the response to the writer is lost.

cadre-core refuses to re-run its own control writes after such an error (`reportsPossiblyStoredWrite` in `packages/cadre-core/src/control-write-retry.ts`), because a re-run could store the write twice. Strand writes have no such protection. `StrandDatabase.getDatabase()` returns a plain Quereus `Database`, and the app calls `exec` on it directly. Whatever repeats the write, usually a person pressing Send again, has to carry the protection.

### Retrying with a stable key

Two attempts at one event carry one primary key, so the primary key refuses the duplicate however many attempts are made and however late a torn write lands. A retry does two more things:

- **Read before writing again.** `select <Key> from <Table> where <Key> = ?` tells "the earlier attempt never landed" from "it landed and its outcome never came back". Row present: report success and write nothing. Row absent: insert. Only the retry path pays for the lookup.
- **Do not use `insert or ignore` instead.** It works against strand tables, but Quereus applies `ignore` to every constraint on the row, as SQLite does: a `not null`, `check` or foreign-key violation also skips the row silently. A message whose author row is missing would vanish instead of failing.

The read is a convenience, not the guard. An equality on every primary-key column is served as one tree descent, and whether that descent can come back empty for a row that exists on a networked strand is an open question (ticket `debt-composite-pk-point-lookup-unreliable-untracked`). A stable key makes a wrong "absent" harmless: the insert that follows is refused by the primary key, so the writer gets an error and never a second row.

A write the app repeats automatically is best keyed on a value it derives, such as a peer id or an invitation key, so that every pass presents the same key without having to remember one.

### The key belongs to the event, not the attempt

If the user edits the text after a failed attempt, that is a different event and needs a new key. Reusing the old key would report the edit as stored while the stored row held the earlier text.

For the same reason the app keeps the key only while the event is still the one being composed. It drops the key when an attempt resolves (stored, or found already stored), when the composer no longer holds the text the key was minted for, or when a read of the table shows the key's row. It must not drop the key on a read while an attempt is in flight: if that attempt then failed, the retry would have no key to present and would mint a second one.

The three reference chat apps implement this rule; the web app's version is `newChatMessageId` and `insertChatMessage` in `packages/reference-app-web/src/lib/chat-dml.ts`. [When the composer releases a message id](platforms/reference-apps.md#when-the-composer-releases-a-message-id) describes each app's composer and names its code.

## Party-private app state

An sApp often needs state that belongs to one party alone and should follow that party across its own devices: a read position, a draft, a display preference. Sereus has no store that is private to one party and replicated across that party's devices. The guidance is to keep such a value in the strand database, in a table keyed by the owning party (one row per member id, for example).

What that arrangement does and does not give:

- **Every member can read it.** The strand database is visible to every member of the strand, whatever key a row is stored under. A per-party key partitions the data by owner and hides it from nobody. Do not store anything there whose disclosure to another member of the strand would matter.
- **The key does not restrict writes.** Nothing about a per-party key stops another member writing that row. If only the owner may change its value, the schema has to say so with a check over the writer's identity: see [Roles and permissions](#roles-and-permissions) and [Audit columns and signature checks](#audit-columns-and-signature-checks).
- **Device-local storage is not an alternative.** The app's own local storage and cadre-core's node-local records (`packages/cadre-core/src/node-local-snapshot.ts`) are never replicated, so state kept there does not reach the party's second device, which is usually the reason the state is wanted.
- **No migration is defined.** If Sereus adds a private store, an app that used strand tables moves its data itself.

## Queries

The query examples name tables unqualified. App code writes `App.<table>`.

### Common table expressions

The examples read this table:

```sql schema org
table employees (
  employee_id text primary key,
  manager_id  text null references employees(employee_id),
  last_seen   text
);
```

```sql query org
-- Non-recursive CTE used as a staging read model
with recently_active as (
  select employee_id from employees where last_seen > datetime('now','-7 days')
)
select * from recently_active;

-- Recursive CTE for hierarchy (e.g., reporting chain)
with recursive reporting_chain as (
  select employee_id, manager_id, 1 as level
    from employees where employee_id = :who
  union all
  select e.employee_id, e.manager_id, rc.level + 1
    from employees e join reporting_chain rc on e.manager_id = rc.employee_id
)
option (maxrecursion 1000)
select * from reporting_chain;

-- Materialization hints (parsed; future optimization): employees who manage someone
with
  managers as materialized (select distinct manager_id from employees where manager_id is not null),
  staff as not materialized (select employee_id, last_seen from employees)
select s.employee_id, s.last_seen
  from staff s join managers m on m.manager_id = s.employee_id;
```

### Set operations

Against the schema of [A complete example](#a-complete-example). `diff` is a Quereus extension:

```sql query chat
-- union: users who started a conversation or posted a message
select created_by from conversations
union
select sender_id from messages;

-- intersect: users who have posted
select id from users
intersect
select sender_id from messages;

-- except: users who have never posted
select id from users
except
select sender_id from messages;

-- Quereus extension: diff (symmetric difference) — users who started a conversation
-- or posted, but not both
select created_by from conversations
diff
select sender_id from messages;
```

### RETURNING with NEW and OLD

In `returning`, `NEW` is the row an insert or update wrote, and `OLD` is the row an update or delete replaced or removed. Against the schema of [A complete example](#a-complete-example):

```sql query chat
-- Insert returning generated values (slug is a generated column)
insert into messages (id, conversation, sender_id, body, sent_at)
values ('m1', 'c1', 'u1', 'Hello!', '2026-01-01T00:00:00Z')
returning id, NEW.slug as slug, NEW.sent_at as at;

-- Update returning both OLD and NEW
update messages
   set body = 'Edited text'
 where id = 'm1'
returning OLD.body as was, NEW.body as now, NEW.sent_at;

-- Delete returning OLD values
delete from messages where id = 'm1'
returning OLD.id, OLD.body;
```

### Table-valued functions and JSON

Against the schema of [A complete example](#a-complete-example):

```sql query chat
-- Explode a JSON array column into rows (e.g., message tags)
select m.id, t.value as tag
  from messages m
  cross join lateral json_each(m.tags) as t
 where m.id = 'm42';

-- A table-valued function fed by a parameter: every integer anywhere in a JSON document
select key, value
  from json_tree(:payload)
 where type = 'integer';
```

A table-valued function sees a preceding table's columns only through `cross join lateral`. A comma join (`from messages m, json_each(m.tags)`) fails with "m.tags isn't a column".

### Window functions and a running digest

Against the `ledger` table of [Assertions across tables](#assertions-across-tables):

```sql query ledger
-- Running balance in entry order: credits add, debits subtract
select id,
       kind,
       amt,
       sum(case when kind = 'credit' then amt else -amt end)
         over (order by id rows between unbounded preceding and current row) as running_balance
  from ledger;

-- Cumulative digest over ordered entries (pattern used in VoteTorrent): each step
-- hashes the previous digest together with the next entry
with recursive
  entries as (select row_number() over (order by id) as n, id, kind, amt from ledger),
  chain(n, cumulative_digest) as (
    select n, digest(id, kind, amt) from entries where n = 1
    union all
    select e.n, digest(c.cumulative_digest, e.id, e.kind, e.amt)
      from chain c join entries e on e.n = c.n + 1
  )
select n, cumulative_digest from chain;
```

`group_concat` is not available as a window function and there is no digest window aggregate, so a running digest is a recursive CTE, not an `over (…)` clause.

## A complete example

A messaging schema that uses foreign keys, a composite primary key, immediate and deferred checks, a generated column, an index, a view, mutation context and an assertion together:

```sql schema chat
-- Users & roles
table users (
  id         text primary key,
  handle     text,
  display    text,
  joined_at  text
);
unique index idx_users_handle on users(handle);

table roles (
  code text primary key
);
-- The app inserts the 'admin' and 'member' rows when it founds the strand

table user_roles (
  user_id text,
  role    text references roles(code),
  constraint pk_user_roles primary key (user_id, role)
);

-- Conversations & membership
table conversations (
  id          text primary key,
  tenant      text null, -- optional org/workspace isolation
  title       text,
  created_by  text references users(id),
  created_at  text,
  constraint tenant_write_guard check (
    tenant is null or tenant = context.current_tenant_id
  )
) with context (
  current_tenant_id text null
);

table conversation_members (
  conversation_id text references conversations(id),
  user_id         text references users(id),
  role            text default 'member' references roles(code),
  constraint pk_conv_members primary key (conversation_id, user_id)
);

-- Messages with generated slug, immediate & auto-deferred checks
table messages (
  id             text primary key,
  conversation   text references conversations(id),
  sender_id      text references users(id),
  body           text,
  slug           text generated always as (lower(replace(substr(body, 1, 40), ' ', '-'))) stored,
  sent_at        text,
  tags           text null,  -- JSON array of tag strings, e.g. '["urgent","todo"]'

  -- Per-row immediate check: body required on insert
  constraint nonempty_body check on insert (length(body) > 0),

  -- Membership guard: sender must be a member (auto-deferred; cross-table)
  constraint sender_is_member check (
    exists (
      select 1 from conversation_members m
       where m.conversation_id = new.conversation
         and m.user_id = new.sender_id
    )
  )
);

-- View: who’s in each conversation with role list
view v_conversation_roster as
  select c.id as conversation_id,
         c.title,
         group_concat(u.handle, ',') as members
    from conversations c
    join conversation_members m on m.conversation_id = c.id
    join users u on u.id = m.user_id
   group by c.id, c.title;

-- Global assertion: each conversation must have at least one admin member
assertion conversation_has_admin check (
  not exists (
    select 1
      from conversations c
     where not exists (
             select 1
               from conversation_members m
              where m.conversation_id = c.id and m.role = 'admin'
           )
  )
);
```

## How the examples are checked

`packages/quereus-plugin-sereus/test/schema-guide-examples.spec.ts` executes the SQL in this guide. Every code block carries one marker in its fence's info string, and a block with any other info string fails the spec:

- `sql schema` or `sql schema <name>`: an sApp schema body. The spec applies it, then plans an insert, an update and a delete against every table and a select against every view. The name lets query blocks refer to it, and must be unique in the guide.
- `sql query <name>`: the spec plans every statement, without running it, against the `sql schema <name>` block, with `App` as the only schema on the search path.
- `sql script`: a complete statement sequence, run as written.
- `sql fragment`: shown for reading only (a lone constraint line that is not a statement). Never run.

Planning proves that a check or query compiles, not that it succeeds when run.

## Limits and accepted tradeoffs

- **Commit order is not readable from SQL.** Optimystic keeps a per-table commit order, and no column or function exposes it, so an app orders rows by a value its writers assert (ticket `expose-commit-order-to-sql-decision`).
- **Timestamps and other context values are unverified.** A value passed as mutation context is the writer's claim. Only a check the schema itself makes, such as a signature check, constrains it.
- **Strand writes are not protected against a repeated attempt.** The app must hold a stable key across retries, as described under [Client-Generated Keys and Retrying a Write](#client-generated-keys-and-retrying-a-write).
- **There is no party-private replicated store.** Per-party state kept in strand tables is readable by every member (ticket `feat-party-private-app-state`).
- **Seed rows are not applied to a strand.** The founding app inserts the rows a strand needs at creation.
- **`blobref` columns are not supported yet.** Optimystic's plugin accepts a `blobref` column, which references a large value stored outside the row, and every Sereus node now keeps those values on disk — but an app has no supported way to put the bytes or read them back, and a phone holds its strand's blobs eagerly rather than only what it put or read (ticket `feat-strand-blobs-persist`). Keep large values out of strand tables until then.
