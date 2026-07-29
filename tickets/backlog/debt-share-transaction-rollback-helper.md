description: One twelve-line block of database transaction cleanup code is copy-pasted in a second file; fold it into the shared helper that now exists so there is one copy of the tricky part.
prereq:
files: packages/cadre-core/src/seed-bootstrap.ts, packages/cadre-core/src/control-database.ts
difficulty: easy
----

# Fold `removePeer`'s transaction block into the shared helper

## What

Several control-database writes need the same careful shape: start a transaction, do the
work, commit — and on failure, attempt a rollback, but tolerate that rollback itself failing.
That last part is subtle: a *failed commit* has already torn the transaction down, so the
rollback throws "No transaction active", and if that secondary error is allowed to escape it
replaces and hides the real cause.

That reasoning used to be copy-pasted at four sites. A review pass folded three of them
(inside `ControlDatabase`) into one private `inTransaction(label, body)` helper. The fourth —
`SeedBootstrapService.removePeer` in `seed-bootstrap.ts` — still carries its own copy, because
it lives in a different class and reaches the database through `ControlDatabase.getDatabase()`
rather than owning it.

## Why it matters

Low urgency, but it is exactly the kind of duplication that rots: the next person who
improves the error handling will fix one copy and not the other, and the surviving copy is
the one guarding a security-relevant write (removing a peer from the party).

## Shape of the fix

`removePeer` also duplicates the *contents* of the transaction — a signed delete plus the
matching "token retired" record — which is the same pair `ControlDatabase.deleteGuardedRow`
already performs for the other two guarded tables. So there are two levels available:

- **Minimum:** expose the transaction helper (or a small equivalent) so `removePeer` stops
  hand-rolling the rollback dance.
- **Better:** let `removePeer` go through the same signed-delete helper as the strand and
  validation-key removals, passing its own signing callback. That would leave exactly one
  implementation of "owner-signed delete plus retirement record" for all three tables.

The second is more invasive — `removePeer` fails fast on a missing owner key before touching
the database, and that ordering is asserted by its unit tests — so check those still hold.

Behaviour must not change either way; the existing tests in `seed-bootstrap.spec.ts` and
`control-revocation-replay.spec.ts` should pass untouched.
