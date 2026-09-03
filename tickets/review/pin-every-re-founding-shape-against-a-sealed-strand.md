description: Added the two missing test cases proving a sealed (permanently frozen) strand cannot be re-founded via a signed generation-0 insert or a non-zero-generation insert, closing the gap the original ticket documented.
files: packages/cadre-core/test/strand-seal.spec.ts
difficulty: easy
----

# Re-founding a sealed strand — two new pinned shapes

## What was done

`packages/cadre-core/test/strand-seal.spec.ts`, inside `describe('Manager.Authorized seal
branch', ...)`, right after the existing null-context re-founding case, gained two new `it`
blocks:

1. **`refuses a SIGNED re-founding attempt at generation 0, not just a null-context one
   (Authorized)`** — seals a strand, then attempts the exact same generation-0 founding insert
   as the pre-existing test, but with a REAL self-signature over the `'add'` digest (context
   `ManagerKey`/`Signature` populated) instead of `null`/`null`. Proves the rejection is really
   about the retired-`Manager`-stamp gate and not an accidental pass-through for a malformed/
   missing signature — the founding branch never calls `verify()` at all, so this shape can only
   additionally be caught by the promotion branch, which needs an existing `Manager` row that
   does not exist on a sealed strand.
2. **`refuses a non-zero-generation re-founding insert on a sealed strand (Authorized, promotion
   branch)`** — same seal setup, insert at `Generation = 1` with a real signature. The founding
   branch is out of contention on its own terms (`new.Generation = 0` required), so this pins the
   promotion branch specifically: it needs an existing, live `Manager` row to sign as, and the
   table is empty forever once sealed.

Both assert `rejects.toThrow(/Authorized/)` (same granularity as the pre-existing sibling test —
all branches share one named CHECK constraint, so there is no finer-grained message to pin) and
then assert `tableCount(db, 'Manager') === 0` and `isStrandSealed(db) === true` afterward, so an
accidental accept would show up as a live test failure, not a silent pass.

No production code changed — `schemas/strand.qsql` and `strand-schema.ts` untouched, per the
ticket's own instruction (a rejection here would have meant filing a `fix/` ticket, not editing
the schema; both shapes were correctly refused, so nothing to file).

## Test / validation status

- `yarn workspace @serfab/cadre-core test`: **1702 passed, 1 skipped** (was 1700 + 1 skip before
  this ticket's two additions — count matches exactly). One run hit a transient
  `UNKNOWN: unknown error, read` at import time in four unrelated spec files
  (`device-token-registry.spec.ts`, `strand-instance-manager.spec.ts`,
  `control-revocation-replay.spec.ts`, `cadre-node.spec.ts`), tracing into
  `../optimystic/packages/db-p2p/src/cluster/client.ts` — a filesystem read hiccup on a sibling
  workspace import, not touched by this change. Immediate re-run was 106/106 files, 1702/1703
  green, confirming it was transient and not a regression. Not logged to
  `.pre-existing-known.md` since it did not reproduce on retry and names no stable test.
- `yarn lint`: exit 0.
- `packages/cadre-core/test/strand-seal.spec.ts` run in isolation: 18/18 passing (16 pre-existing
  + 2 new).

## For the reviewer

- Both new cases follow the file's existing PIN DISCIPLINE (a comment naming which branch is the
  sole rejector and why the others pass/don't apply) — worth checking the reasoning holds up
  against `schemas/strand.qsql`'s `Manager.Authorized` constraint (lines ~413-502) rather than
  just trusting the comment.
- Deliberately did NOT touch `debt-hoist-strand-tombstone-helpers` (the tracked duplication of
  `fileTombstone`/`managerStamp`/`seatMember` across spec files) — the ticket explicitly said to
  reuse existing fixtures, not add a sixth copy or refactor.
- No new gaps identified beyond what the original ticket's own "Not re-pinned here" note already
  scopes out (raw resign-tagged delete of the sole manager — covered elsewhere; network-transactor
  parity — one seal case already carried there and doesn't need three more).
