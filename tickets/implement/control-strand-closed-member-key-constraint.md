description: The cadre control database lets a strand record carry a private member key even when the strand is open, when that key should only ever exist for closed strands — add the missing guard so the data can't get into a contradictory state.
files: packages/cadre-core/src/control-schema.ts, schemas/control.qsql, packages/cadre-core/test/control-formation-invite.spec.ts, packages/cadre-core/test/control-schema-drift.spec.ts, packages/cadre-core/src/control-database.ts
difficulty: easy
----

# Strand "member key only if closed" constraint

The control-network `Strand` table carries `MemberPrivateKey` (the read-gating
secret for a **closed** strand). An **open** strand (`Type:'o'`) has no membership
gate and must not carry a member key. That invariant is currently unenforced — a
standing TODO in the schema:

`packages/cadre-core/src/control-schema.ts:56` — `-- TODO: constraint to ensure member private key only if closed`

## Desired behavior

A `Strand` insert/update must satisfy: `MemberPrivateKey is null when Type = 'o'`
(equivalently, a non-null `MemberPrivateKey` requires `Type = 'c'`). A violating row
is rejected at commit.

Truth table for the proposed predicate `new.MemberPrivateKey is null or new.Type = 'c'`:

| Type | MemberPrivateKey | result   | note                                              |
|------|------------------|----------|---------------------------------------------------|
| `o`  | null             | admitted | open, no gate — `redeemInvitation({type:'o'})`, `provisionAndRecord` |
| `o`  | non-null         | rejected | **the invariant being added**                     |
| `c`  | non-null         | admitted | closed host strand — `resolveStrand` closed path  |
| `c`  | null             | admitted | only open strands are constrained per spec         |

## Research / design

The fix is a single row-level `check (...)`, mirroring the existing `Strand.Authorized`
CHECK style — a bare `check` (no `on insert`/`on update` qualifier) defaults to
insert+update, which is exactly the coverage wanted here. Keep SQL reserved words
lowercase per repo style.

The schema is duplicated in two **byte-identical** copies — the embedded
`CONTROL_SCHEMA` (`packages/cadre-core/src/control-schema.ts`) and the on-disk
`schemas/control.qsql`. The `control-schema-drift.spec.ts` guard normalizes only
EOL/trailing-newline differences and fails the build on any other divergence, so the
new constraint **must be added to both copies identically** (same indentation/text).

Trailing comma after the last constraint is fine — `FormationUsage.StrandExists`
(`control-schema.ts:187`) ends with `),` immediately before `) with context`, so the
existing `-- TODO ...` line can be replaced with the constraint followed by a comma
(or no comma — either parses; match whichever keeps the diff minimal).

### Exact edit (apply to BOTH `control-schema.ts` and `schemas/control.qsql`)

Replace the TODO line:

```
        -- TODO: constraint to ensure member private key only if closed
```

with:

```
        constraint MemberKeyClosedOnly check (
            -- An open strand ('o') has no membership gate, so it must not carry a
            -- member key. A non-null MemberPrivateKey requires a closed strand ('c').
            new.MemberPrivateKey is null or new.Type = 'c'
        )
```

(In `control-schema.ts` the surrounding string is a template literal; this edit is
inside it. In `schemas/control.qsql` it is plain SQL. The two must be textually
identical after the drift guard's EOL normalization.)

### Why it surfaced

The live formation→convergence e2e (`formation-convergence-e2e-wire-and-spec`) wants
to assert closed-strand membership directly at the control insert. Landing this CHECK
hardens the control schema's open/closed/member-key invariant. Not a blocker for the
e2e tier; a correctness hardening.

### No expected regressions

`insertStrand` (`control-database.ts:513`) signs over `[Id, Type, MemberPrivateKey ?? '', StampId]`
and passes `memberPrivateKey ?? null`, so authority-signed inserts are unaffected by the
new check (it is orthogonal to the signature gate). The consent paths that insert open
strands (`redeemInvitation`, `provisionAndRecord`) pass a null member key; the closed-host
paths (`resolveStrand` test, line 299) pass `type:'c'` with a key — all satisfy the predicate.
A reproducing case is simply: an `insertStrand(id, 'o', authKey, sign, someMemberKey)` —
the authority signature is valid, yet the row must now be rejected by `MemberKeyClosedOnly`.

## TODO

- [ ] In `packages/cadre-core/src/control-schema.ts`, replace the `-- TODO: ...` line
      (currently line 56) inside the `Strand` table with the `MemberKeyClosedOnly`
      constraint shown above.
- [ ] Mirror the **identical** edit in `schemas/control.qsql` (currently line 45).
- [ ] Add focused cases to `packages/cadre-core/test/control-formation-invite.spec.ts`
      (the harness already exposes `db.insertStrand(id, type, authKey, signMessage, memberPrivateKey?)`):
  - open strand with a non-null `MemberPrivateKey` is **rejected**:
    `await expect(db.insertStrand('strand-'+rand(), 'o', authorityPublicKey, signMessage, 'memkey-'+rand())).rejects.toThrow();`
    and assert `strandCount()` is unchanged.
  - closed strand with a `MemberPrivateKey` is **accepted** (e.g. assert the row lands
    with `Type:'c'` and the key present — `resolveStrand` already does this at line 299,
    but add an explicit insert+assert here too).
  - open strand with a null `MemberPrivateKey` is **accepted** (already implicitly
    covered by the redeem/provision cases; an explicit `insertStrand(..., 'o', ...)` with
    no member key tightens the trio).
- [ ] Run the cadre-core test suite and confirm the drift guard and consent-path specs
      still pass:
      `yarn workspace @serfab/cadre-core test 2>&1 | tee /tmp/cadre-core-test.log`
      (or the package's configured vitest invocation — check `packages/cadre-core/package.json`).
      In particular `control-schema-drift.spec.ts` (both copies match) and
      `control-formation-invite.spec.ts` (`redeemInvitation` / `provisionAndRecord` still pass).
- [ ] Run `yarn lint` for the touched package and confirm the SQL stays lowercase-reserved-word
      compliant (human-review rule, not machine-checked).
