description: Added and reviewed a test where two people, each with two machines, share one workspace across all four machines — writes replicate everywhere, a write still commits with one machine switched off, and the returning machine catches up.
files: packages/integration-tests/src/scenarios/strand-two-party-two-machine.integration.ts, packages/integration-tests/src/harness/strand-join.ts, packages/integration-tests/src/scenarios/strand-late-cadre-join.integration.ts, packages/quereus-plugin-sereus/src/cluster-size.ts, docs/testing.md
----

# Complete: two parties × two machines, one strand across all four

The integration suite now runs a strand at four machines — the configured replication
breadth (`DEFAULT_STRAND_CLUSTER_SIZE = 4`) — with two parties of two machines each. This
is the first scenario that can switch a machine off and still expect a write to commit.

## What landed

- **`packages/integration-tests/src/scenarios/strand-two-party-two-machine.integration.ts`**
  (new, 454 lines, one narrative `it`, 420 s explicit timeout, `vitest.config.ts` untouched):
  1. Write on a[0] → raw-store coverage on a[1], b[0], b[1], then visibility on all four
     databases. Coverage always gated before any cross-machine database read (the probe
     rule in `harness/block-store-probe.ts` — a read through a node can pull blocks into
     it and mask a replication gap).
  2. Write from b[1] — a non-founding machine of the non-founding party — same gating.
  3. 20 interleaved writes (5 rounds × 4 machines, read-then-write, never `Promise.all`
     across writers) converging to identical row sets on all four databases.
  4. a[1]'s whole `CadreNode` stopped, live peers observed dropping it, then a write on
     b[0] commits, inside a bounded 90 s retry that separates the known upstream
     lost-conflict flake from a genuine cannot-commit-degraded regression.
  5. A new `CadreNode` on a[1]'s key and storage capture rejoins, re-dials the live strand
     nodes, and the block it missed lands physically in its own store before anything is
     read through it.
- **`harness/strand-join.ts`**: `connectStrandNodes` and the `StrandLibp2p` type alias
  exported (no behaviour change) so a scenario can re-dial a restarted machine with the
  same both-sides-settled contract the mesh step uses.
- **`docs/testing.md`**: topology coverage map updated — four-machine cross-party shape now
  points at the scenario; membership-from-a-second-machine stays listed as uncovered
  against the sibling ticket `scenario-two-by-two-strand-membership`.
- **`packages/quereus-plugin-sereus/src/cluster-size.ts`**: `DEFAULT_STRAND_CLUSTER_SIZE`'s
  copies/approvals reasoning now points at the scenario that exercises it, and says
  precisely what that scenario does and does not measure.

## Review findings

Reviewed against the implement-stage diff (`53f9157`) first, then the handoff. Every
finding below was resolved in this pass; the review filed no new tickets, for the reason
given under *Major*.

### Fixed in this pass (minor)

- **The header overstated what phase 4 proves.** It read as "a write commits on
  `ceil(4 × 0.75) = 3` approvals, so exactly one holder may be away". Nothing in the file
  reads the coordinator's cohort, and the phase deliberately waits for the live peers to
  drop the dead connection first — which makes a cohort downsized to the three live
  machines (committing unanimously, 3-of-3) at least as likely as a 3-of-4 commit. The
  outcome claim is sound; the mechanism claim was not asserted. Header, the phase-4
  comment, and the `docs/testing.md` line now state the outcome and name both shapes as
  undistinguished.
- **The catch-up gate could have passed vacuously.** Phase 5's `awaitBlockCoverage(b0 →
  a1)` only proves a[1] *ends up* covered; nothing showed it was ever behind. Added a
  `compareBlockCoverage` assertion at the end of phase 4, taken while a[1] is off and its
  store therefore frozen, requiring the gap to be non-empty. It fires with real content on
  every run (`behind: [<2 blocks> source rev 23 > target rev 22]`), so phase 5 now asserts
  a catch-up rather than a state.
- **Bring-up cost off by an order of magnitude.** The header justified one narrative test
  with "each bring-up of this shape costs ~80-120 s", extrapolated from the per-machine
  rule of thumb; the implementer's own logs measured 6.6 s. Replaced with the measured
  figure (the one-test decision stands on phase interdependence, which is the real
  reason). The 420 s timeout comment claimed the same fictitious arithmetic; it now says
  what it actually protects — the worst case the internal budgets permit, ~18× the
  observed 19-24 s.
- **A read failure inside the retry could swallow the insert error.** `insertWithRetry`'s
  catch called `readDataRows` unguarded; a throw there would replace the insert error the
  caller needs with an incidental read error and abort a retry budget that had time left.
  Extracted `rowLanded`, which logs and answers "not known to have landed".
- **Four repeated non-null-asserted handle constructions plus a tuple cast.** Replaced with
  a `strandMachine(label, capture, strandId, instance)` helper that throws a named error
  instead of asserting, so a harness regression says what broke rather than surfacing as
  `Cannot read properties of undefined` several phases later.
- **Duplicated type alias.** `strand-late-cadre-join.integration.ts` still declared its own
  `StrandLibp2p`; it now imports the harness one this ticket exported.
- **Stale docs back-reference.** `docs/testing.md`'s `multi-party-sync` line pointed at
  "the first uncovered class below" — a class this ticket just covered. Repointed at the
  new line.
- **Delivery mechanism asserted in a comment.** Phase 5's comment named the peer-join
  backfill as "the mechanism under test"; the scenario cannot tell it from ordinary
  replication after the re-dial, and the handoff admits as much. Comment now matches.

### Major — none filed, one instance appended as evidence

The cohort-width blindness under the first finding is the one thing that would justify a
ticket, and it is the Nth instance of a class already owned by
`backlog/debt-strand-write-breadth-observed-end-to-end` (whose `files:` already names
`cluster-size.ts`). Per the architecture-first rule that is evidence, not a new ticket: a
second-case section was appended there explaining that the same missing fixture is what
keeps a degraded commit unattributable. Also refreshed
`backlog/debt-replication-proof-above-cohort-size`, whose "what is covered today" claimed
the at-or-below-breadth case was proven only at two machines — it is now proven at four,
which is the cap itself, so that ticket is down to its above-four half.

No correctness defect was found in the scenario logic, the harness export, or the teardown
path. Specifically checked and clean: phase ordering against the probe rule (no database
read precedes any coverage gate it could contaminate); the restart's identity and storage
reuse (`captureRawStorage` memoizes per scope, so the returning node reaches the same
backend — the claim would be vacuous otherwise); double-stop of a[1] (`stopStartedNodes`
catches per node, so the early stop is safe to repeat); the restarted node living outside
the topology's started list and being stopped explicitly first; and the absence of a
watcher race on rejoin (the strand row is never published, so nothing can discover it
behind the explicit `addStrand`).

### Tripwires (recorded at the site, not filed)

- `waitForRowConvergence` re-scans every machine's whole table each 500 ms poll —
  `machines × rows` reads. Free at 22 rows (75-124 ms to converge). `NOTE:` at the helper
  says what to do if a future scenario reuses it on a large table.
- Phase 5 uses b[0]'s store as the stand-in for "everything the strand holds", which is
  true only because at breadth four with four machines every machine covers every block.
  `NOTE:` at the gate says to widen the source to a union of the live stores if a later
  phase ever writes blocks that legitimately do not reach b[0].
- `insertWithRetry`'s retry and read-back branches have still never executed — the degraded
  write committed on attempt 1 in ~210-250 ms on all five runs to date. `NOTE:` on
  `DEGRADED_WRITE_BUDGET_MS` records that the 90 s figure is headroom rather than measured
  need, so nobody shrinks it on the strength of the fast runs.

### Considered and left alone

Phases 1-3 insert without the retry wrapper, deliberately: outside the degraded phase a
failed write *is* the regression signal, and wrapping it would hide one. The existing
comment already scopes the wrapper to phase 4; no change.

## Validation

- `yarn lint`: clean. Repo-root `yarn typecheck`: clean (304 test files in the type-check
  programs, 0 allowlisted). `yarn build`: clean.
- `strand-two-party-two-machine.integration.ts`: three review-stage runs, all green
  (17.1 s, 20.0 s, 18.2 s), the last on the final tree.
  `strand-late-cadre-join.integration.ts` (edited for the type-alias dedupe): one run,
  3 tests green. Together with the implement stage's two runs that is five green runs of
  the new scenario; the suite's physical-replication tests have a flakiness history, so
  read that as no observed flake rather than as a flakiness measurement.
- Logs: `tickets/.logs/4-scenario-two-by-two-strand-core.review1.log`, `.review2.log`.

## Still out of scope

NAT/relay strand reachability, networks above four machines, holder-count assertions
(`debt-replication-proof-above-cohort-size`, `debt-strand-write-breadth-observed-end-to-end`),
and membership actions from a second machine (`scenario-two-by-two-strand-membership`,
in `implement/`).
