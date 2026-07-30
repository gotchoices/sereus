----
description: When three people set up a shared data session together, one of them never receives the first row of data the others wrote. The test gives up after fifteen seconds.
prereq: bug-control-db-rx-record-never-converges-on-sender
files: packages/integration-tests/src/scenarios/strand-formation-e2e.integration.ts, packages/cadre-core/src/strand-instance-manager.ts, ../optimystic/packages/db-p2p/src/repo/coordinator-repo.ts
difficulty: hard
----

# Three-party strand formation: data never replicates to the third party

## Failing test

```
packages/integration-tests/src/scenarios/strand-formation-e2e.integration.ts
  > E2E Strand Formation > Phase 2: Strand instance lifecycle
  > should form a strand with three parties
```

## Error output

```
Error: Timeout waiting for data replicates to Bob after 15000ms
```

## Provenance and verification status

Reported by a prior tess pass as one of 6 failures in a whole-suite
`yarn vitest run` from `packages/integration-tests` (5 files failed / 24 passed). Judged
pre-existing there: the pass's diff touched only the control-DB stale-revision classification path
in `../optimystic/packages/db-p2p` (`cluster-coordinator.ts`, `coordinator-repo.ts`), which this
scenario does not exercise, and both `db-core` (1267 passing) and `db-p2p` (1436 passing) unit
suites were green.

**Not independently re-run in the triage pass that filed this ticket** — that pass hit its token
budget after root-causing four of the six failures (three landed as a harness fix; one filed as
`bug-strand-node-relay-reservation-denied-by-membership-gate`). Stale portal-`dist` *was* ruled out
first: `src`/`dist` mtimes were verified fresh for every `link:`ed `../optimystic` and `../quereus`
package, so this is not build drift.

**First step for whoever picks this up: re-run the test and confirm it still fails at HEAD.** If it
passes, it was flaky — delete this ticket and drop its line from
`tickets/.pre-existing-known.md`.

## Root-cause hypothesis

Suspected to be the same class as `fix/bug-control-db-rx-record-never-converges-on-sender`:
control-DB replication read-path failing to converge within the waiter's budget, one reader stuck on
its own older revision. Distinct test and distinct file, so it is tracked separately rather than
folded in — but **if investigation shows one shared root cause, fold this into that ticket and
delete this file** rather than fixing twice.

Note the difference in shape worth checking before assuming the same cause: that ticket's timeout is
on a **control**-DB address-record read (`resolvePeerAddrs` via replication), whereas this one waits
on **strand**-DB row replication between formed strand instances — a different collection, cohort,
and libp2p node. It may instead be strand-cluster formation (super-majority / cohort recruitment)
rather than the control-DB read path.

## Suspect files

- `packages/integration-tests/src/scenarios/strand-formation-e2e.integration.ts` — the waiter and
  its 15s budget; identify exactly which row and which reader.
- `packages/cadre-core/src/strand-instance-manager.ts` — strand cluster/cohort construction.
- `../optimystic/packages/db-p2p/src/repo/coordinator-repo.ts` — the read/sync path implicated in
  the sibling ticket.

## Design constraints

- Do **not** raise the 15s budget to make it green — a longer wait hides non-convergence rather
  than fixing it. If the correct budget is genuinely higher, justify it from measured convergence
  time and say so in the ticket.
- Determine first whether this is the control-DB read path (shared with the prereq ticket) or
  strand-cluster formation; the two have different owners and different fixes.
- If the fix lands in `../optimystic`, rebuild the affected package(s) before re-running downstream
  consumers — sereus loads `link:`ed siblings' built `dist/`, not their `src/`.
