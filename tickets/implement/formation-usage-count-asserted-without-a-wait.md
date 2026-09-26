description: A two-machine test about invitation use counts occasionally fails for a reason that is the test's own doing: it waits for one copy of the data to catch up between machines, then immediately demands that a second copy already agree, without waiting for that one. Fix the test so a slow catch-up fails only after it has really run out of time, and so that when it does fail it says enough to tell a slow machine apart from a broken one.
architecture: docs/testing.md
files:
  - packages/integration-tests/src/scenarios/strand-formation-concurrent-redemption.integration.ts (`assertRowsMatchApprovals` final count assertion ~325; case 2 over-admission arm ~420; case 3 `waitUntil` ~462 — the shape to copy)
  - packages/cadre-core/src/control-database.ts (`countFormationUsage` doc comment ~2998; `assertSeatRemains` ~2898)
  - packages/cadre-core/src/control-formation-recorder.ts (`isTokenUsed` ~91)
  - schemas/control.qsql (`FormationUsage.Authorized` cap clause — the `FI.TotalUses > (select count(1) from committed.FormationUsage …)` line)
  - docs/testing.md (new convention paragraph)
repro: verified
difficulty: medium
----

# The seat-cap count is asserted without the wait the same file gives it elsewhere

## What is wrong

`assertRowsMatchApprovals` waits up to `CONVERGE_MS` (30 s) for one node's view of the `FormationUsage` **table** to contain every approved joiner's row, and then, in the next statement, hard-asserts that the **index-backed count** already equals that row count:

```ts
expect(await db.countFormationUsage(token), `${label}: countFormationUsage agrees with the row scan`).toBe(rows.length);
```

The table and the `FormationUsageByToken` index are two separate collections in the storage engine, with separate logs and independent catch-up between machines — which is the whole reason `readUsageRows` in this file deliberately reads the table with no `where` clause, so that the two sides of this equality do not share the structure under test. So the assertion compares a value that was waited for against a value that was not. Nothing makes the second one ready at the moment the first one becomes ready.

The same file already knows this. Case 3 wraps the identical quantity in a wait:

```ts
await waitUntil(async () => (await db.countFormationUsage(token)) === case2ApprovedKeys.length, { timeoutMs: CONVERGE_MS, … });
```

Case 1 (through `assertRowsMatchApprovals`) and case 2's over-admission arm do not. The file contradicts itself about whether this count is eventually consistent, and the two places that treat it as immediate are the two places that have failed.

**Second arm, same site: the failure cannot be classified.** When the count disagrees the assertion throws at once, so the sibling node's view is never read. But `countFormationUsage`'s own doc comment and this scenario's file header both tell the reader that a failure means index convergence has regressed *if it fails on both views* — and a per-view assertion can only ever fail on the first view. The evidence the documentation says to read is evidence this assertion structure cannot produce. The row-scan path in the same function already does it right: its timeout handler calls `describeView` on both nodes and reports each one's row list and count before throwing. The count path needs the same treatment.

That gap is what made the observation on 2026-09-25 cost a full measurement pass and still not settle anything. The message was `expected 1 to be 2` and nothing else — no sibling view, and no indication whether the count later caught up.

**Third arm, documentation: the comment that frames a short count as a security defect is wrong about where the cap is enforced.** `control-database.ts` ~2998 says:

> this count IS the seat cap (`enforceFormationUseCap`), so an under-report admits a seat the invitation never paid for

`enforceFormationUseCap` does not exist anywhere in this repository — `grep -rn enforceFormationUseCap packages` finds only this comment. And the authoritative cap is not this read. It is the deferred `Authorized` CHECK in `schemas/control.qsql`:

```sql
and (FI.TotalUses is null or FI.TotalUses > (select count(1) from committed.FormationUsage U where U.Token = new.Token))
```

evaluated against the committed snapshot at commit time, by the validating cohort. Every caller of `countFormationUsage` is a **permissive pre-check** that runs ahead of it:

- `assertSeatRemains` — its own comment already states the safe direction: a spurious empty result "only costs the attempt its NAMED exhaustion error, reverting it to today's generic `Authorized` refusal — never a seat the invite does not have".
- `ControlFormationUsageRecorder.isTokenUsed` — a short count reports the token not-used, so the redemption proceeds to the CHECK, which decides.
- `hasOutstandingFormationInvite` — a short count holds the stranger-admission door open slightly longer; not a correctness break.

A transiently short count therefore cannot admit a seat past `TotalUses`. The index's convergence *does* still gate the cap, because the CHECK's own count is served by the same index — but it gates it at commit-time evaluation on the cohort, not through `countFormationUsage`. The comment needs to say that, because as written it tells the next reader that any short count is a live over-admission, which is what turned one intermittent test failure into a defect report.

None of this makes a *permanently* short count acceptable. That fingerprint — the index sub-collection sitting one revision behind on the sibling machine, each copy matching only the entry that machine wrote — is the 2026-08 defect recorded on `tickets/backlog/debt-composite-pk-point-lookup-unreliable-untracked` and closed upstream by optimystic's `a-commit-over-a-gapped-base-forks-the-block`. A bounded wait still fails on it, after 30 s, and with a far better message than today's.

## What was measured

All against the linked sibling workspaces, sereus `7cdc2dc9`, on 2026-09-26. Stale-build guard green on every run.

**The failure did not reproduce in 73 runs.**

| measurement | runs | short counts seen |
|---|---|---|
| isolated, all 3 cases | 1 | 0 |
| 6-way parallel, all 3 cases, 4 rounds | 24 | 0 |
| 16-way parallel, case 1 only, 3 rounds, `DEBUG=optimystic:db-p2p:coordinator-repo*` | 48 | 0 |

Every run was instrumented: the count was sampled immediately after the row scan converged, and on any disagreement the probe polled both the count and the scan every 250 ms for 25 s to record whether it caught up. It never disagreed once. `cluster-fetch:peers-silent` — the line a cohort read prints when a peer's answer arrives after the per-peer deadline — appeared zero times in all 48 loaded runs, so a cohort read timing out under CPU load is not the mechanism.

**A sequential probe shows no lag at all.** A throwaway scenario booted the same two-node pair, published a 4-use invite, ran one redemption through A and then one through B, both fully awaited, then polled both nodes' table scan and index count every 100 ms. Both nodes reported `scan=2, count=2` on the **first** sample, 63 ms after the second redemption returned (`tickets/.logs/formation-usage-count.sequential-probe.log`). So the write path leaves both machines' table and index agreeing; only the concurrent path, where one of the two commits has to rebase, could differ.

**It is not a published-versus-linked code difference.** The observation came from `yarn check:published`, which drops `resolutions` and installs the siblings from npm, so the natural suspicion was that published 1.5.1 lacks a fix the linked tree has. It does not:

- Published `@optimystic/*` 1.5.1 is linked-tree commit `889466a8` (`chore: release v1.5.1`). The only code commit after it in the linked tree is `59553a38`, which adds the `clusterPolicy.cohortQueryTimeoutMs` operator field and, per its own ticket, leaves the defaults unchanged at 1000 ms per peer and 5000 ms per pass — so an unconfigured node, which is every node here, behaves identically.
- Published `@quereus/quereus` 4.20.0 is linked-tree HEAD `14f16432b` exactly.

So the two environments are the same code, and the difference that produced the failure is timing, not version.

**The full-suite reproduction is deferred, not skipped.** The only environment that has produced this is a whole-suite run (61 integration files, about 312 tests, sequential). That is well past the roughly ten-minute ceiling for work inside a ticket, and 16-way parallel load — far heavier CPU contention than a sequential suite — did not reproduce it, so repeating the suite is unlikely to be the cheap way to learn more. The bounded wait plus the both-views diagnostic is what turns the *next* occurrence into a classified observation instead of another measurement pass. If it recurs after this lands, the trace to capture is optimystic's `DEBUG=optimystic:quereus-plugin:module`, whose `index:seek` line prints `arm=`, `rev=`, `main_rev=`, `matched=` and `node=`; comparing the two machines' `rev=` for the index collection against their `main_rev=` is what distinguishes a one-revision lag from a converged index.

## What this does not claim

It does not claim the index regressed. One sample at one instant cannot tell a catch-up window from permanent blindness, and the 2026-09-17 close-out of that upstream defect stands. It also does not claim the index is slower to converge than the table — nothing measured here shows that, and the sequential probe shows them converging together.

## Do

- Give the count assertion in `assertRowsMatchApprovals` the same bounded wait the row scan has: poll `countFormationUsage` against `rows.length` up to `CONVERGE_MS`, at the same 250 ms interval. Reuse `waitUntil`, as case 3 does — do not invent a second waiting helper.
- On timeout, throw a message that carries **both** nodes' scans and counts, the way the row-scan path's `describeView` already does, plus how long the count stayed short. That is the message the file header and `countFormationUsage`'s comment promise a reader.
- Keep the measurement visible on a pass: when the count is not already equal on the first read, log how long it took to catch up. A pass that silently absorbs a 20 s catch-up is how a slow-index regression would hide; printing the delay keeps it in the run output. Do not add an assertion on the delay — there is no measured baseline to set a threshold against.
- Apply the same wait to case 2's over-admission arm (`countFormationUsage(token) > totalUses` on both nodes; `totalUses` is 1 there, so it needs the count to have reached 2). It has the identical unwaited exposure and would fail with a different-looking message, `expected 1 to be greater than 1`.
- Leave case 3 alone — it already waits, and its post-refusal re-assertions sit behind that wait.
- Correct the `countFormationUsage` doc comment: drop the reference to the non-existent `enforceFormationUseCap`, name the `Authorized` CHECK clause in `schemas/control.qsql` as the authoritative cap, say that every caller here is a permissive pre-check whose short read cannot admit an unpaid seat, and keep the part that matters — that the CHECK's own count is served by `FormationUsageByToken`, so index convergence still gates the cap at commit time. Keep the standing instruction not to weaken the scenario's assertions.
- Check `ControlFormationUsageRecorder.isTokenUsed`'s comment and `hasOutstandingFormationInvite`'s for the same overstatement while you are there; correct only what is actually wrong.
- Add one paragraph to `docs/testing.md` stating the convention this ticket is an instance of: an integration assertion about a quantity that has to travel between machines is made through a bounded wait, and its timeout message carries every machine's view, not only the one that failed. This is the part with no single code site, which is why it goes in the document.
- Run the scenario file and confirm it is green. A few parallel rounds are cheap — an isolated run is 19 s — and worth doing to confirm the new wait does not change the pass path.
