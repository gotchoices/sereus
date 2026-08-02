description: The test helpers that pin a fixed set of machines for a shared write were widened to accept a second kind of node, and the one existing test that uses them with the original kind still cannot be run green — not because of anything in this repo, but because of an already-known, already-blocked bug in a sibling library that makes the test's setup phase hang before it ever reaches the widened helpers.
prereq:
files: packages/integration-tests/src/harness/forced-cluster.ts, packages/integration-tests/src/harness/key-network-patch.ts, packages/integration-tests/src/scenarios/control-write-degraded-cohort-member.integration.ts, docs/STATUS.md, tickets/.pre-existing-known.md
difficulty: easy
----

# Close out: degraded-cohort-member scenario confirmed blocked on the known coordinator-cache bug, not on the widened helpers

## What was done this pass

Both obstacles the plan ticket named were cleared and the scenario was run for real:

1. `../quereus` now builds clean (the `catalogRowCount` TS2304 error the plan ticket
   recorded is gone — that was someone else's in-flight edit, since resolved).
2. That unblocked the suite's stale-build guard, which then flagged a **second**,
   previously-unseen stale package: `@serfab/cadre-provider`. Ran
   `yarn workspace @serfab/cadre-provider build` (exit 0).
3. Ran `yarn vitest run src/scenarios/control-write-degraded-cohort-member.integration.ts`
   from `packages/integration-tests`. Result: `beforeAll` times out —
   `Timeout waiting for B self-publishes its CadrePeer record after 45000ms` at line 368,
   ~64 s in, all 6 tests reported skipped. This is **before** the `forceFullCohort` /
   `pinCoordinator` calls (now at lines 401/406) that this ticket exists to exercise —
   same as the previously-recorded failure, just one step earlier in the same `beforeAll`.

## Root-cause match confirmed — this is NOT a new failure

`tickets/blocked/transactor-key-network-ignores-network-scoping.md` already documents this
exact scenario failing in `beforeAll` with the identical mechanism: a node that races its
own first outbound dial can elect itself coordinator for a control-DB key and cache that
self-pick for 30 minutes (bug lives in `../optimystic/packages/db-p2p/src/libp2p-key-network.ts`,
fix filed upstream as `../optimystic/tickets/fix/coordinator-cache-poisoned-by-boot-time-self-selection.md`).
That blocked ticket's "Run 4" section already recorded this scenario tripping the same gate
and listed it in `tickets/.pre-existing-known.md`. This run reconfirms it against a freshly
rebuilt `../quereus` and `@serfab/cadre-provider` — same fingerprint class, one step earlier
in `beforeAll` (self-publish wait vs. address-resolution wait), still upstream of the
widened-helper code path. `.pre-existing-known.md` has been updated in place with this
reconfirmation; no new tracking entry was needed since one already exists.

**Consequence for the widening this ticket was created to prove:** the `CadreNode` branch
of `forceFullCohort`/`pinCoordinator` and the force-then-pin teardown order remain
unproven **at runtime**, but not because of anything the widening touched — the scenario
cannot get past its own three-node bootstrap regardless of which node type is forced. The
widening itself is proven by other means: it type-checks and lints clean, and the new
`control-cohort-harness-helpers.integration.ts` scenario (12/12 passing) exercises every
other branch of the shared `harness/key-network-patch.ts` guard, including the
out-of-order-restore throw that this scenario's `afterAll` also relies on
(`forced?.restore()` after `pinned?.restore()`).

## docs/STATUS.md corrected

The entry for this scenario was marked `[x]` with a claimed ~185 s runtime. Changed to
`[ ]` with a short note pointing at the blocked ticket and stating the design/coverage
prose is otherwise accurate and was last observed green pre-regression. Do not revert this
without a green run backing it — the "last observed green" claim is a fact about the past,
not a guess.

## Edge cases & interactions

- **Do not chase the `beforeAll` timeout in this ticket.** It is owned by
  `blocked/transactor-key-network-ignores-network-scoping`; the fix must land in
  `../optimystic` first. Re-running this scenario before that lands will reproduce the
  same failure — that is expected, not a regression to investigate.
- **If `../optimystic` gets rebuilt with the upstream fix before this ticket is picked
  up**, re-run the scenario fresh. If it now passes, that also validates the `CadreNode`
  widening at runtime — update this ticket's TODO accordingly and fold the confirmation
  into the review handoff rather than opening a new verification ticket.
- **Both `../quereus` and `@serfab/cadre-provider` can go stale independently** between
  runs (this pass hit both, in sequence, on the same suite) — the stale-build guard only
  reports the ones it currently sees, not all of them at once, so a clean run needs both
  checked, not just the one the guard first complains about.

## TODO

- Confirm `docs/STATUS.md` and `tickets/.pre-existing-known.md` edits from this pass are
  present and read correctly (no further code change expected).
- Hand off to `review/` with an honest account: widening's static coverage (typecheck,
  lint, `control-cohort-harness-helpers.integration.ts` 12/12) is solid; the `CadreNode`
  runtime path stays unproven, blocked on an upstream fix outside this repo, and that is
  the ticket's actual finding rather than a gap in the implementer's work.
