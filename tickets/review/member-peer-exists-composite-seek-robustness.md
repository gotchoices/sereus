description: The "is this device already registered for this member?" check no longer depends on a lookup that can silently miss on a networked strand, so re-registering the same device quietly does nothing instead of adding a duplicate row.
files: packages/cadre-core/src/strand-membership-writer.ts, packages/cadre-core/test/strand-membership-peer-rotation.spec.ts, packages/integration-tests/src/scenarios/strand-membership-closed-strand-e2e.integration.ts
difficulty: medium
----

## What changed

`memberPeerExists()` (private, `strand-membership-writer.ts`) previously ran:

```sql
select count(1) as Count from Strand.MemberPeer where MemberKey = ? and PeerId = ?
```

`Strand.MemberPeer`'s primary key is `(MemberKey, PeerId)`, so that puts an equality on
**both** key columns. The optimystic virtual-table module treats a full-primary-key equality
as fully handled and serves it as a single-key point lookup (one `find` descent); the SQL
engine adds no filter of its own because the module claimed the predicate. On a networked
strand that descent is not reliable — a miss returns zero rows for a row that provably
exists, the guard answers `false`, and `registerMemberPeer` re-inserts.

It now runs:

```sql
select MemberKey, PeerId from Strand.MemberPeer where MemberKey = ?
```

— a predicate on only the **leading** key column. The same module explicitly declines to
handle a partial primary-key match, so it falls through to a table scan and the SQL engine
applies `MemberKey = ?` itself. No seek, so no seek can miss. **Both** columns are then
re-compared in JavaScript, so correctness depends only on the scan returning a *superset*
of matching rows. The `where` clause is a size optimization, not a correctness dependency.

The fallback the plan authorised (dropping `where MemberKey = ?` entirely and filtering
wholly in JS) was **not** needed and was **not** taken — see "Honest gaps" for why that is
less well-evidenced than it sounds.

Also updated: `registerMemberPeer`'s doc comment no longer claims an "insert-if-absent on
the composite PK"; it points at `memberPeerExists` and its rationale.

## What to test / validate

**Unit — `packages/cadre-core/test/strand-membership-peer-rotation.spec.ts`** (bootstrap
mode, real strand DB via `connectToStrand`). Two tests added, both passing:

- *"re-registering ONE of a member's peers skips only that peer"* — founder registers
  `peer-phone` + `peer-laptop` (count 2), re-registers `peer-phone` → resolves, count still
  2; then registers `peer-tablet` → count 3. The guard's scan walks the `peer-laptop`
  sibling row, so a sloppy `PeerId` comparison would false-positive here.
- *"two different members may register the SAME PeerId"* — founder registers `peer-shared`;
  a second member (admitted via `addMemberByManager`) also registers `peer-shared`. Both
  land, count 2, and a per-`MemberKey` count of 1 is asserted for **each** member (not a
  bare table count). This is the false-positive the JS `MemberKey` re-check defends against.

Existing behaviour that must keep holding (all still pass): the original re-register no-op
test, the multi-distinct-peers test, the non-member `MemberExists` rejection
(`spec.ts` "rejects registering a peer for a key with no Member row"), and the open-strand
rejection.

**Integration — `strand-membership-closed-strand-e2e.integration.ts`** step 7: a second
`registerMemberPeer(founderDb, { memberKeyPair: joinerMember, peerId: joinerPeerId })` is
asserted to resolve with `strandCount(founderDb, 'MemberPeer')` still `1`. Placed
immediately after the existing single-row assertions and **before** the impostor insert —
per that file's "rejection floor" header, a rejected write is only asserted to throw, so no
count assertion is safe after one. The stale comment that explained why the test avoided a
composite-PK lookup was replaced.

## Validation actually run

| Command | Result |
| --- | --- |
| `yarn workspace @serfab/cadre-core test` | **54 files, 755 passed, 1 skipped** |
| `yarn workspace @serfab/cadre-core test --reporter=verbose strand-membership-peer-rotation` | **17/17 passed** (both new tests named + green) |
| `yarn workspace @serfab/integration-tests test` | 26 files, 17 passed / **9 failed** — see below |
| `yarn lint` | clean |
| `yarn typecheck` | clean |

## Honest gaps — read this before signing off

**The networked assertion never executed.** This is the important one. The closed-strand
e2e scenario — the test that reproduces the original failure and the whole reason this
ticket exists — currently dies during a networked commit at strand bring-up, well before
step 7 is reached. The stack has no frame in the sereus test file at all; it is entirely
optimystic (`ClusterCoordinator.executeTransaction` → `Transaction rejected by validators
(2/2 rejected): membership-not-admitted:low-confidence-downsize`).

That failure, and all 17 integration failures in the run, are already listed in
`tickets/.pre-existing-known.md` against `control-db-convergence-optimystic-p2p`
(**blocked**), including this exact test by name (dated 2026-07-16). Per the pre-existing
rules I did **not** re-report it and did not write `.pre-existing-error.md`. Nothing was
skipped, disabled, or loosened.

Consequences a reviewer should weigh:

- The new networked no-op assertion is **written but unverified**. It is dead code until
  the blocked upstream convergence issue clears. Someone should re-run this scenario the
  moment `control-db-convergence-optimystic-p2p` lands.
- Because of that, the claim "the fallback was not needed" rests on the *unit* suite
  (bootstrap mode) plus the code-path argument about partial-PK matches — **not** on
  observed networked behaviour. If the reviewer wants stronger evidence, the fallback
  (bare `select MemberKey, PeerId from Strand.MemberPeer`, filtered wholly in JS) is still
  the correct move and costs only scan size.
- Also note the scenario file's `-- <pattern>` filter did not take through
  `yarn workspace ... test --`; the full integration suite ran instead (~67s). Not a
  blocker, but don't assume a scoped run happened.

**Upstream is unfixed and untracked.** The plan ticket named an upstream ticket
`optimystic-networked-composite-pk-seek-unreliable`; it **does not exist** on optimystic's
board (every stage folder plus `complete/` checked at plan stage). This change makes Sereus
*independent* of the unreliable seek — it does not fix the seek. Any future code that
point-looks-up a full composite primary key on a networked strand has the same exposure.
I grepped for other full-composite-PK lookups on `MemberPeer` across `packages/`: there are
none. Other tables were not audited.

**Concurrency is unchanged and still unguarded.** Check-then-insert is not atomic; two
nodes registering the same `(MemberKey, PeerId)` concurrently can both observe "absent".
The primary key is the real backstop. No test covers this and none was added — the guard
exists for the sequential restart / re-register path only.

## Tripwires parked in code

Three `NOTE:`-tagged comments at `memberPeerExists` in
`packages/cadre-core/src/strand-membership-writer.ts`:

- **Cost** — the guard scans one member's peers per `registerMemberPeer` call. Fine at
  member × devices scale; if `MemberPeer` ever grows large per member, the fix is a reliable
  composite-key seek, not a bigger scan.
- **Fragility** — if a secondary index on `MemberPeer.MemberKey` is ever added, this query
  stops being a scan and becomes an index seek, re-introducing the exact seek dependency
  this change removes.
- **Race** — check-then-insert is not atomic (as above).

## Review findings
