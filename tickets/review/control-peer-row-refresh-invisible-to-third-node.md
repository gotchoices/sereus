description: Housekeeping-only pass that closes out a previously flaky test failure — a machine reading a stale copy of a newcomer's network address — now that the real fix has landed in the sibling storage library and stayed green across eleven test runs. This updates the tracking file and code comments to say the failure is fixed instead of expected.
files: tickets/.pre-existing-known.md, packages/integration-tests/src/harness/control-trio.ts, packages/integration-tests/src/scenarios/control-write-degraded-cohort-member.integration.ts, packages/integration-tests/src/scenarios/control-divergent-repair-yardstick.integration.ts, tickets/backlog/debt-control-trio-boot-wait-is-contention-sensitive.md
difficulty: easy
----

# Boot-gate timeout closed upstream — bookkeeping retired

No behaviour changes. This ticket edits only comments and ticket-tracking prose: one tracking file (`tickets/.pre-existing-known.md`), three code-comment blocks, and one backlog ticket. No production or test code changed.

## What this closes

Three integration scenarios (`control-cohort-edge-carries-data`, `control-cohort-three-node-isolation`, `control-write-degraded-cohort-member`) start three machines (A, B, C) and wait up to 45s for B to read C's signed network-address record from the shared `CadrePeer` member-directory table. That wait timed out intermittently. Traced cause: B learned the table had changed but re-read the changed data from its own slightly-stale disk copy and cached that stale copy in memory with nothing to invalidate it. Two upstream tickets in the sibling `../optimystic` storage library fixed this, both landed at commit `03ffadc4`:

- `refreshed-collection-caches-a-block-older-than-its-log-entry` — a stale answer is no longer accepted into the in-memory copy.
- `a-too-old-block-answer-is-retried-against-another-machine` — that detection retries against a different machine instead of failing.

## Evidence (see the ticket's original text and `tickets/.pre-existing-known.md`'s newest delta for full detail)

| scenario | runs | result |
| --- | --- | --- |
| `control-cohort-edge-carries-data` | 6 (5 isolated + 1 fix-build) | 6/6 passed |
| `control-cohort-three-node-isolation` | 6 (5 isolated + 1 fix-build, 2 tests each) | 6/6 passed |
| `control-write-degraded-cohort-member` | 1 (fix-build; doesn't share the harness) | 7/7 tests passed |

Fix-build runs were against `../optimystic` `6e8efecd` (`03ffadc4` + two ticket-only commits) after rebuilding `@serfab/cadre-core`'s stale `dist`. Not covered: an earlier, different self-publish boot wait ("C self-publishes its CadrePeer record") — its rate was never measured here and is called out explicitly wherever the closed fingerprint is discussed, so nobody mistakes this for "the whole boot sequence is fast now."

## What changed, file by file

- **`tickets/.pre-existing-known.md`** — added a new top delta declaring the fingerprint CLOSED (a recurrence on optimystic `03ffadc4`+ is now a regression, to be reported via `tickets/.pre-existing-error.md`); removed the fingerprint from the "Open" table and the three per-file "Open" list entries; consolidated them into one "Resolved in place" entry carrying the mechanism, the two upstream tickets, and the run counts; folded the 2026-08-11 re-attribution history into that same entry; updated a cross-reference in the (already-complete) `control-read-queues-behind-a-write-waiting-for-the-database` entry to note "(closed 2026-09-17)".
- **`control-trio.ts`** — replaced the `NOTE:` above the step-6 wait (previously describing the failure as expected/upstream-blocked) with a comment stating what the wait proves and that a timeout now is a regression, not an intermittent.
- **`control-write-degraded-cohort-member.integration.ts`** — removed the closed fingerprint's row from this file's own copy of the fingerprint table (which states `tickets/.pre-existing-known.md` is authoritative) and added a matching `CLOSED 2026-09-17` note, in the same style as the existing stream-reset closure note.
- **`control-divergent-repair-yardstick.integration.ts`** — updated the "Why two nodes and not three" header paragraph: 2 of its 3 cited failure fingerprints are now closed (this one, and `content-digest-mismatch` resolved 2026-09-09); the third (a *different* boot wait, "C self-publishes its CadrePeer record") is still unmeasured, and the paragraph now says that explicitly instead of naming a closed/nonexistent ticket. The three-node variant was **not** restored — that's out of scope here and still gated on the unmeasured wait.
- **`tickets/backlog/debt-control-trio-boot-wait-is-contention-sensitive.md`** — appended a dated note: the third of the wait's three documented outcomes (B never recovers) is closed by the same upstream fix; the second outcome (~10s spent in Optimystic's read-repair window on a healthy run) was not measured and any redesign of the wait should still be judged against the post-fix distribution. Replaced a `blocked/...` path reference with the bare slug since this ticket is headed to `complete/` (which eventually prunes).

## Verification performed

- `yarn lint` — exit 0.
- `yarn workspace @serfab/integration-tests typecheck` — exit 0.
- Re-ran both `bootControlTrio`-based scenarios in isolation to confirm the comment-only edits didn't regress anything:
  - `control-cohort-edge-carries-data.integration.ts` — 1/1 passed.
  - `control-cohort-three-node-isolation.integration.ts` — **1 of 2 tests failed**, see "Known gap" below.

## Known gap for the reviewer

The optional confirmation re-run of `control-cohort-three-node-isolation.integration.ts` hit a **different, unrelated failure**: `is load-bearing: without a reconcile pass B never reaches C, and one pass forms the link` failed with `expected [] to include '<peerId>'` at line 179 (`dialsToC.openingPass()?.dialed`). This is not the fingerprint this ticket closes (it's about which reconcile pass the test harness attributes a dial to, not about reading a stale address record), this ticket never touches that scenario file, and the same test passed cleanly the same day against the same fix build (log: `tickets/.logs/control-peer-row-refresh.confirm-control-cohort-three-node-isolation.log`). This file is independently documented throughout `tickets/.pre-existing-known.md` as boot/dial-race flaky. Logged per the pre-existing-failure protocol in `tickets/.pre-existing-error.md` (new file) rather than chased here — a triage agent should pick it up. If it turns out to recur reliably, it needs its own ticket; don't assume my one red run is a rate.

## Left alone on purpose (see the original ticket text for full reasoning)

- `packages/cadre-core/src/cadre-node.ts`'s `resolvePeerAddrs`/`registerSelf` debug logging — already correct, not touched.
- `tickets/blocked/forked-control-collection-sync-livelocks` — a separate defect (a write-side fork/livelock), not this ticket's read-side stale-cache mechanism; not re-run or edited.
- Older dated deltas in `tickets/.pre-existing-known.md`, `tickets/.garden-report.md`, and tickets already in `complete/` that mention this slug as history — left as the historical record they are.
- Two other open tickets that mention this slug in passing (`tickets/fix/secondary-index-seek-blind-to-sibling-rows.md`, `tickets/blocked/report-dependency-floor-bump-to-embedding-app.md`) — other agents' tickets, not edited.

## For the reviewer to check

- The `tickets/.pre-existing-known.md` edits are prose/bookkeeping only — worth a read-through to confirm the "Resolved in place" entry accurately reflects the removed "Open" entries and that no other place still calls this fingerprint "blocked" or "in tickets/blocked/".
- Confirm the `control-divergent-repair-yardstick.integration.ts` header paragraph reads correctly given it now names an unmeasured (not closed) condition as the revisit gate for restoring the three-node variant.
- Decide whether the newly surfaced `is load-bearing…` flake in `control-cohort-three-node-isolation.integration.ts` needs anything beyond the `.pre-existing-error.md` entry (e.g. a repeat-run series) before this ticket is archived.
