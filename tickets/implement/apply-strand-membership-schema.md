----
description: Apply the (repaired) strand membership/RBAC schema (schemas/strand.qsql) to every live strand database via the shared composition seam, alongside the sApp DDL
prereq: consolidate-strand-sql-surface-and-add-plugin-hydrate
files: schemas/strand.qsql, packages/cadre-core/src/control-database.ts, packages/quereus-plugin-sereus/src/connect.ts, packages/quereus-plugin-sereus/src/connect-browser.ts, packages/cadre-core/src/strand-database.ts, docs/architecture.md
----

## Goal

`schemas/strand.qsql` (the `declare schema Strand { Header, Invite, ConsumedInvite,
Member, MemberPeer, Authority }` membership/RBAC schema) is never applied to a running
strand database. Both runtime bring-up paths apply only the sApp DDL under
`declare schema App`. This ticket makes the Strand schema **present and active** in every
strand database, in **one** place — the shared composition seam introduced by the prereq
`consolidate-strand-sql-surface-and-add-plugin-hydrate`.

Scope is deliberately **applying the schema**, not populating it. Inserting the `Header`
row and bootstrapping the first `Authority`/`Member` (and invite/peer flows) is a separate
formation/founder-coordination concern owned by the backlog ticket
`strand-membership-lifecycle-population`. After this ticket the Strand tables exist and
their constraints are active and correct; nothing yet writes membership rows at runtime, so
the change is **additive and safe** — it does not gate sApp (`App.*`) reads or writes.

## Design

### Embed the schema as a constant (mirror CONTROL_SCHEMA)

The control schema is shipped as an **embedded TS string** (`CONTROL_SCHEMA`,
`packages/cadre-core/src/control-database.ts:19-115`) precisely so it works cross-platform
(React Native has no filesystem). The on-disk `schemas/control.qsql` is the canonical
human-readable copy; the embedded string is the runtime copy. Follow the same pattern:

- Add a `STRAND_SCHEMA` exported constant holding the **body** of `declare schema Strand { … }`
  (the inner table declarations, matching how `CONTROL_SCHEMA` holds the wrapped DDL).
  Place it where the shared composition can import it without dragging in browser/fs-only
  modules — a small leaf module in `quereus-plugin-sereus` (e.g. `strand-schema.ts`) is the
  natural home since the consolidated seam lives there; alternatively co-locate beside
  cadre-core's schema constants if cleaner. Keep `schemas/strand.qsql` byte-equivalent to the
  embedded copy (same drift discipline as `control-schema-drift-guard` applies to control).
- Do **not** read the `.qsql` from disk at runtime.

### Apply in the single shared seam

After the prereq lands, `connect.ts`/`connect-browser.ts` delegate to one shared
`compose-strand` helper that does: resolve transactor → build pluginConfig → register
vtables/functions → `registerLibp2pNode` → `setDefaultVtab*` → **`hydrate(db)`** → apply
`declare schema App { … } apply schema App;`.

In that helper, **after `hydrate(db)`**, apply the Strand schema **unconditionally** (every
strand has membership semantics), then apply the sApp schema conditionally as today:

```sql
declare schema Strand { /* STRAND_SCHEMA body */ }
apply schema Strand;
```

Use a separate `db.exec` from the App apply. There are no cross-schema references between
`Strand` and `App`, so order is irrelevant; apply `Strand` first for clarity. Because the
apply happens after `hydrate`, warm restarts diff against the hydrated catalog and re-emit no
DDL (same fix the prereq generalizes).

If, for any reason, the prereq has not collapsed the three compositions by the time this is
implemented, apply the Strand schema in **both** `connect.ts` and `cadre-core`'s
`executeSchema` rather than only one — but the expectation is a single seam.

### Repair the schema so it parses and the constraints are correct

`strand.qsql` has **never been parsed or executed**, so it carries latent bugs. The working
idiom to match is `schemas/control.qsql` (e.g. `AuthorityKey.Authorized`,
`CadrePeer.Authorized*`), which uses
`verify(digest(<payload>, 'sha256', 'utf8'), <signature>, <pubkey>, 'ed25519')`. Repair, in
both the canonical file and the embedded constant:

- **`OnlyClosed` references a nonexistent table.** `Invite` (`strand.qsql:39-41`), `Member`
  (`:70-72`), and `Authority` (`:110-112`) all check
  `exists (select 1 from Strand S where S.Type = 'c')`, but there is **no `Strand` table** —
  the singleton is `Header`. Change to `exists (select 1 from Header H where H.Type = 'c')`.
- **`verify()`/`digest()` shape.** Every `verify(...)` in `strand.qsql` omits the curve arg
  (defaulting to secp256k1) and every `digest(...)` passes a bare field list with no
  algorithm/encoding (so the 2nd/3rd fields are misread as algorithm/input-encoding — the
  exact malformation the RBAC fixture ticket `1-integration-tests-rbac-signed-write-coverage`
  documents). Rewrite each to digest a single explicitly-concatenated payload and verify on
  ed25519, e.g.:
  - `Invite.InviteValid`: `verify(digest(new.Key || '|' || coalesce(new.Expiration,''), 'sha256','utf8'), context.AuthoritySignature, A.MemberKey, 'ed25519')` and the second proof `verify(digest(new.Key || '|' || coalesce(new.Expiration,''), 'sha256','utf8'), context.InviteSignature, new.Key, 'ed25519')`.
  - `ConsumedInvite.ValidUsage`: `verify(digest(new.InviteKey || '|' || new.MemberKey, 'sha256','utf8'), context.InviteSignature, new.InviteKey, 'ed25519')` (drop the inconsistent `= 1` — `verify` already yields a boolean, matching control.qsql).
  - `Member.Authorized`: authority path `verify(digest(new.Key, 'sha256','utf8'), context.AuthoritySignature, A.MemberKey, 'ed25519')`.
  - `MemberPeer.Authorized`: `verify(digest(coalesce(new.MemberKey,old.MemberKey) || '|' || coalesce(new.PeerId,old.PeerId), 'sha256','utf8'), context.Signature, coalesce(new.MemberKey,old.MemberKey), 'ed25519')`.
  - `Authority.Authorized`: see precedence fix below; both verify calls become
    `verify(digest(<key>, 'sha256','utf8'), context.Signature, <key>, 'ed25519')`.
  Keep the concatenation separator/encoding **identical** to whatever
  `1-integration-tests-rbac-signed-write-coverage` settles on for the sApp fixture so signers
  in the follow-on lifecycle ticket compute one canonical payload shape across both layers.
- **`Authority.Authorized` precedence/missing `or`.** As written (`strand.qsql:113-128`) the
  bootstrap clause `(select count(1) from Authority) <= 1` and the former-authority clause
  `old.MemberKey is not null and …` are **not joined by `or`**, and the `and`/`or` mix is
  unparenthesized. Restructure to explicit, fully-parenthesized alternatives:
  ```
  (select count(1) from Authority) <= 1
    or ( old.MemberKey is not null and old.MemberKey = context.AuthorityKey
         and verify(digest(old.MemberKey,'sha256','utf8'), context.Signature, old.MemberKey, 'ed25519') )
    or exists ( select 1 from Authority A where A.MemberKey = context.AuthorityKey
         and verify(digest(coalesce(new.MemberKey, old.MemberKey),'sha256','utf8'), context.Signature, A.MemberKey, 'ed25519') )
  ```
- **Context type keyword.** `strand.qsql` declares context vars as `string`; the parser
  accepts any identifier as a free-form type hint, but control.qsql's house idiom is `text`.
  Normalize to `text` for consistency.
- **`ConsumedInvite.MemberKey text foreign key`** uses a bare `foreign key` with no
  `references` target. control.qsql never uses this form, and the `MemberExists`/`MemberValid`
  check constraints already enforce the relationship. Confirm against the Quereus parser
  (`../quereus/packages/quereus/src/parser`) whether bare `foreign key` is legal; if not,
  drop the keyword (rely on the check constraints) or write `references Member (Key)` only if
  supported. Likewise sanity-check that `Invite.Expiration datetime null` (the `datetime`
  type keyword) parses — control.qsql uses only `text`.

These repairs make the schema parse and make the bootstrap path (`count <= 1`, first
member/authority needs no authorization) and the rejection paths correct, even though no
runtime code signs membership writes yet (that is the lifecycle ticket).

### Docs

Update `docs/architecture.md:58` (the note that the membership schema "is not yet applied
automatically") and the Strand Networks / Network Isolation prose to state that the Strand
membership schema is now applied to every strand alongside the sApp schema, with population of
membership rows tracked by the lifecycle ticket. Reflect the same in `docs/STATUS.md` if it
asserts the schema is unwired.

## Key tests

Add coverage near the prereq's bootstrap e2e (`packages/quereus-plugin-sereus/test/e2e/`) or
cadre-core's strand-database tests — wherever the shared seam is exercised:

- **Schema applies on a fresh strand**: after bring-up, `Strand.Header`, `Strand.Member`,
  `Strand.Invite`, `Strand.ConsumedInvite`, `Strand.MemberPeer`, `Strand.Authority` are all
  queryable (e.g. `select count(*) from Strand.Member` returns 0 without error). The Strand and
  App schemas coexist (query both `Strand.*` and `App.*` in the same DB, no name collision).
- **Warm restart re-applies cleanly**: reopen the same persisted strand; the Strand tables are
  still queryable and the apply emits no churn (hydrate ran first — assert via the prereq's
  hydrate-count surface that `tables > 0` on reopen).
- **Bootstrap insert accepted**: with a manually-inserted closed `Header`
  (`Type='c'`), the first `Member` insert (the `count<=1` branch) and the first `Authority`
  insert succeed with no authority context.
- **Constraint rejection**: into the same closed strand, a second `Member` insert that is
  neither authority-signed nor invite-backed is **rejected** (`Member.Authorized`); an
  `Invite` insert with no valid `Authority`/signature is **rejected** (`Invite.InviteValid`);
  assert the table is unchanged after rejection.
- **Open-vs-closed**: with `Header.Type='o'`, the `OnlyClosed` constraints make
  `Member`/`Invite`/`Authority` inserts fail (no closed Header); with `Type='c'` the bootstrap
  inserts above succeed — proving `Header.Type` is wired through the constraints.

These tests construct their own `Header`/membership rows directly via `db.exec(... with
context ...)`; production population is the lifecycle ticket.

## Key references

- `schemas/strand.qsql` — schema to repair + apply (currently unused, unparsed).
- `schemas/control.qsql` + `packages/cadre-core/src/control-database.ts:19-115` —
  `CONTROL_SCHEMA` embedded-constant pattern and the working `verify(digest(...,'sha256','utf8'),
  sig, key, 'ed25519')` idiom.
- `consolidate-strand-sql-surface-and-add-plugin-hydrate` (prereq) — creates the single
  `compose-strand` seam (hydrate-before-apply) this ticket extends.
- `1-integration-tests-rbac-signed-write-coverage` — establishes the canonical
  `digest(<concat>,'sha256','utf8')` + ed25519 payload shape for the sApp layer; match it.
- `packages/cadre-core/src/control-database.ts:394-398` — `insert … with context …` DML idiom.
- `../quereus/packages/quereus/src/parser/parser.ts:3689-3726` — `with context` parsing
  (free-form type lexeme; `string`/`text` both parse).

## TODO

### Phase 1 — embed + repair the schema
- Repair `schemas/strand.qsql`: `OnlyClosed` → `Header`; rewrite all `verify()`/`digest()` to
  the `('sha256','utf8')` + `'ed25519'` idiom with explicit concatenated payloads; fix
  `Authority.Authorized` precedence/`or`; normalize context types to `text`; resolve the bare
  `foreign key` and `datetime` keyword questions against the Quereus parser.
- Add the `STRAND_SCHEMA` embedded constant (body of `declare schema Strand { … }`), kept
  byte-equivalent to the canonical file. Place it in a leaf module reachable by the shared
  composition without pulling in browser/fs-only deps.

### Phase 2 — apply in the shared seam
- In the consolidated `compose-strand` helper, after `hydrate(db)` and before/around the App
  apply, unconditionally `declare schema Strand { … } apply schema Strand;`. (Fallback: do it
  in both compositions if the prereq seam is somehow not in place.)

### Phase 3 — tests + docs
- Add the schema-applies / warm-restart / bootstrap-accepted / constraint-rejected /
  open-vs-closed tests described above; stream output (`| tee`), do not silently redirect.
- `yarn build` in `quereus-plugin-sereus` and `cadre-core` (clean); run the affected test
  suites green.
- Update `docs/architecture.md:58` and `docs/STATUS.md` to say the Strand schema is applied;
  point population at `strand-membership-lifecycle-population`.
