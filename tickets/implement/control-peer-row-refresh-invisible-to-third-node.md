description: A bug in the sibling storage library that left one machine reading an old, address-less copy of a newcomer's entry in the shared member directory has been fixed there, and the affected tests now pass every time. What is left is housekeeping in this repo — the known-failures file and three code comments still tell readers this failure is expected, and they need to say it is closed.
files: tickets/.pre-existing-known.md, packages/integration-tests/src/harness/control-trio.ts, packages/integration-tests/src/scenarios/control-write-degraded-cohort-member.integration.ts, packages/integration-tests/src/scenarios/control-divergent-repair-yardstick.integration.ts, packages/cadre-core/src/cadre-node.ts, tickets/backlog/debt-control-trio-boot-wait-is-contention-sensitive.md
difficulty: easy
repro: no longer reproduces — 0 failures in 11 isolated runs of each affected scenario at optimystic 03ffadc4
----

# The boot-gate timeout is closed upstream; retire its bookkeeping here

No behaviour changes in this ticket. It edits one tracking file, three code comments and one backlog ticket. No test should change its result because of it.

## Background, for a reader who has not seen this before

Three integration scenarios start three machines: A (the owner), B and C. C joins last and writes its network address into its own row of the shared `CadrePeer` table, which is the member directory. The scenarios then wait up to 45 seconds for B to read C's signed address ("the boot gate"). That wait timed out intermittently with `Timeout waiting for B resolves C's signed CadrePeer address record after 45000ms`.

The traced cause was in `../optimystic` (the storage library this repo runs from its built `dist`): B learned from A that the table had two new revisions, re-read the changed block from its own disk copy — still one revision behind, and inside a 10-second window in which the storage layer answers from disk without asking other machines — and kept that old content in memory with nothing to invalidate it. B therefore kept reading the row A wrote when it admitted C (peer id, no address, no signature) and correctly refused it.

Two upstream tickets closed this, both landed by optimystic commit `03ffadc4`:

- `refreshed-collection-caches-a-block-older-than-its-log-entry` (`94553aba` / `0fc40ac5`) — a block answer older than the change-log entry that prompted the read is no longer accepted into the in-memory copy.
- `a-too-old-block-answer-is-retried-against-another-machine` (`12eb8412` / `61747f60`) — that detection becomes a retry against a different machine rather than a failure.

## Evidence that it is closed

All runs were one scenario file per fresh process, counted by the positive marker `Tests  N passed`, never by the absence of a failure string, with the stale-build guard passing.

| scenario | runs | result |
| --- | --- | --- |
| `control-cohort-edge-carries-data.integration.ts` | 5 (unblock pass) + 1 (fix pass) | 6 passed / 0 failed |
| `control-cohort-three-node-isolation.integration.ts` | 5 + 1 | 6 passed / 0 failed (2 tests each) |
| `control-write-degraded-cohort-member.integration.ts` | 1 (fix pass) | 7 of 7 tests passed |

The fix-pass runs were on 2026-09-17 with `../optimystic` at `6e8efecd` (which is `03ffadc4` plus two commits that touch only `tickets/`), after rebuilding `@serfab/cadre-core` because its `dist` was stale. Logs: `tickets/.logs/control-peer-row-refresh.confirm-*.log` (pruned automatically). Before the fix the rate was 2 failed of 6 isolated `control-cohort-edge-carries-data` runs. Neither the timeout nor the `resolvePeerAddrs: signature verification failed … addrs=[], sig=(empty)` line that precedes it appeared in any run.

The third file matters because it does **not** use the shared `bootControlTrio` helper: it carries its own copy of the same wait (`control-write-degraded-cohort-member.integration.ts`, the `beforeAll` wait described as `"B resolves C's signed address record"`, near line 640). One run is a confirmation that the file reaches its tests, not a rate.

**Not verified, and now moot:** the earlier claim that in production a newly joined machine was undialable from one peer for minutes rather than forever. It was reasoned from the mechanism and never measured.

## Settled during the fix pass — no work needed

**The `resolvePeerAddrs` / `registerSelf` debug instrumentation stays.** `packages/cadre-core/src/cadre-node.ts` prints `updatedAt`, the address count and a 16-character signature prefix on the signature-failure path (about line 2496) and on both `registerSelf` success paths (about lines 2192 and 2229). It is `debug`-namespace logging (`sereus:cadre:node`), off unless asked for, and prints only public replicated data. The comment already above the failure-path log line explains what the fields distinguish (a row still at the owner's vouch revision versus a corrupt or mixed-revision row). That is sufficient; do not add to it and do not remove it. `resolvePeerAddrs` returns `[]` from five different gates, and this line is the only thing that says which one rejected.

**`blocked/forked-control-collection-sync-livelocks` is a separate defect and this fix does not move it.** Checked against that ticket's own text and the upstream board: its symptom is a *write* that fails with `SyncRetryExhaustedError` / `SyncRevisionStalledError` in `control-delete-while-alone-convergence` after two machines have committed different histories of one table; its unblock condition is upstream forward progress on a fork, which is still only in optimystic's backlog (`feat-refresh-can-demand-a-revision-floor`). This ticket's symptom was a *read* served from a stale in-memory copy where all three machines agreed on the history. That ticket does not name this slug, so nothing in it needs editing. It was not re-run here.

## What to change

### `tickets/.pre-existing-known.md`

This file is a dated log. Its convention for closing a fingerprint is: add a new delta at the top of "Open" saying the fingerprint is closed and that older entries attributing failures to it are superseded, move the per-file list entries to "Resolved in place", and leave the older dated deltas as the historical record they are. Follow that; do not rewrite history further down the file.

The current-state references that need editing (line numbers as of this writing):

- **Line 11**, the "New fingerprint, not yet owned by a ticket" paragraph (`A.resolvePeerAddrs(B)` returning `[]` in round 4 of `control-write-degraded-cohort-member`). It names this slug as one of two *candidate* explanations. Reword, do not delete: this slug's mechanism is closed upstream as of `03ffadc4`, so a recurrence on a build at or after that commit is not explained by it. Keep the other candidate (`control-write-refused-when-a-rival-write-holds-the-block`, which has since moved from `blocked/` to `fix/` — refer to it by slug without a folder) and keep the advice to run with `DEBUG='sereus:cadre:node,sereus:cadre:control-db'`. Worth stating: round 4 ran against an optimystic working tree that contained the *uncommitted, in-progress* version of this very fix, so that run says nothing either way about the finished fix.
- **Line 30**, the fingerprint-owner table row `"7 skipped", Timeout waiting for B resolves C's signed address record`. Remove the row and extend the "CLOSED — leave it off this table" sentence under the table to cover it, in the same form as the stream-reset fingerprint.
- **Line 37**, the 2026-09-17 delta that says the boot-gate timeout "has a traced cause, and it is upstream … now in `tickets/blocked/`". Leave the text; the new top delta supersedes it. If a one-clause pointer ("closed — see the newest delta") is added, keep it to that.
- **Lines 534, 535 and 537**, the three list entries `… → control-peer-row-refresh-invisible-to-third-node | blocked | 2026-09-17`. Remove them from "Open" and add one "Resolved in place" entry covering all three files, stating: the fingerprint, the traced mechanism in two or three sentences, the two upstream tickets and commit `03ffadc4`, and the run counts from the table above. The "earlier note" attached to the line-535 entry (that `beforeAll` sometimes trips one step earlier, on `Timeout waiting for B self-publishes its CadrePeer record after 45000ms`) describes a *different wait* that this work did not measure — carry that sentence into the resolved entry as "not covered by this verification" rather than dropping it.
- **Line 536**, the already-`complete` entry for `control-read-queues-behind-a-write-waiting-for-the-database`, names this slug as the owner of "the boot gate" among the original report's other fingerprints. Add "(closed 2026-09-17)" after the slug; change nothing else.
- **Lines 539 onward**, the "Re-attributed 2026-08-11" block quote, refers to "the three boot-gate entries above". Once those entries move, either move this quote with them or change "above" so it still points at something.

The new top delta should say plainly: a recurrence of this timeout on optimystic `03ffadc4` or later is a **regression, not a known failure**, and should be reported through `tickets/.pre-existing-error.md`.

### `packages/integration-tests/src/harness/control-trio.ts`

Replace the `NOTE:` block above the step-6 `waitUntil` (lines 354–361) with a statement of what the gate proves. Suggested wording — adjust freely, keep the content:

```
// What this proves beyond the signature checks: C cannot reach B, so C's
// address revisions commit on C and A only, and B must learn from another
// machine that the row changed and then obtain content at least that new.
// Optimystic once let B satisfy that read from its own older replica and keep
// the result in memory indefinitely (fixed in optimystic 03ffadc4). A timeout
// here on a later build is a regression to report, not a known intermittent.
// Do not widen the timeout — the wait measures propagation.
```

The existing three-line step-6 header comment above it (the signed path: record present, key binding, self-signature, freshness, trust policy) stays.

### `packages/integration-tests/src/scenarios/control-write-degraded-cohort-member.integration.ts`

The header comment holds a second copy of the fingerprint-owner table (about lines 132–143) and says `tickets/.pre-existing-known.md` is authoritative. Remove the `"7 skipped"` / `control-peer-row-refresh-invisible-to-third-node` row and add a short `CLOSED 2026-09-17` note alongside the existing one for the stream-reset fingerprint, so the two copies agree.

### `packages/integration-tests/src/scenarios/control-divergent-repair-yardstick.integration.ts`

The "Why two nodes and not three" header section (about lines 39–61) justifies shipping a two-node scenario by pointing at three failure fingerprints "on tracked, human-blocked tickets (`control-peer-row-refresh-invisible-to-third-node`)" and ends "Restore the three-node variant when that family is green." Two of the three fingerprints are now closed: this boot gate, and `content-digest-mismatch` (resolved 2026-09-09, recorded under "Resolved in place"). The third — the boot wait `C self-publishes its CadrePeer record` timing out at 45 s — was not measured by this work. Update the paragraph to say exactly that, so the stated revisit condition names the one thing still unknown instead of a ticket that no longer exists. Do not restore the three-node variant in this ticket.

### `tickets/backlog/debt-control-trio-boot-wait-is-contention-sensitive.md`

Two passages point at this slug as living in `blocked/` (the "What NOT to do" paragraph, and the "Evidence added 2026-09-17" section, whose last sentence says any redesign of the wait "should be measured after the upstream fix lands"). Append a short dated note: the upstream fix landed at optimystic `03ffadc4`; the third outcome described there (B never recovers) is closed; whether the roughly 10-second second outcome still occurs was not measured. Replace the `blocked/…` path with the bare slug, since the ticket will be in `complete/` and later pruned. Do not otherwise re-scope that ticket.

## Left alone on purpose

- Older dated deltas in `tickets/.pre-existing-known.md`, `tickets/.garden-report.md`, and tickets already in `complete/` mention this slug as history. They are records of what was believed on that date; leave them.
- `tickets/fix/secondary-index-seek-blind-to-sibling-rows.md` and `tickets/blocked/report-dependency-floor-bump-to-embedding-app.md` mention this slug in passing. They are other agents' open tickets; leave them.
- Control writes being allowed to commit on a reduced set of machines (`packages/quereus-plugin-sereus/src/cluster-size.ts`) is why C's update can land without B. That is deliberate and was never the defect.

## TODO

- Edit `tickets/.pre-existing-known.md` as specified: new top delta, fingerprint-table row removed, line-11 paragraph reworded, three "Open" entries replaced by one "Resolved in place" entry, line-536 annotation, and the "Re-attributed 2026-08-11" quote kept pointing at something real.
- Replace the `NOTE:` above step 6 in `control-trio.ts`.
- Bring the fingerprint table in the `control-write-degraded-cohort-member` header comment into agreement with the known-failures file.
- Update the "Why two nodes and not three" paragraph in `control-divergent-repair-yardstick.integration.ts`.
- Append the dated note to `tickets/backlog/debt-control-trio-boot-wait-is-contention-sensitive.md`.
- Run `yarn lint` and `yarn workspace @serfab/integration-tests typecheck` — comment-only edits, but the lint gate is strict about formatting.
- Optional, if time allows: one more isolated run each of the two `bootControlTrio` scenarios after the edits, counted by the `Tests  N passed` marker, to confirm nothing but comments changed.
