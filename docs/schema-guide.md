## Sereus Schema Guide (for Quereus)

Purpose: A compact, example-driven reference so a human or AI agent can define a full Sereus strand schema using Quereus’ declarative SQL. Assumes familiarity with SQL; focuses on Quereus- and Sereus-specific patterns.

What the examples are: each `sql schema` example below is an sApp schema *body* — the bare `table`, `index`, `view` and `assertion` items an app passes as the plugin's `schema` option. Anything else — `create table …`, a misspelled item keyword — is refused when the schema is applied (Quereus alone would silently skip it), and so is a `seed` item (see [Seeds](#seeds-local-quereus-databases-only)). Sereus wraps the body as `declare schema App { … }`, applies it, and chooses the storage module (Optimystic) itself. The sApp's name and version are the plugin's `sapp_id` and `sapp_version` settings, not part of the schema text. Because Sereus puts the app's tables in schema `App`, app code qualifies them (`App.messages`), as the reference apps do (`packages/reference-app-web/src/lib/chat-dml.ts`); the query examples below leave them unqualified for brevity. `packages/quereus-plugin-sereus/test/schema-guide-examples.spec.ts` executes the examples; every code block carries one marker for it:
- `sql schema` or `sql schema <name>` — an sApp schema body. Applied, then an insert, update and delete are planned against every table and a select against every view. The name lets query examples refer to it.
- `sql query <name>` — every statement is planned, not run, against the `sql schema <name>` block; tables are named unqualified.
- `sql script` — a complete statement sequence, run as-is.
- `sql fragment` — shown for reading only (a lone constraint line that is not a statement on its own). Never run.

Key Quereus characteristics:
- Declarative, order-independent schema blocks (`declare schema <name> { ... }`).
- Columns are NOT NULL by default (unless explicitly `null`).
- Table-level mutation context variables, declared with `with context (...)`, available in `default` and `check`.
- Global assertions (an `assertion ... check (...)` item).
- Auto-deferred row-level CHECKs when needed; immediate for simple per-row checks.

Declarative workflow (engine-driven migration):

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

That is raw Quereus. Inside Sereus you write only the items between the braces; see "What the examples are" above. `seed` items and `with seed` have no Sereus equivalent; see [Seeds](#seeds-local-quereus-databases-only).

Conventions used below:
- "Strand" = the database shared by consenting participants.
- "Cadre" = a user's personal device cluster that manages/stores data on their behalf.
- "Cohort" = all nodes belonging to a strand (the combined cadres of all strand members).
- Role/rights are modeled at the schema layer using context variables + checks.

---

### Minimal Strand Schema Skeleton

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

---

### Roles & Permissions (Schema-Enforced via Context)

Quereus supports table-level mutation context (e.g., `actor_id`, `auth_token`) for use in defaults and checks. This enables application-enforced RBAC without a central auth server.

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

Notes:
- Use your own user-defined functions (UDFs) such as `has_role(token, role)` to integrate signatures/claims. Register them as deterministic, or the CHECK that calls them is rejected.
- A table must declare every context variable it reads in `with context (...)`. Undeclared, a bare name in a `default` fails when the schema is applied, but a `context.<name>` in a `check` applies cleanly and fails only on the first write.
- The same pattern works for audit trails (see below) and cryptographic checks.

---

### Integrity: Foreign Keys, Composite Keys, Immediate vs Auto-Deferred Checks

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

Id immutability / delete guards:

```sql fragment
constraint id_immutable check on update (new.id = old.id);
constraint no_delete    check on delete (false);
```

---

### Generated Columns, Defaults, and Domain-Like Checks

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

---

### Views for Read Models / Projections

```sql schema
table users ( id text primary key, email text, display text );
table user_roles ( user_id text, role text );

view v_users_with_roles as
  select u.id, u.email, u.display,
         group_concat(ur.role, ',') as roles
    from users u left join user_roles ur on u.id = ur.user_id
   group by u.id, u.email, u.display;
```

---

### Indexes (Performance & Uniqueness)

```sql schema
table users ( id text primary key, handle text );

unique index idx_users_handle on users(handle);
```

---

### Ordering Events (There Is No Commit-Order Column)

A strand table gives you exactly the columns you declared, nothing more. There is no
auto-increment, no rowid, no commit-sequence column, and no function that returns one. A query
without `order by` returns rows in whatever order the plan produced them — usually primary-key
order, since the storage is a B-tree keyed on the primary key, but a plan served by a secondary
index will not — and with a UUID or text `id` primary-key order is arbitrary anyway, not
chronological. Always write the `order by` you mean. The one transaction-related function the
engine offers, `StampId()`, returns an identifier for the *current* transaction (peer-id hash +
random bytes); it tells you *which* transaction wrote a row, never *when* relative to another.

You also cannot fake a server-assigned timestamp. Quereus rejects non-deterministic functions
(`RANDOM`, current-time) in constraints, defaults and computed columns at schema definition
time, because peers re-execute a transaction's statements to validate it and must reach the
same answer. That rejection is a `CREATE TABLE`-time error, not a runtime surprise: writing
`created_at text default datetime('now')` fails when the schema is applied.

The sanctioned way to get a clock value into a default or check is **mutation context** — the
writer resolves the value and passes it with the statement, so it becomes part of the signed,
replayable transaction rather than something each validator re-evaluates (see "Explicit table
context declaration" below):

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

That moves *where* the timestamp comes from, not *how much it is worth*: any timestamp on a row
is still whatever the writing client asserted about itself — nothing in the stack checks it.

Underneath, the storage engine *does* keep a true commit order: each table maps to one
Optimystic collection, and that collection's append-only log assigns every committed
transaction a revision number — 1, 2, 3, ... — agreed by every replica
(`../optimystic/docs/correctness.md` §6.3, "Ordering Guarantees"). It is real, and it is not
currently reachable from SQL. Two caveats if you go looking for it anyway: it is commit order,
not send order or causal order — two peers posting concurrently are ordered by whichever commit
the cohort accepted first, not by which was written first on either device — and it is scoped
to one table's collection, so there is no defined order between rows in two different tables.

Until (if ever) that changes, pick one of two patterns:

**Pattern A — client timestamp with a deterministic tiebreak.** What the reference chat apps
do. Simple, and its weakness is worth saying plainly: the timestamp is asserted by the row's
author, so a wrong or dishonest clock silently reorders history and nothing in the stack
notices. Fine for a cooperative app; not fine when back-dating matters.

```sql query message-graph
select Id, Content, Timestamp
  from Message
 order by Timestamp asc, Id asc;
```

**Pattern B — record what the author had already seen.** Instead of (or alongside) a
timestamp, have each row name the other rows its author had seen when writing it. That builds a
happened-before graph in your own schema — it does not give you absolute time, but an insertion
claiming to predate something its author had demonstrably already seen becomes detectable, and
honest participants can bound a dishonest clock from both sides. This is the shape Matrix uses
(`prev_events`) and Secure Scuttlebutt uses (per-feed hash chains). A minimal sketch:

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

**Not a third pattern: a self-imposed integer sequence is a poor fit here.** The obvious idea — an
integer primary key assigned as `max(id) + 1` — is safe in the sense that matters: when two peers
concurrently insert the same primary key, exactly one commits and the other is refused with the
ordinary `UNIQUE constraint failed: <Table>.<Column>` error. Nothing is silently lost. But the
refused writer has to notice the error, recompute `max(id) + 1` against its new view, and write
again — and the more peers post at once, the more often that happens, because every one of them
computed the same next id from the same local maximum. A stricter "no gaps" variant
(`id = 0 or exists(id - 1)`) inherits the same contention. The sketches under Patterns A and B
key their rows on a value each peer mints for itself (a UUID), which no other peer can collide
with, so they need no retry loop at all. Use that unless a gapless integer sequence is itself a
requirement. If it is, the retry is yours to write, and it needs a randomized backoff: every
refused peer recomputes the same next id from the same view, so retries that fire immediately
collide with each other again.

**A secondary `unique` column is the same safe guard as the primary key, including at the same
instant.** For a secondary `unique` column raced by two rows with different primary keys at the
same instant, the losing writer is correctly told its insert failed and its row lands nowhere on
either machine — a table row and each of its indexes are reserved together before any of them is
made final, so the unique index can refuse the loser before its table row is ever stored. So a
secondary `unique` column (a username, an email address, a claimed handle) is a safe thing to
stand between two members and a duplicate, the same as the primary key. The permanent guard is
`packages/integration-tests/src/scenarios/control-concurrent-unique-column-race.integration.ts`.

One thing to watch when handling either refusal, primary key or secondary `unique` column: a
*concurrent* duplicate can arrive as a plain `Error` rather than the engine's `ConstraintError`
type, while a *sequential* duplicate (the same value inserted after the first has already
committed) always comes back as a `ConstraintError`
(`../optimystic/tickets/backlog/bug-concurrent-unique-refusal-is-not-a-constraint-error.md`). Both
shapes carry the same `UNIQUE constraint failed: <Table>.<Column>` text, in the error's own message
or in the message of an error on its `cause` chain, so match on that text rather than on the
error's type. This applies to the `max(id) + 1` retry above as much as to a secondary column.

---

### Client-Generated Keys and Retrying a Write

The patterns above mint the primary key on the client. That is the right shape, and it carries one
corollary worth stating on its own: **mint the key once per logical event, and hold it across
every attempt to store that event.** A key minted inside the insert call makes the insert
unrepeatable, and an unrepeatable insert turns any retry into a second row.

The reason is that a write can fail without settling whether it landed. Optimystic can raise a
`TornActionError` that is not marked `final` (some of the write may be stored), a
`SyncRetryExhaustedError`, or a partial-commit error; a commit can also be accepted while the
response back to the writer is lost. Cadre names exactly this class in
`packages/cadre-core/src/control-write-retry.ts` → `reportsPossiblyStoredWrite`, and its only job
is to refuse to re-run such a write, "because a re-run could store the write twice". Control
writes get that protection automatically, from the funnel every one of them passes through.
**Strand writes do not** — `StrandDatabase.getDatabase()` hands your app a raw Quereus `Database`
and your app calls `exec` on it, with no retry funnel in between. Whatever repeats the write —
usually a person pressing Send again — is where the protection has to live.

With a stable key, it lives in the key itself: two attempts at one event carry one primary key, so
the primary key refuses the duplicate no matter how many attempts are made or how late a torn
write lands. A retry then has two things to do beyond re-presenting the key:

- **Read before re-writing.** `select <Key> from <Table> where <Key> = ?` distinguishes "the
  earlier attempt never landed" from "it landed but its outcome never came back". Row present:
  report success and write nothing. Row absent: insert normally. It is one key lookup, and only
  the retry path pays for it. An equality on every primary-key column is served as a single tree
  descent with no filter added by the SQL engine, and whether that descent can come back empty for
  a row that exists on a networked strand is an open question
  (`tickets/backlog/debt-composite-pk-point-lookup-unreliable-untracked.md`) — which is survivable
  here precisely because the key is stable: a lookup that wrongly reports "absent" leads to an
  insert the primary key then refuses, so the writer gets an error to report and never a second
  row. Do not invert that and treat the read as the thing keeping the row unique.
- **Do not reach for `insert or ignore` instead.** It is shorter and it does work against strand
  tables, but Quereus applies `IGNORE` to *every* constraint on the row, matching SQLite — a NOT
  NULL, CHECK or foreign-key violation also silently skips the row. A message whose author row is
  missing would vanish without a word rather than failing loudly.

The key must belong to the event the user composed, not to the attempt: if the user edits the
text after a failed attempt, that is a different event and it needs a new key. Reusing the old one
would report the edit as stored while the stored row still held the pre-edit text. The three
reference chat apps implement exactly this — see `insertChatMessage` /
`newChatMessageId` in `packages/reference-app-web/src/lib/chat-dml.ts` and the composer rule in
`packages/reference-app-rn/src/chat-send.ts`, `packages/reference-app-ns/src/chat-vm.ts`
(`ChatViewModel.send`) and `packages/reference-app-web/src/lib/messages.svelte.ts` (`sendMessage`).

The other half of the rule: hold the key exactly as long as the event is still the one being
composed. A key released only when an attempt resolves outlives its draft — a user who sees a
"not confirmed" message arrive anyway and clears the box would have the *same* text, typed again
later, taken for a retry, found stored, and silently dropped. So the reference apps release the key
at the first of:

- **an attempt resolving**, stored or found already stored;
- **the composer no longer holding the text the key was minted for** (on web, the author and the
  text) — clearing and retyping the same words, or editing away and back, is a new event with a
  new key;
- **a read of the table showing the key's row**, which means an attempt that reported failure did
  land. The apps then also drop the "not confirmed" notice, and clear the box if it still holds
  that text.

The read must never release the key while an attempt is in flight: if that attempt then failed,
the user would be told to retry with no key left to re-present, and the retry would mint a new
one — the duplicate this section exists to prevent. The next read after the attempt settles
releases it instead. React Native keeps the rule in `ChatSender` (`composerChanged`, `settle`,
`packages/reference-app-rn/src/chat-send.ts`); NativeScript in `ChatViewModel`'s `draft` setter
and `settlePendingDraft`; web in `composerChanged` and `settlePendingDraft` in
`messages.svelte.ts`.

This is also why the writes cadre-core itself re-runs are safe: they key their rows on values they
derive rather than mint — the membership reconciler's `MemberPeer` binding is keyed on the node's
own peer id and its `ConsumedInvite` row on the invitation key
(`packages/cadre-core/src/strand-membership-reconciler.ts`) — so a second pass re-presents the
same key and the second write is refused rather than duplicated.

---

### Common Table Expressions (CTE), Recursive, and Hints

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

Set operations (against the "Putting It All Together" schema below):

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

---

### Global Assertions (Cross-Table Invariants)

Use assertions for invariants that aren’t naturally bound to a single table mutation.

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

---

### Audit & Security with Mutation Context (Signatures, Tenants, Actor Info)

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

---

### Seeds (Local Quereus Databases Only)

```sql script
declare schema main using (default_vtab_module = 'memory') {
  table roles (code text primary key, label text null);

  -- One seed item per table; each row lists every column in declaration order
  seed roles (('admin', 'Administrator'), ('member', 'Member'), ('guest', null));
}

apply schema main with seed;
```

Quereus also parses a `seed <table> values (<columns>) values (...)` form, but it ignores that column list and inserts each row positionally: a row that omits a column fails, and one that lists columns out of declaration order lands its values in the wrong columns. List every column instead.

Quereus inserts seed rows only when a schema is applied `with seed`, idempotently (`on conflict do nothing`). **Sereus refuses an sApp schema containing a `seed` item** (`applyAppSchema` in `packages/quereus-plugin-sereus/src/compose-strand.ts`): the schema is applied on every node of the strand at every connect, and two nodes inserting the same seed key at once would collide (see [Ordering Events](#ordering-events-there-is-no-commit-order-column)). An app that needs rows at birth inserts them itself from the node that founds the strand.

---

### RETURNING with NEW/OLD (DML Feedback)

Against the "Putting It All Together" schema below:

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

Rules recap:
- INSERT: `NEW` references inserted values.
- UPDATE: `NEW` is updated row; `OLD` is previous row.
- DELETE: `OLD` references deleted row.

---

### Table-Valued Functions & JSON Helpers

Against the "Putting It All Together" schema below:

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

A table-valued function sees a preceding table's columns only through `cross join lateral`; a comma join (`from messages m, json_each(m.tags)`) fails with "m.tags isn't a column".

---

### Putting It All Together: A Compact sApp Schema

This example demonstrates a realistic consent-based messaging app schema using all key features: FK, composite PK, checks (immediate + auto-deferred), generated columns, indexes, views, mutation context, and assertions.

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

---

### Practical Guidance & Patterns
- Prefer declarative schema items (the body Sereus wraps in `declare schema App { ... }`); they’re order-independent and diffable.
- Model authorization at the data layer using context variables + checks; keep business rules close to data.
- Use global assertions for invariants spanning multiple tables.
- Expect some checks to be validated at COMMIT (auto-deferred) when referencing external rows/aggregates.
- Keep views as read models; avoid complex write logic in views.
- Rows a strand needs at birth, such as a role list, are inserted by the app when it founds the strand, because Sereus refuses `seed` items (see [Seeds](#seeds-local-quereus-databases-only)).
- Index for uniqueness and query speed; prefer named composite PKs where natural.
- Mint a client-generated primary key once per logical event and hold it across retries — a strand write can fail without settling whether it landed, so a key minted per attempt turns a manual retry into a duplicate row. See [Client-Generated Keys and Retrying a Write](#client-generated-keys-and-retrying-a-write).
- Per-user state (read position, drafts, preferences) has no private home yet: a per-party key in the strand table partitions it but hides nothing from other members — see [`strand-contracts.md` → Party-Private App State (Interim)](strand-contracts.md#party-private-app-state-interim).

This guide is intentionally compact and example-first. With it, an agent should be able to author strand schemas that enforce consent, membership, multi-tenancy, and audit/security directly in Quereus.


---

### Additional Coverage: Patterns from VoteTorrent

Explicit table context declaration:

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

VALUES-based enum/view:

```sql schema
view Status as
  select * from (values
    ('new','New'),
    ('ready','Ready'),
    ('done','Done')
  ) as Status(Code, Name);
```

Window functions and a cumulative digest (against the Global Assertions `ledger` table):

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

`group_concat` is not available as a window function and there is no digest window aggregate, so a running digest is a recursive CTE rather than an `over (...)` clause.

Utility validation functions in constraints:

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

Id immutability / delete guards (inline on a real table):

```sql schema
table things (
  id   text primary key,
  name text,
  constraint id_immutable check on update (new.id = old.id),
  constraint no_delete    check on delete (false)
);
```
