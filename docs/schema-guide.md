## Sereus Schema Guide (for Quereus)

Purpose: A compact, example-driven reference so a human or AI agent can define a full Sereus strand schema using Quereus’ declarative SQL. Assumes familiarity with SQL; focuses on Quereus- and Sereus-specific patterns.

Key Quereus characteristics:
- Declarative, order-independent schema blocks (`schema { ... }`).
- Columns are NOT NULL by default (unless explicitly `null`).
- `using memory` (or another vtab) selects the storage module.
- Table-level mutation context variables available in `DEFAULT` and `CHECK`.
- Global assertions (`create assertion ... check (...)`).
- Auto-deferred row-level CHECKs when needed; immediate for simple per-row checks.

Declarative workflow (engine-driven migration):

```sql
-- Optional: ensure standard SQL nullability semantics
pragma default_column_nullability = 'not_null';  -- or 'nullable'

-- Declare the desired end-state (diffable & order-independent)
declare schema main using (default_vtab_module = 'memory') {
  table users { id integer primary key, email text unique, name text }
  index users_email on users(email)
  view v_users as select id, email from users
  seed users values (id, email, name) values (1,'a@x','A'), (2,'b@x','B')
}

-- Compute and inspect migration DDL
diff schema main;          -- returns rows { ddl: 'CREATE TABLE ...' }

-- Apply migrations (and optionally seed)
apply schema main;         -- executes DDL
apply schema main with seed;

-- Version/hash for tracking
explain schema main;       -- returns { info: 'hash:...' }
```

Conventions used below:
- "Strand" = the database shared by consenting participants.
- "Cadre" = a user's personal device cluster that manages/stores data on their behalf.
- "Cohort" = all nodes belonging to a strand (the combined cadres of all strand members).
- Role/rights are modeled at the schema layer using context variables + checks.

---

### Minimal Strand Schema Skeleton

```sql
schema "com.example.messaging" version 1 using (default_vtab_module = 'memory') {
  -- Identities scoped to the strand; emails optional to allow pseudonyms/handles
  table users (
    id          text primary key,
    display     text,         -- Handle or display name (not globally unique)
    email       text null,    -- Optional; Quereus defaults to NOT NULL unless marked null
    created_at  text default datetime('now')
  );

  -- Simple messages; each row belongs to a conversation (strand-local grouping)
  table conversations (
    id          text primary key,
    title       text,
    created_by  text references users(id),
    created_at  text default datetime('now')
  );

  table messages (
    id             text primary key,
    conversation   text references conversations(id),
    sender_id      text references users(id),
    content        text,
    sent_at        text default datetime('now'),
    -- Prevent empty content at insert-time only
    constraint nonempty_content check on insert (length(content) > 0)
  );

  -- Seed minimal roles & an admin user
  seed users (id, display) values
    ('u_admin', 'Admin');
}
```

---

### Roles & Permissions (Schema-Enforced via Context)

Quereus supports table-level mutation context (e.g., `actor_id`, `auth_token`) for use in defaults and checks. This enables application-enforced RBAC without a central auth server.

```sql
schema "com.example.rbac" version 1 using (default_vtab_module = 'memory') {
  table roles (
    code text primary key,           -- 'admin', 'member', ...
    sort integer default 0
  );

  table user_roles (
    user_id  text,
    role     text references roles(code),
    constraint pk_user_roles primary key (user_id, role)
  );

  -- Application-provided context (names are up to you):
  --   context.actor_id, context.auth_token, context.current_tenant_id, ...
  -- You can use custom functions: has_role(token, 'admin') → 1/0

  table protected_records (
    id       text primary key,
    tenant   text,
    data     text,
    created  text default datetime('now'),

    -- Multi-tenant isolation: write must match current_tenant
    constraint tenant_guard check (
      tenant = context.current_tenant_id
    ),

    -- Require a particular role to insert/update
    required_role text default 'member',
    constraint write_auth check (
      has_role(context.auth_token, required_role) = 1
    )
  );
}
```

Notes:
- Use your own user-defined functions (UDFs) such as `has_role(token, role)` to integrate signatures/claims.
- The same pattern works for audit trails (see below) and cryptographic checks.

---

### Integrity: Foreign Keys, Composite Keys, Immediate vs Auto-Deferred Checks

```sql
schema "com.example.orders" version 1 using (default_vtab_module = 'memory') {
  table customers (
    id    text primary key,
    name  text
  );

  table products (
    id    text primary key,
    name  text,
    price real check (price >= 0)
  );

  table orders (
    id          text primary key,
    customer_id text references customers(id),
    created_at  text default datetime('now')
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
      (select ifnull(sum(qty * price), 0.0)
         from order_items oi
        where oi.order_id = new.order_id)
      <= (select credit_limit from customers c where c.id = (select o.customer_id from orders o where o.id = new.order_id))
    )
  );
}
```

Id immutability / delete guards:

```sql
constraint id_immutable check on update (new.id = old.id);
constraint no_delete    check on delete (false);
```

---

### Generated Columns, Defaults, and Domain-Like Checks

```sql
schema "com.example.content" version 1 using (default_vtab_module = 'memory') {
  table articles (
    id       text primary key,
    title    text,
    body     text,
    slug     text generated always as (lower(replace(title, ' ', '-'))) stored,
    created  text default datetime('now'),

    -- Simple email-like check for author contact
    author_email text null check (like(author_email, '%@%'))
  );
}
```

---

### Views for Read Models / Projections

```sql
schema "com.example.views" version 1 using (default_vtab_module = 'memory') {
  table users ( id text primary key, email text, display text );
  table user_roles ( user_id text, role text );

  view v_users_with_roles as
    select u.id, u.email, u.display,
           group_concat(ur.role, ',') as roles
      from users u left join user_roles ur on u.id = ur.user_id
     group by u.id, u.email, u.display;
}
```

---

### Indexes (Performance & Uniqueness)

```sql
schema "com.example.indexes" version 1 using (default_vtab_module = 'memory') {
  table users ( id text primary key, handle text );

  create unique index idx_users_handle on users(handle);
}
```

---

### Common Table Expressions (CTE), Recursive, and Hints

```sql
-- Non-recursive CTE used as a staging read model
with active_users as (
  select id from users where last_seen > datetime('now','-7 days')
)
select * from active_users;

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

-- Materialization hints (parsed; future optimization)
with recursive
  large_cte as materialized (select * from big_table),
  small_cte as not materialized (select * from small_table)
select ...;
```

Set operations:

```sql
select id from a
union
select id from b;

select id from a
intersect
select id from b;

select id from a
except
select id from b;

-- Quereus extension: diff (multiset difference)
select id from a
diff
select id from b;
```

---

### Global Assertions (Cross-Table Invariants)

Use assertions for invariants that aren’t naturally bound to a single table mutation.

```sql
schema "com.example.assertions" version 1 using (default_vtab_module = 'memory') {
  table ledger (
    id    integer primary key,
    kind  text check (kind in ('debit','credit')),
    amt   real check (amt >= 0)
  );

  -- Sum(credits) = Sum(debits)
  create assertion balanced_book check (
    (select ifnull(sum(case when kind='credit' then amt else 0 end),0) from ledger)
    =
    (select ifnull(sum(case when kind='debit'  then amt else 0 end),0) from ledger)
  );
}
```

---

### Audit & Security with Mutation Context (Signatures, Tenants, Actor Info)

```sql
schema "com.example.security" version 1 using (default_vtab_module = 'memory') {
  -- Expect application to set context variables on each mutation:
  --   context.actor_id, context.actor_name, context.operation_signature, context.current_tenant_id

  table documents (
    id        text primary key,
    tenant    text,
    title     text,
    content   text,

    -- Audit defaults derived from context
    created_by text default actor_name,
    created_at text default datetime('now'),
    op_sig     blob default operation_signature,

    -- Multi-tenant write barrier
    constraint tenant_isolation check (tenant = context.current_tenant_id),

    -- Example signature verification hook (via UDFs)
    constraint signature_valid check (
      verify_signature(op_sig, id, title, content, created_by) = 1
    )
  );
}
```

---

### Seeds (Deterministic Bootstrapping)

```sql
schema "com.example.seed" version 1 using (default_vtab_module = 'memory') {
  table roles (code text primary key);
  seed roles (code) values ('admin'),('member');
}
```

---

### RETURNING with NEW/OLD (DML Feedback)

```sql
-- Insert returning generated values
insert into messages (id, conversation, sender_id, body)
values ('m1','c1','u1','Hello!')
returning id, NEW.body as body_text, NEW.sent_at as at;

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

```sql
-- Explode a JSON array column into rows (e.g., message tags)
select m.id, t.value as tag
  from messages m,
       json_array_elements_text(m.tags) as t(value)
 where m.id = 'm42';

-- Join with a table-valued function
select *
  from my_table_valued_func(:arg1, :arg2) as f(col1, col2)
 where col1 > 0;
```

---

### Putting It All Together: A Compact Sereus App Schema

This example demonstrates a realistic consent-based messaging app schema using all key features: FK, composite PK, checks (immediate + auto-deferred), generated columns, indexes, views, mutation context, assertions, and seeds.

```sql
schema "org.sereus.chat" version 1 using (default_vtab_module = 'memory') {
  -- Users & roles
  table users (
    id         text primary key,
    handle     text,
    display    text,
    joined_at  text default datetime('now')
  );
  create unique index idx_users_handle on users(handle);

  table roles (
    code text primary key
  );
  seed roles (code) values ('admin'),('member');

  table user_roles (
    user_id text,
    role    text references roles(code),
    constraint pk_user_roles primary key (user_id, role)
  );

  -- Conversations & membership
  table conversations (
    id          text primary key,
    tenant      text, -- optional org/workspace isolation
    title       text,
    created_by  text references users(id),
    created_at  text default datetime('now'),
    constraint tenant_write_guard check (
      tenant is null or tenant = context.current_tenant_id
    )
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
    sent_at        text default datetime('now'),

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
  create assertion conversation_has_admin check (
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
}
```

---

### Practical Guidance & Patterns
- Prefer declarative `schema { ... }` blocks; they’re order-independent and diffable.
- Model authorization at the data layer using context variables + checks; keep business rules close to data.
- Use global assertions for invariants spanning multiple tables.
- Expect some checks to be validated at COMMIT (auto-deferred) when referencing external rows/aggregates.
- Keep views as read models; avoid complex write logic in views.
- Use seeds for deterministic bootstrap (roles, system users, defaults).
- Index for uniqueness and query speed; prefer named composite PKs where natural.

This guide is intentionally compact and example-first. With it, an agent should be able to author strand schemas that enforce consent, membership, multi-tenancy, and audit/security directly in Quereus.


---

### Additional Coverage: Patterns from VoteTorrent

Explicit table context declaration:

```sql
table secured_objects (
  id   text primary key,
  data text,
  constraint signed_change check (
    SignatureValid(Digest(Tid, id, data), context.signature, context.user_key) = 1
  )
) with context (
  user_key  text,
  signature text,
  Tid       int
);
```

VALUES-based enum/view:

```sql
view Status as
  select * from (values
    ('new','New'),
    ('ready','Ready'),
    ('done','Done')
  ) as Status(Code, Name);
```

LATERAL with JSON table-valued function:

```sql
-- Explode JSON array column with explicit lateral
select p.id, t.tag
  from posts p
  cross join lateral json_array_elements_text(p.tags) as t(tag)
 where p.id = :pid;
```

Window functions (analytics) and cumulative digests:

```sql
-- Running total by account
select account_id,
       amount,
       sum(amount) over (partition by account_id order by ts
                         rows between unbounded preceding and current row) as running_balance
  from ledger;

-- Cumulative digest over ordered inputs (pattern used in VoteTorrent)
select x,
       DigestAll(Digest(x)) over (order by x) as cumulative_digest
  from (select 1 as x union all select 2 union all select 3);
```

Utility validation functions in constraints:

```sql
table events (
  id     text primary key,
  at     text,    -- ISO8601 UTC timestamp
  suffix text,
  n      any null,
  constraint ts_valid    check (isISODatetime(at) and endswith(at, 'Z')),
  constraint n_is_int    check (n is null or typeof(n) = 'integer')
);
```

Id immutability / delete guards (inline on a real table):

```sql
table things (
  id   text primary key,
  name text,
  constraint id_immutable check on update (new.id = old.id),
  constraint no_delete    check on delete (false)
);
```
