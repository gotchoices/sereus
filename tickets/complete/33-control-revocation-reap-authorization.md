----
description: A machine that only learned about a member's removal after the fact can now delete that member's leftover record itself, because the signed removal record it already holds proves the owner authorized it. Nothing runs this automatically yet.
prereq:
files: schemas/control.qsql, packages/cadre-core/src/control-schema.ts, packages/cadre-core/src/control-database.ts, packages/cadre-core/src/index.ts, packages/cadre-core/test/control-revocation-reap.spec.ts, eslint.config.mjs, docs/architecture.md, docs/STATUS.md
----

# Reap authorization — complete

## What shipped

**Schema (both copies, drift guard green):** `CadrePeer` / `DeviceToken` / `ValidationKey`
`AuthorizedDelete` each gained a REAP branch —
`or exists (select 1 from committed.Revocation R where R.TableName = '<table>' and
R.RowKey = old.<key> and R.StampId = old.StampId)`. An already-committed, owner-signed
tombstone naming that exact row incarnation authorizes the delete, so a node that converged
on a removal while still holding the removed row can drop it with no owner private key. The
full rationale (why `committed.*` rather than `Revocation`; why the stamp clause binds the
incarnation rather than the name) lives on `CadrePeer.AuthorizedDelete`; the other two
cross-reference it. `Strand` carries a comment recording that the branch is **deliberately
absent** (the row holds `MemberPrivateKey`), no behavioral change.

**Database:** `REAPABLE_TABLES` / `ReapableTable` and
`ControlDatabase.reapRevokedRow(table, rowKey, stampId): Promise<boolean>` — raw stamp
guard read, then ONE unsigned delete bound to `(key, StampId)` with a present
`with context OwnerKey = null, Signature = null`. `CadrePeer` routes through
`mutateCadrePeer`; the other two through `execWrite`. Writes nothing to `Revocation`.
Exported from `packages/cadre-core/src/index.ts`.

**Nothing calls it automatically.** The sweep is `tickets/implement/33.5-control-revocation-reap-sweep.md`.

**Docs:** `docs/architecture.md` (the `Revocation` table row and the delete-while-alone
residuals paragraph) and `docs/STATUS.md` (lint exemption list).

## Review findings

Implement-stage diff (`dd4972f`) read first, then the handoff. Verification below was run
on this machine against the real engine.

### Checked and clean — no finding

- **Schema branch shape.** Both copies byte-identical for all three branches; the `or`
  continuation indent (12 → 16 with a blank line) matches the existing house style used by
  `OwnerKey.Authorized` and `CadrePeer.AuthorizedUpdate`, so it is not a formatting wart.
  Drift guard green.
- **Locking.** `reapRevokedRow` takes the write lock exactly once per path —
  `mutateCadrePeer` → `lockedWithRetry` for `CadrePeer`, `execWrite` → `lockedWithRetry`
  otherwise — and the bare `this.db!.exec` inside the `mutateCadrePeer` body is correct
  (the lock is not re-entrant). No self-deadlock path.
- **Retry safety.** The locked body is one statement: atomic and re-runnable, as
  `withWriteLock` requires. A CHECK failure is not retried — `isRetriableControlWriteFailure`
  is an allowlist over specific transactor/coordinator messages, so a refused reap surfaces
  immediately rather than after three backoffs.
- **Guard read.** `queryStampId` is the raw reader (deliberately unfiltered by `Revocation`),
  which is the only correct choice here: the filtered readers drop exactly the rows a reap
  targets, so a filtered guard would make the method a permanent no-op.
- **Not firing the guarded-delete listener is correct**, not an omission: that seam queues a
  tombstone for re-issue, and a reap files no tombstone. The reasoning was undocumented —
  now stated in the jsdoc (below).
- **`OwnerKey` has no reap-exclusion comment in the schema**, unlike `Strand`. Deliberate on
  review: `OwnerKey` has no separate `AuthorizedDelete` sitting beside the three that gained
  the branch, so there is no site where a reader would wonder where it went; the
  `REAPABLE_TABLES` jsdoc already states why it is out. Left alone rather than adding churn
  to both schema copies.
- **DRY.** The delete-SQL overlap with `deleteGuardedRow` is two lines with different
  context and WHERE clauses; extracting it would obscure more than it saves.
- **Source hygiene.** `control-database.ts` measured at 2397 lines
  (`wc -l packages/cadre-core/src/control-database.ts`) — large but unchanged in character
  by this ticket (+82 lines), and no existing size ticket is open against it. Not filed:
  a split of this file is a decision about the whole class, not a consequence of this diff.

### Minor — fixed in this pass

- **`docs/STATUS.md:766` was stale.** The lint-coverage note said the `no-restricted-syntax`
  exemption covers "the two constraint fixtures" and named two specs; `eslint.config.mjs`
  gained a third in this diff. Updated to three, naming `control-revocation-reap.spec.ts`.
- **`REAPABLE_TABLES` had no declaration-site type check.** A typo in that literal array
  would only have surfaced later, at the `GUARDED_KEY_COLUMN[table]` index. Added
  `satisfies readonly RevocableTable[]`.
- **Missing coverage: the branch's `TableName` clause was unpinned.** `RowKey` had a test
  (wrong-RowKey tombstone) and `StampId` had one (owner re-seat), but nothing proved the
  third equality. `CadrePeer` and `DeviceToken` share their key column (`PeerId`), so a
  tombstone naming one is shaped exactly like a tombstone naming the other. Added
  *"a tombstone filed against ANOTHER table does not authorize a reap"* to the positive
  suite: seat a `DeviceToken`, file a `CadrePeer`-table tombstone at the same `(rowKey,
  stamp)`, reap the `DeviceToken` → refused, row intact.
- **Undocumented reasoning: why a reap needs no re-replication.** Every other guarded delete
  has a while-alone durability story; a reap has none and needs none. Added to the jsdoc —
  every other node either already lacks the row or holds the same committed tombstone and
  reaps its own copy.

### Major — none filed, with reason

Nothing in the diff resolves at a single code site that needs to change. The gaps the
handoff was honest about (two assertions accepting either of two constraint names; the reap
clause not being independently isolable from `RevocationRecorded`; the post-guard race
returning `true` without proof of removal) were each re-derived and are correct as
described — pinning the exact reported constraint name would couple the suite to the
engine's deferred-constraint ordering, and the strict single-name pins are already carried
by the same-transaction tests. The one behavior this ticket cannot prove — the reap crossing
a real network — is blocked upstream on
`tickets/blocked/control-db-cross-node-convergence-halted.md`, which the sweep ticket
already records; not re-filed.

### Tripwire — parked, not ticketed

- **Reap delete vs. a concurrent owner re-seat on another node.** The delete is keyed on the
  primary key and its `StampId` predicate is evaluated where the statement runs, so if a
  reap on node A ever has to reconcile against an owner re-seat of the same key that landed
  on node B, which one wins is decided by the collection's merge order rather than by this
  clause. Unreachable today (nothing drives a reap) and the same ordering question the
  owner-signed delete path already carries. Parked as a `NOTE:` in the `reapRevokedRow`
  jsdoc naming the site and `tickets/blocked/forked-control-collection-sync-livelocks.md`.
  Not appended to the sweep ticket: that ticket's connectivity gate and stamp-mismatch
  cases already cover the local half, and this half is not something the sweep's author can
  resolve without upstream merge semantics.

### Validation

- `npx vitest run test/control-revocation-reap.spec.ts test/control-schema-drift.spec.ts` —
  **11/11 green** (10 reap tests, including the new cross-table one).
- `npx vitest run test/control-revocation-reap.spec.ts test/control-schema-drift.spec.ts
  test/control-authorization-domain-separation.spec.ts` — **19/19 green**.
- Blast radius `npx vitest run test/control-membership-hub.spec.ts
  test/device-token-registry.spec.ts test/validation-key-enrollment.spec.ts
  test/strand-unpublish.spec.ts test/control-revocation-replay.spec.ts` — **80 passed, 1
  failed**. The single failure is
  `control-revocation-replay.spec.ts > "a tombstone is permanent — delete refused, and update
  may move only the counter"` with `context.OwnerKey isn't a column`, byte-for-byte the
  entry already listed in `tickets/.pre-existing-known.md` (owned by
  `10-control-revocation-reissue-test-fixes`, blocked on
  `10-revocation-reissue-same-pk-update-unique-collision`). Not re-triaged, not touched, not
  re-reported.
- `yarn workspace @serfab/cadre-core build` — exit 0. Root `yarn lint` — exit 0.
