description: Make the "is this device already registered for this member?" check reliable on a networked strand, so re-registering the same device quietly does nothing instead of adding a duplicate row or failing.
files: packages/cadre-core/src/strand-membership-writer.ts, packages/cadre-core/test/strand-membership-peer-rotation.spec.ts, packages/integration-tests/src/scenarios/strand-membership-closed-strand-e2e.integration.ts
difficulty: medium
----

## Decision (settled at plan stage — do not re-open)

**Make the guard robust on its own.** Replace the composite-primary-key point lookup in
`memberPeerExists()` with a scan the storage layer can actually serve, and compare both key
columns in JavaScript. Do **not** wait on an upstream platform fix.

Why this option and not "rely on the upstream fix":

- The upstream ticket the plan ticket named (`optimystic-networked-composite-pk-seek-unreliable`)
  **does not exist** on optimystic's board — checked every stage folder plus `complete/`. Nothing
  in optimystic's recent history touches the point-lookup path
  (`git log packages/quereus-plugin-optimystic/src/optimystic-module.ts` → the last four commits are
  hydrate-unique, unique-probe, statistics-remove, ordering-claim-guard). So there is no landing
  date to rely on.
- Correctness of an insert-if-absent guard should not be gated on another repo's roadmap; the
  scan-based guard is correct whether or not the seek is ever fixed, and is strictly cheaper to
  reason about.

## Why the current query is unreliable, concretely

`memberPeerExists()` today runs
(`packages/cadre-core/src/strand-membership-writer.ts:519-527`):

```sql
select count(1) as Count from Strand.MemberPeer where MemberKey = ? and PeerId = ?
```

`Strand.MemberPeer`'s primary key is `(MemberKey, PeerId)`
(`packages/quereus-plugin-sereus/src/strand-schema.ts:130-142`), so **both** primary-key columns
carry an equality predicate. In the optimystic virtual-table module that trips the
`fullPkEquality` branch of `getBestAccessPlan`
(`../optimystic/packages/quereus-plugin-optimystic/src/optimystic-module.ts:1993-2022`): the module
reports the filters as *handled*, advertises a primary-key seek, and the read is dispatched to
`executePointLookup` (`optimystic-module.ts:601-624`), which builds one encoded key and does a
single `read.find(key)` descent. The SQL engine adds no filter of its own — it trusted the module.
So if that descent misses on a networked strand, the query returns **zero rows for a row that
provably exists**, `memberPeerExists` answers `false`, and `registerMemberPeer` re-inserts.

Contrast a predicate on only the **leading** key column:

```sql
select MemberKey, PeerId from Strand.MemberPeer where MemberKey = ?
```

That is a *partial* primary-key match, which the same function routes to its
"`bestHandledFilters = request.filters.map(() => false)`" branch
(`optimystic-module.ts:2023-2033`) — i.e. the module explicitly declines to handle the predicate,
falls through to `executeTableScan`, and the SQL engine applies `MemberKey = ?` itself over the
scanned rows. No seek is involved, so no seek can miss. The closed-strand e2e already relies on
plain scans of `Strand.MemberPeer` working on a networked strand
(`strand-membership-closed-strand-e2e.integration.ts:289-292`), so this path is empirically fine.

Comparing **both** columns in JS on top of that makes the guard depend only on the scan returning a
*superset* of the matching rows — the weakest possible assumption about the storage layer.

## Target shape

```ts
/**
 * True iff a `MemberPeer` row already exists for this `(MemberKey, PeerId)`.
 *
 * Deliberately does NOT filter on the full composite primary key ... (explain per above)
 */
async function memberPeerExists(db: Database, memberKey: string, peerId: string): Promise<boolean> {
  for await (const row of db.eval(
    'select MemberKey, PeerId from Strand.MemberPeer where MemberKey = ?',
    [memberKey],
  )) {
    if (row.MemberKey === memberKey && row.PeerId === peerId) {
      return true;
    }
  }
  return false;
}
```

Points the implementation must preserve:

- The `where MemberKey = ?` stays — it is a size optimization, not a correctness dependency. Both
  columns are re-checked in JS so a dropped or mis-applied predicate cannot produce a false
  positive (e.g. a *different* member that registered the same `PeerId`).
- Keep it a single-purpose private function in the same file; do not generalise it into a shared
  helper — the existing `strandTableCount` (bare counts) and `scalarCount`
  (`strand-member-registry.ts:172`) stay as they are.
- Update `registerMemberPeer`'s doc comment: the "insert-if-absent on the composite PK" sentence
  (`strand-membership-writer.ts:484-487`) now describes a scan-and-filter guard.

## Tripwire comments to leave at the site (`NOTE:` tagged, greppable)

- Cost: the guard scans the peers of one member per `registerMemberPeer` call. Fine at
  member × devices scale; if `MemberPeer` ever grows large per member, revisit — a reliable
  composite-key seek would be the fix, not a bigger scan.
- Fragility: if a secondary index on `MemberPeer.MemberKey` is ever added, this same query stops
  being a scan and becomes an index seek (`executeIndexScan`), re-introducing the seek dependency
  this change removes.
- Race: check-then-insert is not atomic. Two nodes registering the same `(MemberKey, PeerId)`
  concurrently can both observe "absent". The primary key is the real backstop; this guard exists
  for the sequential restart / re-register path, not for concurrency.

## Edge cases & interactions

The implementer must cover these; the reviewer will check for them.

- **Re-register the same `(MemberKey, PeerId)`** — no throw, row count unchanged. This is the
  behavior the whole ticket exists to pin. Must hold in **both** bootstrap mode (cadre-core spec)
  and networked mode (integration e2e).
- **Multi-device**: a member with two distinct `PeerId`s. Re-registering one of them must skip only
  that one; the sibling row is untouched and a *third*, new `PeerId` still inserts. The scan returns
  sibling rows, so an incorrect JS comparison would false-positive here.
- **Same `PeerId` under two different members**: member A and member B both register peer `P`. B's
  registration must **not** be skipped because A already has `P` — this is the false-positive the
  JS `MemberKey` re-check defends against. Expected end state: two rows.
- **Empty table / member with no peers**: guard returns `false`, insert proceeds.
- **Non-member key** (no `Strand.Member` row): guard returns `false`, the insert is then rejected by
  the deferred `MemberExists` check and `registerMemberPeer` throws. Existing test at
  `strand-membership-peer-rotation.spec.ts:138-148` already pins this — it must keep passing.
- **Open strand** (`Type='o'`, no `Member` rows can exist): unchanged rejection.
  `strand-membership-peer-rotation.spec.ts:191-201` pins it.
- **Rejected-write leakage in the e2e**: per that file's header "rejection floor", a rejected write
  is only asserted to throw — post-state is not asserted to have rolled back. So any *count*
  assertion must run **before** the impostor insert at
  `strand-membership-closed-strand-e2e.integration.ts:297-308`, never after it.
- **Bootstrap vs networked parity**: the guard runs against the same `Database` API in both modes;
  no mode-conditional code. If the networked assertion fails, the fallback is to drop the
  `where MemberKey = ?` clause entirely (bare `select MemberKey, PeerId from Strand.MemberPeer`,
  filtered wholly in JS) — same reliability argument, larger scan. Take that fallback rather than
  reintroducing any seek.

## Expected test outcomes

**Unit — `packages/cadre-core/test/strand-membership-peer-rotation.spec.ts`** (bootstrap mode, real
strand DB via `connectToStrand`; follow the existing `openStrand('c')` pattern):

- Existing `re-registering the same (MemberKey, PeerId) is an insert-if-absent no-op` test keeps
  passing unchanged.
- New: member registers `peer-phone` + `peer-laptop`, then re-registers `peer-phone` → resolves,
  `MemberPeer` count stays `2`; then registers `peer-tablet` → count `3`.
- New: founder registers `peer-shared`; a second member (admitted via `addMemberByManager`) also
  registers `peer-shared` → both inserts land, count `2`, and a row exists for each member key
  (assert with a per-`MemberKey` count, not a bare table count).

**Integration — `packages/integration-tests/src/scenarios/strand-membership-closed-strand-e2e.integration.ts`**
(networked mode — this is the one that reproduces the original failure):

- In step 7, immediately after the existing single-row assertions and **before** the impostor
  insert: call `registerMemberPeer(founderDb, { memberKeyPair: joinerMember, peerId: joinerPeerId })`
  a second time. Expect it to resolve (`resolves.toBeUndefined()`) and
  `strandCount(founderDb, 'MemberPeer')` to still be `1`.
- Update the stale comment at lines 284-288 that currently explains *why* the test avoids a
  composite-PK lookup — after this change the writer no longer issues one; the comment should
  instead note that the re-register no-op is now genuinely exercised on a networked strand.

## Validation

Run from the repo root, streaming output (never silent-redirect — the runner's idle timer):

- `yarn workspace @serfab/cadre-core test 2>&1 | tee /tmp/cadre-core-test.log`
- `yarn workspace @serfab/integration-tests test 2>&1 | tee /tmp/integration-test.log`
  — real libp2p, minutes-scale. If the whole suite runs long, scope it to the one scenario file
  (`... test -- strand-membership-closed-strand-e2e`) and say so in the handoff.
- `yarn lint` and `yarn typecheck` (or the per-package `typecheck` scripts for the two packages
  touched).

Pre-existing failures elsewhere: follow `tess/agent-rules/tickets.md` → *Pre-existing test failures*
(check `tickets/.pre-existing-known.md` first; never skip or loosen a test).

## TODO

### Phase 1 — writer

- Rewrite `memberPeerExists` in `packages/cadre-core/src/strand-membership-writer.ts` to the scan +
  JS-compare shape above, with a doc comment explaining why the full composite-key predicate is
  avoided.
- Add the three `NOTE:` tripwire comments (cost, secondary-index fragility, check-then-insert race).
- Refresh `registerMemberPeer`'s doc comment where it describes the guard.

### Phase 2 — tests

- Extend `packages/cadre-core/test/strand-membership-peer-rotation.spec.ts` with the multi-device
  re-register test and the shared-`PeerId`-across-two-members test.
- Extend step 7 of `strand-membership-closed-strand-e2e.integration.ts` with the networked
  re-register no-op assertion, placed before the impostor insert; update the stale composite-PK
  comment.

### Phase 3 — validate + hand off

- Run the unit suite, the integration scenario, lint, and typecheck; capture real output.
- Write the `review/` handoff: state explicitly whether the networked re-register assertion passed
  on the first run, and whether the fallback (dropping the `where MemberKey = ?` clause) was needed.
  Note that the upstream optimystic composite-key seek remains unfixed and untracked on that repo's
  board — this change makes Sereus independent of it, it does not fix it.
