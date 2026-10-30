description: The phone-link scenario now measures each attempt at the joiner's first write on its own, and that measurement shows the slower seating since 1.16 comes from the commit's own requests timing out on a saturated link, not from anything Sereus adds. Review the scenario change that records this.
architecture: docs/strands.md
files: packages/integration-tests/src/scenarios/strand-workload-on-a-phone-link.integration.ts (`measuredWindow`, `measureWindow`, `reportWindow`, `withProgress`, `seatJoiner`, `seatParties`, `FIRST_SYNC_MS`, the `seats both parties` arm, the "Running it" section and the 2026-10-30 header block), docs/testing.md (the strand-workload paragraph), tickets/blocked/decide-link-deadlines-from-measured-response-time.md (last section)
repro: verified
----
## What was found (fix stage)

Reported in gotchoices/sereus#48: on the phone-shaped link, the joiner's seat write took 188 s on 1.19.0 and seating 220 s, against 108-110 s in total on 1.16.0.

- The seat is a commit to both members, on 1.20.1 and on 1.16.0 alike (every attempt failed `Failed to get super-majority: 1/2 approvals`; so did the 2026-10-17 run on 1.16.0). The slower seat is not the seat having stopped committing alone.
- Nothing in Sereus delays it: the seat's first cluster transaction started 0.07 s after the joiner became writable.
- The time goes inside the commit: requests abandoned to Optimystic's 10.5 s response deadline and retried, on a socket carrying 80 s of frames at the cap. That is the case `blocked/decide-link-deadlines-from-measured-response-time` covers, and the numbers went there as evidence. No new upstream report.
- Not separated: the joiner's 16 read-repair consults and the membership reconciler's join commit share the link with the seat from its first moment.

The full table (two runs on a machine at about 60% CPU from other work) is in the scenario header's 2026-10-30 block.

## The scenario change

Landed with the fix-stage commit (`d6b1f8de`); this stage tidied it.

- Each attempt at the joiner's seat transaction, and the wait for the seat to reach the founder, is a measured window (`measuredWindow`): deadline events by `debug` namespace, frames on the link, streams opened, reported when the window ends, failed or not. The rounds use the same counts (`measureWindow` / `reportWindow`).
- A per-minute progress line covers the seat windows as well as rounds (`withProgress`).
- The phone arm has a no-op test, `seats both parties`, so `-t 'seats both parties'` runs only the seating in `beforeAll`. It is not a behaviour test; it exists so vitest has a test to run the hook for. Opt-in with the rest of the phone arm.

This stage's edits:
- Window labels carry their own article, so reports read "during B's seat attempt 1", "during the wait for B's seat on A", "during the rounds" (were "during the B's seat, attempt 1"). The attempt-failed log line uses the same "B's seat attempt N" wording.
- `measureWindow` and `reportWindow` take the `MeasuredStrands` fixture instead of its separate fields.
- Header "Running it": the progress line and the swallowing of debug lines now say they apply to every measured window, not only the rounds.
- `FIRST_SYNC_MS`'s comment was stale ("seating has taken 100-165 s"). It now gives 100-220 s for seating and up to 340 s for one failed attempt, and says the setup hook's 900 s timeout ends seating during the third or fourth of the 4 allowed attempts on the slowest runs. The value is unchanged.
- `docs/testing.md`'s paragraph on this scenario said it counted "over the rounds alone"; it now names the seat windows and the `-t 'seats both parties'` run.

## Validation run here

- `yarn workspace @serfab/integration-tests typecheck`: clean.
- `yarn eslint` on the scenario file: clean.
- Loopback arm (`yarn workspace @serfab/integration-tests exec vitest run strand-workload-on-a-phone-link`): passed. The seat opened 7 cluster streams and was written in 0.4 s; the wait for it on A opened none; seated 0.8 s after joining; 8 rounds in 0.8 s; converged at once. Phone arm skipped (unset `STRAND_WORKLOAD_PHONE`).

No test was added: the change is measurement and reporting in an existing scenario.

## Known gaps

- The phone arm was not re-run at this stage: one seat attempt takes about 4-5 minutes and 4 are allowed, more than one agent command allows. The 2026-10-30 rows come from a loaded machine; a human run of `STRAND_WORKLOAD_PHONE=1 DEBUG='optimystic:*,libp2p:connection-monitor*' yarn workspace @serfab/integration-tests exec vitest run strand-workload-on-a-phone-link -t 'seats both parties'` on a quiet machine would add the quiet-machine row.
- The setup hook's timeout (`FIRST_SYNC_MS`, 900 s) can end seating before the fourth attempt on the slowest runs. Left as is: setup fails either way, and raising it only lengthens a run that is already failing. A reviewer may prefer a separate, longer hook timeout.
- On loopback every window prints all 15 deadline-event rows even with `DEBUG` unset (all zero), so the loopback output is about 40 lines longer than before. Kept for a uniform report shape.
- Whether the read-repair consults or the reconciler's join commit are a large share of the seat's 53 cluster streams was not measured.
