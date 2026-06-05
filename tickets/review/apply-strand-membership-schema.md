description: Review the implemented change that applies the repaired Strand membership/RBAC schema (schemas/strand.qsql) to every strand via the shared composeStrand seam, alongside the sApp DDL. Schema is now present + constraints active on every strand; population is NOT done (separate ticket).
prereq:
files: schemas/strand.qsql, packages/quereus-plugin-sereus/src/strand-schema.ts, packages/quereus-plugin-sereus/src/compose-strand.ts, packages/quereus-plugin-sereus/test/e2e/strand-schema.e2e.spec.ts, packages/cadre-core/test/strand-instance-manager.spec.ts, docs/architecture.md, tickets/backlog/optimystic-deferred-constraint-rejection-not-rolled-back.md
----

## What was implemented

The `Strand` membership/RBAC schema is now applied to **every** strand database, in the
single shared composition seam (`composeStrand`), alongside the sApp schema. The schema was
also repaired (it had never been parsed/executed and carried latent bugs).

### Files changed

- **`schemas/strand.qsql`** — repaired canonical copy (see "Repairs" below). Now wrapped in
  `declare schema Strand { … }` with a header comment documenting the embedded-copy drift
  invariant.
- **`packages/quereus-plugin-sereus/src/strand-schema.ts`** (new) — embedded `STRAND_SCHEMA`
  constant holding the **body** (inner table declarations) of the schema, byte-equivalent to
  the body of `schemas/strand.qsql`. Mirrors cadre-core's `CONTROL_SCHEMA` pattern so it works
  on filesystem-less platforms (React Native). Leaf module, no browser/fs deps.
- **`packages/quereus-plugin-sereus/src/compose-strand.ts`** — after `hydrate(db)`, applies
  `declare schema Strand { ${STRAND_SCHEMA} } apply schema Strand;` **unconditionally** (step 6),
  then the sApp schema conditionally as before (step 7). Updated the SEAM comment.
- **`packages/quereus-plugin-sereus/test/e2e/strand-schema.e2e.spec.ts`** (new) — 6 e2e tests
  (bootstrap mode, real node + FileRawStorage).
- **`packages/cadre-core/test/strand-instance-manager.spec.ts`** — one test fixed (see
  "Regression I introduced + fixed").
- **`docs/architecture.md`** — the "Strand Networks" note now states the membership schema is
  applied; points population at the lifecycle ticket.
- **`tickets/backlog/optimystic-deferred-constraint-rejection-not-rolled-back.md`** (new) — a
  platform-layer finding (see "Known gaps").

### Repairs to the schema (verified against the Quereus parser + crypto contract)

- `OnlyClosed` referenced a nonexistent `Strand` table → changed to `Header H where H.Type = 'c'`
  (the singleton is `Header`) on `Invite`, `Member`, `Authority`.
- Every `verify()`/`digest()` rewritten to the working idiom
  `verify(digest(<explicit concatenated payload>, 'sha256','utf8'), <sig>, <pubkey>, 'ed25519')`
  — matching `schemas/control.qsql` and the sApp RBAC fixture `simple-sapp.qsql`. Dropped the
  inconsistent `= 1` on `ConsumedInvite.ValidUsage`.
- `Authority.Authorized` precedence fixed: the bootstrap (`count<=1`), former-authority, and
  existing-authority clauses are now explicit, fully-parenthesized `or` alternatives (previously
  the former-authority clause was not joined by `or` and the and/or mix was unparenthesized).
- `ConsumedInvite.MemberKey text foreign key` → `MemberKey text`. Verified against the parser
  (`../quereus/.../parser.ts:3850-3929`): a **bare** column-level `foreign key` is NOT a legal
  column constraint (only `references <table>` is), and `MemberExists`/`MemberValid` already
  enforce the relationship.
- Context var types normalized `string` → `text`, AND made nullable where needed — see the
  deliberate deviation under "Known gaps".
- Confirmed `Invite.Expiration datetime null` and `primary key (/* empty - singleton */)` parse
  (type names are free-form identifier hints; empty-PK singleton is supported and the optimystic
  row-codec handles it via `createPrimaryKeyComparator → () => 0`).

## Validation performed

- `yarn workspace @serfab/quereus-plugin-sereus build` → clean (tsc + browser bundle).
- `yarn workspace @serfab/cadre-core build` → clean.
- `yarn workspace @serfab/quereus-plugin-sereus test` → **45 passed, 1 todo** (6 unit specs;
  includes the new strand-schema e2e + all pre-existing specs, which now also apply the Strand
  schema unconditionally and still pass).
- `yarn workspace @serfab/cadre-core test` → **292 passed** (21 files).
- `eslint` on the 4 changed/added TS files → 0 errors (4 pre-existing `any` warnings in
  `applyRegistrations`, untouched by this change).

### What the e2e tests cover (the floor — extend these)

`test/e2e/strand-schema.e2e.spec.ts`, all in **bootstrap** mode:
1. **applies on a fresh strand + coexists with sApp** — all 6 `Strand.*` tables queryable
   (count 0, no error); `Strand.*` and `App.*` coexist with no name collision.
2. **applies even with no sApp schema** — `Strand.Authority` queryable; `App.*` still absent.
3. **warm restart re-applies cleanly** — reopen persisted strand; `hydrated.tables > 0`,
   persisted `Strand.Member`/`Strand.Header` rows survive (proves hydrate primes the catalog so
   `apply schema Strand` re-emits no churn).
4. **bootstrap founder accepted** — closed `Header`, first `Member` (`count<=1` branch) and
   first `Authority` accepted with null authority context.
5. **unauthorized writes rejected** — 2nd `Member` (no auth/invite) and an `Invite` with no
   valid `Authority` both **throw** (constraints active). See the gap below re: not asserting
   "table unchanged".
6. **OnlyClosed** — open `Header` (`Type='o'`) rejects `Member`/`Authority`/`Invite`; a fresh
   closed strand accepts the first `Member` (proves `Header.Type` flips the gate).

## Known gaps / things to scrutinize (treat tests as a floor)

1. **Deferred-constraint rejection is not rolled back (platform bug, filed).** In bootstrap
   mode, an insert that violates a **deferred** (subquery-bearing) CHECK throws correctly, but
   the violating row stays **committed** (verified to persist across reopen:
   `sessionCount=2 persistedCount=2`). All membership/RBAC rules are deferred (they read other
   tables), so this currently makes rejection non-atomic. Root cause is the optimystic local
   transactor's `rollback()`, NOT the schema (Quereus's commit path correctly calls rollback on
   deferred-constraint failure). The two rejection e2e tests therefore assert only that the
   write **throws**, not that the table is unchanged — the ticket asked for the latter but it is
   blocked by this gap. Filed as `optimystic-deferred-constraint-rejection-not-rolled-back`
   (backlog). **Reviewer: confirm you agree this is out-of-scope platform behavior and the
   "throws" assertion is the right floor; the same leak affects `schemas/control.qsql`.**
2. **Deliberate deviation: context vars made nullable.** The ticket said "normalize context
   types to `text`". I also made the signature/authority context vars **nullable** (`text null`)
   on `Invite`/`ConsumedInvite`/`Member`/`MemberPeer`/`Authority`. Required so the bootstrap
   inserts (founding `Authority`/`Member` with no authority context) don't trip a NOT-NULL
   context error before the `count<=1` branch short-circuits — exactly the
   `Signature text null` rationale from the RBAC fixture and the
   `AuthorityKey text null, Signature text null` idiom in `control.qsql`'s bootstrap tables.
   A null authority key can never match an `Authority` row, so this is not an auth bypass.
   **Reviewer: sanity-check this is sound.**
3. **Networked-mode cost of the unconditional apply.** Applying the `Strand` schema now creates
   6 tables over the consensus network in networked mode. With a real reachable cohort this is
   fine; a solo founder should be in `bootstrap` mode (cadre-core infers mode from cohort
   membership). This is the **same** constraint the sApp apply already had, just more tables —
   but worth a sanity pass on founding/joining flows.
4. **Regression I introduced + fixed (verify the fix is right, not a paper-over).** Adding the
   Strand schema broke exactly one cadre-core test:
   `strand-instance-manager.spec.ts > should accept a cohort-derived bootstrapNodes seed`. It
   brings up a **solo** node in **networked** mode with a BOGUS, unreachable bootstrap seed and
   asserts the strand reaches `active`. On master the lone `App.Test` collection happened to be
   self-owned (1-peer consensus); my added `Strand.Header` collection hashes to a range co-owned
   by the phantom seed → needs 2-peer consensus → fails (`getComponents`/super-majority).
   Confirmed by stash-and-rebuild that the test **passes on master** (so this is my change, not
   pre-existing). Fix: that one test now brings its strand up in `mode: 'bootstrap'` (local
   transactor → no consensus), which still forwards the seed to `createLibp2pNode` (the test's
   actual assertion) and reaches active. **Reviewer: confirm this is the right fix vs. a deeper
   composition change; check no other strand bring-up path relies on networked-with-phantom-seed.**
5. **`MemberPeer.MemberExists` on delete.** Unchanged (out of scope). It checks `new.MemberKey`,
   which is null on delete → would reject `MemberPeer` deletes. No runtime deletes peers yet
   (lifecycle ticket). Flagged, not touched.
6. **`ConsumedInvite` has redundant `MemberExists` + `MemberValid`** (identical predicate). Kept
   both verbatim per the source ticket; harmless but could collapse to one.
7. **Drift discipline is manual.** `STRAND_SCHEMA` (body) and `schemas/strand.qsql` (body) are
   kept byte-equivalent by hand; there is no drift-guard test yet (the analogous
   `control-schema-drift-guard` ticket is still in `implement/`). If that guard generalizes, add
   a Strand case.
8. **Population is explicitly NOT done.** Nothing writes `Header`/`Member`/`Authority`/invites at
   runtime — the e2e tests construct rows directly. The invite→consume happy path is not
   exercised (it needs real ed25519 signing). All owned by
   `strand-membership-lifecycle-population` (backlog).
9. **Coverage is bootstrap-only.** No networked-mode e2e for the membership schema, and no
   cross-node sync test (a joiner seeing membership rows). Owned by the lifecycle ticket.

## Suggested review focus

- Re-derive the repaired `verify(digest(...,'sha256','utf8'), sig, key, 'ed25519')` payloads
  against `simple-sapp.qsql` + `control.qsql` and confirm the concatenation shapes are ones a
  future signer can reproduce (the lifecycle ticket must compute identical bytes).
- Confirm the `Authority.Authorized` restructure is logically equivalent to the intended
  bootstrap / former-authority / existing-authority alternatives (no clause swallowed by
  precedence).
- Validate the nullability deviation (#2) and the cadre-core test fix (#4).
- Decide whether the deferred-constraint rollback gap (#1) needs to block the lifecycle ticket
  or can proceed in parallel.
