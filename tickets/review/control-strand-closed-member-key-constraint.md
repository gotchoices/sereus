description: Review the CHECK constraint that prevents a strand record from carrying a member key when it is open, and the three new tests that cover the constraint's accept/reject boundary.
files: packages/cadre-core/src/control-schema.ts, schemas/control.qsql, packages/cadre-core/test/control-formation-invite.spec.ts
----

## What was done

Added the `MemberKeyClosedOnly` CHECK constraint to the `Strand` table in the
CadreControl schema, enforcing the invariant that `MemberPrivateKey` must be null
whenever `Type = 'o'` (open strand).

The constraint was applied identically to both schema copies:
- `packages/cadre-core/src/control-schema.ts` (line ~56, inside the template literal)
- `schemas/control.qsql` (line ~45)

The schema drift guard (`control-schema-drift.spec.ts`) **passes** — the two copies
are byte-identical after EOL normalization.

Three focused test cases were added to `packages/cadre-core/test/control-formation-invite.spec.ts`
in a new `describe('MemberKeyClosedOnly constraint')` block:
1. **Reject** — open strand + non-null `MemberPrivateKey` → throws, `strandCount` unchanged
2. **Accept** — closed strand + `MemberPrivateKey` → row lands with `Type:'c'`
3. **Accept** — open strand + no member key → row lands with `Type:'o'`

## Constraint text (applied to both files)

```sql
        constraint MemberKeyClosedOnly check (
            -- An open strand ('o') has no membership gate, so it must not carry a
            -- member key. A non-null MemberPrivateKey requires a closed strand ('c').
            new.MemberPrivateKey is null or new.Type = 'c'
        )
```

## Known gap

All node-booting test suites in cadre-core — including
`control-formation-invite.spec.ts` — are currently **skipped at runtime** due to a
pre-existing `Unsupported output encoding: utf8` error in `quereus-plugin-crypto`
(see `tickets/.pre-existing-error.md`). The three new constraint tests exist and are
discovered by Vitest but cannot run until that upstream crypto regression is fixed.
The drift guard (which does not use crypto) confirms schema correctness.

The reviewer should verify:
- The constraint text in both files is identical and follows lowercase SQL reserved
  word style.
- The CHECK predicate is logically correct per the truth table in the ticket:
  `new.MemberPrivateKey is null or new.Type = 'c'`
- The three new test cases would exercise the right boundary conditions once the
  crypto plugin is fixed (reject open+key, admit closed+key, admit open+null).
- No existing consent-path callers (`redeemInvitation`, `provisionAndRecord`,
  `insertStrand` open-strand paths) pass a non-null member key on an open strand.
