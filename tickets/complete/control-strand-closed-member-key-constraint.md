description: A guard was added to the cadre control database so a strand record can only carry a private member key when it is closed, never when it is open — and the review added the only runtime test that can verify it while an unrelated crypto bug blocks the full test suite.
files: packages/cadre-core/src/control-schema.ts, schemas/control.qsql, packages/cadre-core/test/control-formation-invite.spec.ts, packages/cadre-core/test/control-member-key-constraint.spec.ts, docs/architecture.md
----

## What was done (implement stage)

Added the `MemberKeyClosedOnly` CHECK constraint to the `Strand` table in the
CadreControl schema, enforcing that `MemberPrivateKey` is null whenever
`Type = 'o'` (open strand). Applied byte-identically to both schema copies
(`packages/cadre-core/src/control-schema.ts` and `schemas/control.qsql`):

```sql
constraint MemberKeyClosedOnly check (
    -- An open strand ('o') has no membership gate, so it must not carry a
    -- member key. A non-null MemberPrivateKey requires a closed strand ('c').
    new.MemberPrivateKey is null or new.Type = 'c'
)
```

Three behavioral cases were added to `control-formation-invite.spec.ts` (reject
open+key / admit closed+key / admit open+null via `db.insertStrand`).

## Review findings

### Checked & clean

- **Schema drift** — `control-schema-drift.spec.ts` passes: the constraint text is
  byte-identical (post-EOL-normalization) in both schema copies. SQL reserved words
  are lowercase per repo style.
- **Schema validity in the engine** — the constraint is syntactically valid in
  Quereus: the crypto crash that skips the formation-invite suite happens at
  `ensureAuthorityKey` *after* `node.start()` (which applies the schema) succeeds, so
  the new CHECK parses and applies cleanly.
- **Predicate logic** — verified the full truth table directly in the Quereus engine
  (see "Fixed" below): open+key rejected, closed+key admitted, open+null admitted,
  closed+null admitted.
- **No caller regression** — audited every writer of the control-plane `Strand` table.
  `publishStrand` callers (`reference-app-rn`, `reference-app-web`,
  `publish-strand.spec.ts`) use only `'o'` with no key or `'c'` with a key;
  `redeemInvitation` / `provisionAndRecord` mint open strands with a **null** key.
  No path passes an open strand + member key, so the constraint blocks only the
  invalid state, never a live flow. (`addStrand` launches the runtime strand instance
  and does **not** write `CadreControl.Strand`, so it is unaffected.)

### Fixed in this pass (minor)

- **Zero running coverage of the constraint.** The implementer's three
  `insertStrand`-based tests boot a real `CadreNode` and so depend on the crypto
  plugin, which is currently regressed (`Unsupported output encoding: utf8`) — all 16
  tests in that suite are **skipped at runtime**. The constraint therefore had no test
  that actually runs. Added `packages/cadre-core/test/control-member-key-constraint.spec.ts`
  (5 cases), which applies a **minimal, crypto-free** schema carrying only the
  `MemberKeyClosedOnly` predicate and exercises it directly in the Quereus engine. The
  predicate uses no crypto, so this runs today; combined with the drift guard (which
  pins that this exact predicate text is what the real `Strand` table carries) the two
  specs cover "the real schema has this predicate" + "this predicate behaves correctly"
  without crypto. The implementer's crypto-gated `insertStrand` cases remain (they add
  end-to-end coverage once crypto lands).
- **Edge case pinned: null `Type` + key.** Quereus treats a NULL CHECK result as a
  violation (stricter than the SQL-standard "pass on unknown"), so a key on a strand
  with a null `Type` (`false or null`) is **rejected**, not admitted. This is the
  desirable behavior — a member key always requires an explicit `Type='c'` — and is now
  pinned with a test + explanatory comment in the new spec.
- **Docs.** `docs/architecture.md` described the open/closed member-key model but not
  that it is now *enforced*. Added a clause at the control-layer `Strand` description
  noting the `MemberKeyClosedOnly` CHECK.

### Out of scope (pre-existing, already triaged)

- The `Unsupported output encoding: utf8` crypto regression that skips the node-booting
  cadre-core suites is **not** caused by this change. It was triaged during implement
  into backlog ticket `cadre-core-digest-variadic-api-migration` (the
  `@optimystic/quereus-plugin-crypto` `digest` API changed out from under cadre-core).
  Not addressed here.

### Major findings

None. No new fix/plan/backlog tickets filed beyond the pre-existing crypto migration
above.

## Validation run

- `yarn lint` — exit 0 (clean).
- `yarn workspace @serfab/cadre-core test test/control-schema-drift.spec.ts test/control-member-key-constraint.spec.ts`
  — 6 passed (2 files).
- `control-formation-invite.spec.ts` — 16 skipped at runtime (pre-existing crypto
  regression); the three new constraint cases there are discovered and correctly
  designed, and will run once `cadre-core-digest-variadic-api-migration` lands.
