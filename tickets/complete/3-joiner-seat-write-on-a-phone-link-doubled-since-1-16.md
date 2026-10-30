description: The phone-link scenario now measures each attempt at the joiner's first write on its own, and that measurement shows the slower seating since 1.16 comes from the commit's own requests timing out on a saturated link, not from anything Sereus adds.
architecture: docs/strands.md
files: packages/integration-tests/src/scenarios/strand-workload-on-a-phone-link.integration.ts, docs/testing.md, tickets/blocked/decide-link-deadlines-from-measured-response-time.md
repro: verified
----
## What was found

Reported in gotchoices/sereus#48: on the phone-shaped link, the joiner's seat write took 188 s on 1.19.0 and seating 220 s, against 108-110 s in total on 1.16.0.

- The seat is a commit to both members, on 1.20.1 and on 1.16.0 alike (every attempt failed `Failed to get super-majority: 1/2 approvals`). The slower seat is not the seat having stopped committing alone.
- Nothing in Sereus delays it: the seat's first cluster transaction started 0.07 s after the joiner became writable.
- The time goes inside the commit: requests abandoned to Optimystic's 10.5 s response deadline and retried, on a socket carrying 80 s of frames at the cap. That is the case `blocked/decide-link-deadlines-from-measured-response-time` covers; the numbers went there as evidence. No new upstream report.
- Not separated: the joiner's read-repair consults and the membership reconciler's join commit share the link with the seat from its first moment.

The full table is in the scenario header's 2026-10-30 block.

## What changed

In `strand-workload-on-a-phone-link.integration.ts`:
- Each attempt at the joiner's seat transaction, and the wait for the seat to reach the founder, is a measured window (`measuredWindow`): deadline events by `debug` namespace, frames on the link, streams opened, reported when the window ends, failed or not. The rounds use the same counts (`measureWindow` / `reportWindow`).
- A per-minute progress line covers seat windows as well as rounds (`withProgress`).
- The phone arm has a test, `seats both parties`, so `-t 'seats both parties'` runs only the seating in `beforeAll`. Opt-in with the rest of the phone arm.

`docs/testing.md`'s paragraph on this scenario names the seat windows and the `-t` run.

## Review findings

Read both the fix-stage and implement-stage diffs (`ticket(fix): joiner-seat-write-on-a-phone-link-doubled-since-1-16`, `ticket(implement): joiner-seat-write-on-a-phone-link-doubled-since-1-16`) before the handoff.

Checked, no defect found:
- Resource cleanup across repeated windows: each seat attempt opens and closes its own window. `countOutboundStreams().stop()` restores every wrapped `newStream` and removes its listener, `openWsFrameWindow().close()` drops its tally, and the stderr hook is restored before the report, so windows do not stack across attempts. `measuredWindow` reports in `finally`, so a failed attempt is reported and its error still reaches `seatJoiner`'s retry.
- `-t 'seats both parties'` without `STRAND_WORKLOAD_PHONE`: all three tests skipped, and the loopback arm's `beforeAll` did not run (no seating output), so the filter does not pay for loopback seating.
- `describeFrames` with no `rounds` drops the per-round figure instead of dividing by an unrelated constant (the old code divided by `ROUNDS` unconditionally).
- Docs: `docs/testing.md` matches the code. The blocked ticket's new section is consistent with the scenario header. `docs/strands.md` (the anchor) describes no test measurement and needed no change.
- Error handling: the attempt-failed log truncates the message but the last attempt rethrows the original error, so setup fails with the full cause.

Fixed in this pass (minor):
- The `seats both parties` test asserted `seated().label` equals `'phone'`, which checks a constant. It now asserts `expect(seated).not.toThrow()`, which is what the test is for: the fixture exists.
- The 2026-10-30 table's row labels used the old "B's seat, attempt N" wording; they now match the log's "B's seat attempt N", so a reader can match the table against the output.
- `withProgress`'s comment cited only the 169 s round; it now also cites the 340 s seat attempt it now covers.
- Two "Running it" lines in the header ran past the comment's wrap width; rewrapped.

Accepted as is (tradeoff recorded at the site):
- The setup hook's timeout (`FIRST_SYNC_MS`, 900 s) ends seating before the fourth of `SEAT_ATTEMPTS` on the slowest runs (up to 340 s per failed attempt plus about 36 s to writable). The constant's comment already states this. A run that needs four attempts fails setup either way, so a separate, longer hook timeout would only lengthen a failing run. Not filed.
- On loopback every window prints all 15 deadline-event rows even with `DEBUG` unset (about 40 more lines). Kept for one report shape across arms.

Tests: none added or cut beyond the `seats both parties` assertion. The change is measurement and reporting inside an existing scenario; the loopback arm exercises every new path except the phone link itself.

Validation:
- `yarn workspace @serfab/integration-tests typecheck`: clean.
- `yarn eslint` on the scenario file: clean.
- `yarn workspace @serfab/integration-tests exec vitest run strand-workload-on-a-phone-link`: loopback passed (seated 0.8 s after joining, 8 rounds in 0.7 s, converged at once); phone arm skipped (`STRAND_WORKLOAD_PHONE` unset).

Not done: the phone arm was not re-run. One seat attempt takes 4-5 minutes and 4 are allowed, longer than one agent command may run. The 2026-10-30 rows come from a machine at about 60% CPU; a quiet-machine row needs a human run of `STRAND_WORKLOAD_PHONE=1 DEBUG='optimystic:*,libp2p:connection-monitor*' yarn workspace @serfab/integration-tests exec vitest run strand-workload-on-a-phone-link -t 'seats both parties'`. Whether the read-repair consults or the reconciler's join commit are a large share of the seat's 53 cluster streams was not measured.
