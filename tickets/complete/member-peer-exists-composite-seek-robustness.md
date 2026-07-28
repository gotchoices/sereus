description: The "is this device already registered for this member?" check no longer depends on a database lookup that can silently come back empty on a networked strand, so re-registering the same device quietly does nothing instead of adding a duplicate row.
files: packages/cadre-core/src/strand-membership-writer.ts, packages/cadre-core/test/strand-membership-peer-rotation.spec.ts, packages/integration-tests/src/scenarios/strand-membership-closed-strand-e2e.integration.ts, docs/architecture.md
difficulty: medium
----

## What shipped

`memberPeerExists()` (private, `packages/cadre-core/src/strand-membership-writer.ts`) used to
ask the database for exactly the row it cared about:

```sql
select count(1) as Count from Strand.MemberPeer where MemberKey = ? and PeerId = ?
```

`Strand.MemberPeer`'s primary key is `(MemberKey, PeerId)`, so that is an equality on **both**
key columns. The optimystic virtual-table module treats a full-primary-key equality as fully
handled and serves it as a single point lookup (one tree descent); the SQL engine adds no
filter of its own, so whatever the descent returns *is* the result. On a networked strand that
descent has been observed to miss — zero rows for a row that provably exists — so the guard
answered "absent" and `registerMemberPeer` inserted a duplicate.

It now asks for the member's rows and decides in JavaScript:

```sql
select MemberKey, PeerId from Strand.MemberPeer where MemberKey = ?
```

A predicate on only the leading key column is a *partial* primary-key match, which the same
module explicitly declines to handle (verified in
`../optimystic/packages/quereus-plugin-optimystic/src/optimystic-module.ts`, `getBestAccessPlan`
— the partial branch sets every handled-filter flag to `false`). It falls through to a table
scan with the SQL engine applying `MemberKey = ?` itself. No seek, so no seek can miss. Both
columns are then re-compared in JavaScript, so correctness rests only on the scan returning a
*superset* of matching rows.

Two tests were added in `packages/cadre-core/test/strand-membership-peer-rotation.spec.ts`
(multi-device re-register; two members sharing one `PeerId`), and the networked scenario
`strand-membership-closed-strand-e2e.integration.ts` gained a re-register no-op assertion in
step 7, placed before the first rejected write.

## Review findings

### Checked

Implement diff read first, before the handoff. Verified the central claim against the actual
optimystic source rather than taking the handoff's word for it: the `fullPkEquality` branch
does mark all primary-key equality filters handled and dispatch a point lookup, and the
partial-match branch does set `bestHandledFilters` to all-`false`, so the new query genuinely
lands on a scan. Confirmed `Strand.MemberPeer`'s primary key is `(MemberKey, PeerId)` and
`Strand.ConsumedInvite`'s is `InviteKey` alone (so the registry's `where MemberKey = ?` read
of that table was never a point lookup). Swept `packages/` for other lookups of the same
shape. Re-read the tests for the edge cases the plan named. Read `docs/architecture.md` and
`docs/strands.md` against the new reality. Ran lint, typecheck, the cadre-core suite, and the
integration suite.

### Fixed in this pass (minor)

- **Cost comment was wrong about what the scan costs.** The `NOTE:` at `memberPeerExists`
  said the guard "scans one member's peers per call". It does not — the whole point of the
  change is that the module *declines* the predicate, so the storage layer walks the entire
  `MemberPeer` table (every member's rows) and the SQL engine filters afterwards. The stated
  growth trigger was correspondingly wrong ("if MemberPeer grows large *per member*" → it is
  total table size that matters). Comment rewritten; the doc comment's "the `where` clause is
  a size optimization" now says plainly that it trims only what crosses into JavaScript.
- **`docs/architecture.md` was stale in two places**, neither touched by the implement
  commit. The `registerMemberPeer` bullet still described the write as "insert-if-absent on
  the composite PK `(MemberKey, PeerId)`" — the exact framing the change removed; it now
  describes the leading-key scan and why. The end-to-end coverage paragraph still said the
  composite point-lookup quirk was "worked around in-test rather than asserted"; it now
  records that the writer no longer issues such a lookup, that the scenario asserts the
  networked re-register no-op, and — flagged with a warning — that the assertion has not yet
  executed.

### Filed as a new ticket (major)

- **The unreliable lookup itself is unfixed and untracked, and nobody has checked who else
  uses it.** → `tickets/backlog/debt-composite-pk-point-lookup-unreliable-untracked.md`.
  The handoff was candid that this change makes sereus *independent* of the bad lookup rather
  than fixing it, but stopped at "other tables were not audited". Audited them: there are no
  remaining full-*multi*-column primary-key lookups in `packages/` (the one two-column
  equality, `FormationUsage where Token = ? and StrandId = ?` in
  `strand-formation-consent.spec.ts`, is a partial match against that table's `(Token,
  UseNumber)` key, so it scans). But a *single*-column primary key with an equality satisfies
  "every key column has an equality" too and takes the identical code path — and those are
  ordinary and widespread, including `isMemberRegistered`
  (`strand-member-registry.ts:164`, `select count(1) from Strand.Member where Key = ?`) and
  several control-database reads. Evidence points to the bug being multi-column-key specific
  (single-column primary-key reads in the very same networked scenario were observed working),
  which is why this is filed as an audit rather than as a live bug — but that has never been
  confirmed, and the ticket exists to confirm it once instead of guessing per call site.

### Recorded as tripwires, not tickets

The three `NOTE:`-tagged comments the implementer parked at `memberPeerExists` are the right
disposition and were kept (one reworded, above): the scan's cost, the fact that adding a
secondary index on `MemberPeer.MemberKey` would silently turn this scan back into a seek, and
the check-then-insert race. All three are "fine now, only matters if X". No new tripwires
were added — the concerns this pass turned up were either factual errors (fixed) or a real
untracked defect (ticketed).

### Deliberately not changed

- **Concurrency.** Check-then-insert is not atomic and two nodes can both observe "absent";
  the primary key is the real backstop. This is unchanged from before the ticket, is documented
  in a `NOTE:`, and adding a test for it would require driving two concurrent writers against
  one strand — out of scope for a guard that exists for the sequential restart path.
- **The comment volume at `memberPeerExists`.** Roughly twenty lines of doc plus notes on a
  ten-line function is heavy, and I considered trimming it. Kept: every line explains *why the
  obvious query is wrong*, which is exactly the knowledge a future reader will otherwise
  destroy by "simplifying" this back into a point lookup.

### Not verified — carried forward

**The networked assertion still has not run.** The closed-strand end-to-end scenario dies at
strand bring-up (`Transaction rejected by validators (2/2 rejected):
membership-not-admitted:low-confidence-downsize`, raised inside optimystic's
`ClusterCoordinator.executeTransaction`) long before step 7. That failure and every other
integration failure in this run are already listed in `tickets/.pre-existing-known.md` against
`control-db-convergence-optimystic-p2p` (**blocked**), this scenario by name — so per the
pre-existing-failure rules it was not re-reported and `.pre-existing-error.md` was not written.
Nothing was skipped, disabled, or loosened. Consequence, unchanged from the handoff and now
also recorded in `docs/architecture.md`: the no-op is pinned only by bootstrap-mode specs, and
someone should re-run this scenario the moment that blocked issue clears.

## Validation

| Command | Result |
| --- | --- |
| `yarn lint` | clean (exit 0), before and after the review edits |
| `yarn typecheck` | clean (exit 0) |
| `yarn workspace @serfab/cadre-core test` | 54 files, **755 passed**, 1 skipped |
| `yarn workspace @serfab/cadre-core test --reporter=verbose strand-membership-peer-rotation` | **17/17 passed** after the review edits, both new tests green |
| `yarn workspace @serfab/integration-tests test` | 26 files, 17 passed / **9 failed** (17 tests failed) — all 9 files appear in `tickets/.pre-existing-known.md` under blocked `control-db-convergence-optimystic-p2p`; identical set to the implement run |
