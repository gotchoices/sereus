description: Housekeeping-only pass that closed out a previously flaky test failure — a machine reading a stale copy of a newcomer's network address — after the real fix landed in the sibling storage library and stayed green across thirteen test runs. Updated the tracking file and code comments to say the failure is fixed instead of expected.
files: tickets/.pre-existing-known.md, packages/integration-tests/src/harness/control-trio.ts, packages/integration-tests/src/scenarios/control-write-degraded-cohort-member.integration.ts, packages/integration-tests/src/scenarios/control-divergent-repair-yardstick.integration.ts, tickets/backlog/debt-control-trio-boot-wait-is-contention-sensitive.md, tickets/blocked/report-dependency-floor-bump-to-embedding-app.md
----

# Boot-gate timeout closed upstream — bookkeeping retired

No behaviour changes anywhere. This ticket edited only comments and ticket-tracking prose.

## What this closed

Three integration scenarios (`control-cohort-edge-carries-data`, `control-cohort-three-node-isolation`, `control-write-degraded-cohort-member`) start three machines (A, B, C) and wait up to 45 s for B to read C's signed network-address record from the shared `CadrePeer` member-directory table. That wait timed out intermittently. Traced cause: B learned the table had changed but re-read the changed data from its own slightly-stale disk copy and cached that stale copy in memory with nothing to invalidate it. Two upstream tickets in the sibling `../optimystic` storage library fixed this, both landed at commit `03ffadc4`:

- `refreshed-collection-caches-a-block-older-than-its-log-entry` — a stale answer is no longer accepted into the in-memory copy.
- `a-too-old-block-answer-is-retried-against-another-machine` — that detection retries against a different machine instead of failing.

## Evidence

| scenario | runs | result |
| --- | --- | --- |
| `control-cohort-edge-carries-data` | 5 (unblock pass) + 1 (fix pass) | 6/6 passed |
| `control-cohort-three-node-isolation` | 5 + 1 | 6/6 passed (2 tests each) |
| `control-write-degraded-cohort-member` | 1 (fix pass) | 7/7 tests passed |

Thirteen isolated runs, zero reproductions. All thirteen were after the fix: the five-run sets ran against `../optimystic` at `03ffadc4` exactly, the single fix-pass runs against `6e8efecd` (`03ffadc4` plus two ticket-only commits) after rebuilding `@serfab/cadre-core`'s stale `dist`.

Not covered: an earlier, different self-publish boot wait ("C self-publishes its CadrePeer record", step 5 of `bootControlTrio`). Its rate was never measured here, and that is called out explicitly wherever the closed fingerprint is discussed.

## What changed, file by file

- **`tickets/.pre-existing-known.md`** — new top delta declaring the fingerprint CLOSED (a recurrence on optimystic `03ffadc4`+ is now a regression, to be reported via `tickets/.pre-existing-error.md`); removed the fingerprint from the "Open" table and the three per-file "Open" list entries; consolidated them into one "Resolved in place" entry carrying the mechanism, the two upstream tickets, and the run counts; folded the 2026-08-11 re-attribution history into that entry.
- **`control-trio.ts`** — replaced the `NOTE:` above the step-6 wait (which described the failure as expected/upstream-blocked) with a comment stating what the wait proves and that a timeout now is a regression.
- **`control-write-degraded-cohort-member.integration.ts`** — removed the closed fingerprint's row from this file's own copy of the fingerprint table and added a matching `CLOSED 2026-09-17` note.
- **`control-divergent-repair-yardstick.integration.ts`** — updated the "Why two nodes and not three" header: 2 of its 3 cited failure fingerprints are now closed; the third is still unmeasured and the paragraph says so. The three-node variant was **not** restored — out of scope, still gated on the unmeasured wait.
- **`tickets/backlog/debt-control-trio-boot-wait-is-contention-sensitive.md`** — dated note recording that the third of the wait's three documented outcomes is closed by the same upstream fix, while the second (roughly 10 s spent in the read-repair window on a healthy run) was not measured.

## Review findings

**Checked:** the implement diff read before the handoff summary; the triage commit that landed on top of it; every file the change touches and the adjacent sites it should have touched (`control-trio.ts` step 5, `docs/`, all open stage folders); the run-count arithmetic against its source commits; `yarn lint`; `yarn workspace @serfab/integration-tests typecheck`.

**Major — none.** Stated with a reason rather than as a shrug: the change carries no production or test code, and the closure claim it makes is sound. The mechanism is traced to two named upstream tickets, the fix commit `03ffadc4` is still an ancestor of optimystic HEAD (`348ad4e2`), and the thirteen supporting runs are all post-fix.

**Minor — four found, all fixed in this pass:**

- *The run count was wrong.* Three places said the fix was "verified over eleven isolated runs" / "0 of 11", but the evidence table in the same paragraph is 6 + 6 + 1 = **13**. The figure appears to have come from the unblock pass's 10 runs plus the one degraded-cohort run, silently dropping the two fix-pass runs. Corrected to thirteen in `tickets/.pre-existing-known.md` (twice) and `tickets/backlog/debt-control-trio-boot-wait-is-contention-sensitive.md`. An entry whose headline number contradicts its own adjacent table is exactly what makes a future reader distrust the file this ticket exists to keep trustworthy.
- *The evidence never stated the build for the two five-run sets*, only for the single fix-pass runs — so a reader could not tell whether those ten runs predate the fix, which is what the whole "closed" claim rests on. They do not: commit `b6c9210` records them against optimystic `03ffadc4` exactly. Stated explicitly in both places in `tickets/.pre-existing-known.md`.
- *A factual error introduced into `control-divergent-repair-yardstick.integration.ts`.* The rewritten header attributed the still-unmeasured self-publish wait to "this file's own `beforeAll`". That file has no `beforeAll` and never calls `bootControlTrio` — it builds its nodes inline via `controlNodeConfig`/`connectControlNodes`. The wait is step 5 of the shared `harness/control-trio.ts` boot, which the deleted three-node variant would have gone through. Reworded to name the real site, and to say plainly that the current two-node scenario never runs that boot.
- *`tickets/blocked/report-dependency-floor-bump-to-embedding-app.md` listed this slug among "specific remaining failures".* Closing this ticket made that sentence wrong, and it is human-facing text meant to be sent to an embedding app. `block-held-by-only-one-machine-is-unreadable` in the same list is also complete. Corrected, with a note to re-check the list before sending. (`blocked/` is the human inbox and is not runner-processed, so editing it is safe.)

**Conditional/speculative — one, already parked, not filed as a ticket:** `tickets/.pre-existing-known.md` now declares a recurrence of *either* boot wait a regression, but only one of the two had its rate measured. If the unmeasured "C self-publishes its CadrePeer record" wait turns out to still be flaky, that framing will produce false regression reports. This is already documented at both places a reader would meet it — the "Not covered by this verification" sentence in the resolved entry, and the yardstick header — so it needed no new comment, only this index line.

**Left alone deliberately:**

- Older dated deltas in `tickets/.pre-existing-known.md` still describe this fingerprint as living in `tickets/blocked/`. They are the historical record, and the new top delta supersedes them by blanket statement. No `blocked/<slug>` path reference survives anywhere in an open stage folder — verified by grep.
- `tickets/fix/secondary-index-seek-blind-to-sibling-rows.md` cites this slug four times, once with a now-stale "(blocked)" parenthetical. All four are *ruled-out comparisons* ("this is not the same defect as…") whose arguments do not depend on the slug being open. That ticket sits in a runner-processed stage and may be mid-flight, so the cosmetic parenthetical was not worth the edit risk.
- `packages/integration-tests/dist/` still carries the pre-edit comment text. Gitignored build output; regenerates.
- `packages/cadre-core/src/cadre-node.ts` debug logging, and `tickets/blocked/forked-control-collection-sync-livelocks` (a separate write-side defect) — both correctly identified as out of scope by the implement pass.

**The handoff's open question is already answered.** The implement pass flagged a newly surfaced flake in `control-cohort-three-node-isolation` (`expected [] to include '<peerId>'`) and logged it via `tickets/.pre-existing-error.md`. Triage commit `b4f8e1d` picked it up and **fixed the root cause in code** before this review ran: `dialsToC.openingPass()` now credits a pass only when that pass's own `dialed` names C, and `reconcile()` closes a link left by a pass that did not dial C so the next pass starts from the same disconnected state. `.pre-existing-error.md` was removed in that commit. Nothing further is owed here, and no new `.pre-existing-error.md` was written by this pass.

## Verification performed by this review

- `yarn lint` — exit 0.
- `yarn workspace @serfab/integration-tests typecheck` — exit 0.
- **Integration scenarios could not be re-run, and were not.** The stale-build guard refuses: `../optimystic` currently has eight uncommitted source edits across `db-core` and `db-p2p` from its own ticket runner working an unrelated ticket (`a-write-gives-up-while-a-rival-still-holds-the-block`, HEAD `348ad4e2`). Forcing the guard is forbidden, and building another repository's half-finished working tree would neither be valid evidence about `03ffadc4` nor safe for the agent working there. This is worth naming precisely: triage commit `b4f8e1d` changed real `bootControlTrio`/`dialsToC` behaviour *after* the implement pass's confirmation runs, so **no scenario run exists against current HEAD**. That verification belongs to the triage pass; this ticket's own edits are comment-only and cannot affect it.
