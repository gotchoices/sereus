description: Five test files each keep their own copy of the same setup code for opening a test database and seeding rows; move it to one shared file so a fix lands once instead of five times.
files: packages/cadre-core/test/strand-membership-peer-rotation.spec.ts, packages/cadre-core/test/strand-member-revocation.spec.ts, packages/cadre-core/test/strand-membership-invite.spec.ts, packages/cadre-core/test/strand-approval-replay.spec.ts, packages/cadre-core/test/strand-membership-writer.spec.ts, packages/cadre-core/test/control-constraint-helpers.ts
difficulty: easy
----

# Hoist the duplicated strand-spec setup helpers into one module

## What is duplicated

The five `strand-*.spec.ts` files under `packages/cadre-core/test/` each carry their own
verbatim (or near-verbatim) copy of the same setup code:

| helper | copies | what it does |
| --- | --- | --- |
| `makeSAppConfig` | 5 | the placeholder app config the strand header needs |
| `freshKeyPair` | 5 | a throwaway ed25519 keypair in the base64url shape the constraints read |
| `tableCount` | 5 | `select count(1)` against one strand table |
| `openStrand` | 5 | bring up a real strand database, run the founder bootstrap, register it for teardown |
| `inTransaction` | 4 | one explicit transaction, tolerating the rollback-after-failed-commit case |
| `openRawStrand` | 2 | same bring-up, but WITHOUT the founder bootstrap |
| `insertHeader` | 2 | seed the singleton header row directly |
| `rawInsertMember` | 2 | seed a member row directly, bypassing the writer |

The last three were duplicated most recently by the manager-must-be-a-member test work.
Each copy is genuinely identical in behaviour; only the doc comments differ, tailored to
why that file needs it.

## Why it matters

The `inTransaction` copies encode a subtlety — a *failed* commit has already torn the
transaction down, so the following rollback throws "no transaction active", and letting
that secondary error escape would hide the real cause. That is exactly the kind of
reasoning that gets improved in one copy and not the other four. `openStrand` is
similarly load-bearing: it owns test teardown (shutting the node down and closing the
database), so a leak fixed in one file leaks in the rest.

Not urgent — the suite is green and fast (the whole `@serfab/cadre-core` package runs in
about a minute) — but the duplication grows every time a strand constraint gets test
coverage.

## Expected shape

The package already has the convention: `test/control-constraint-helpers.ts`,
`test/membership-gate-helpers.ts`, and `test/wake-stream-helpers.ts` are plain
non-`.spec.ts` modules that specs import. A `test/strand-spec-helpers.ts` alongside them
would hold the table above, and each spec would import instead of re-declaring. The
`Strand` interface (`db` / `strandId` / `founder` / `shutdown`) and the module-level
`opened` array plus its `afterEach` teardown travel with it.

Two things to decide while doing it, not before:

- `openRawStrand` currently satisfies the `Strand` interface by generating a founder
  keypair it never uses (`founder: freshKeyPair(), // unused — no bootstrap ran`). A
  shared module is the right place to give the un-bootstrapped case its own narrower
  return type instead.
- `strand-membership-peer-rotation.spec.ts` is now about 1,500 lines, most of it manager
  rotation rather than peer registration. Whether to split it — and whether that is the
  same change or a separate one — is a judgement call for whoever picks this up.

Behaviour must not change: all five specs pass untouched afterwards, and no test loses
its per-file explanatory comment (fold the useful parts of those comments into the shared
module's docs rather than dropping them).
