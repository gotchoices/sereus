description: The phone-link scenario now measures each attempt at the joiner's first write on its own, and that measurement shows the slower seating since 1.16 comes from the commit's own requests timing out on a saturated link, not from anything Sereus adds. Finish and check the scenario change that records this.
architecture: docs/strands.md
files: packages/integration-tests/src/scenarios/strand-workload-on-a-phone-link.integration.ts (`measuredWindow`, `measureWindow`, `withProgress`, `seatJoiner`, `seatParties`, the `seats both parties` arm, the 2026-10-30 header block), tickets/blocked/decide-link-deadlines-from-measured-response-time.md (last section)
repro: verified
----
## What the fix stage found

Reported in gotchoices/sereus#48: on the phone-shaped link, the joiner's seat write took 188 s on 1.19.0, and seating 220 s, against 108-110 s in total on 1.16.0.

- **Hypothesis 1 (the seat committed alone on 1.16.0) is ruled out.** The seat is a commit to both members on 1.20.1: every attempt failed with `Failed to get super-majority: 1/2 approvals`. It was one on 1.16.0 too, because the scenario header's 2026-10-17 block records that run's first seat failing with the same error.
- **Hypothesis 2 (the seat waits behind Sereus work) is not supported.** The seat's first cluster transaction started 0.07 s after the joiner became writable. Two other loads share the link with it from that moment: the joiner's 16 read-repair consults, started by the first-sync gate's reads, and the membership reconciler's join commit. Neither was separated from the seat's own traffic.
- **Hypothesis 3 (deadlines inside the commit) is confirmed.** In one attempt the joiner abandoned 26 cluster requests to the founder at the 10.5 s response deadline and retried them, and the founder abandoned 10 block fetches. The busiest socket carried 80 s of frames at the cap, the worst send wait observed was 31.2 s, and the attempt opened 53 cluster streams. On loopback the same seat opens 7 cluster streams and takes 0.4 s. This is the per-request deadline case `blocked/decide-link-deadlines-from-measured-response-time` covers. The numbers went there as evidence, so no new upstream report was filed.

Measured on Optimystic 1.20.1, Node 24.2.0, one Windows machine at about 60% CPU from other work (not quiet). Two runs: attempts failed after 233.4 s and 227.3 s, and after 285.6 s (that run's second attempt was still going at 360 s when the command limit stopped it). The full table is in the scenario header's 2026-10-30 block. Logs: `tickets/.logs/joiner-seat-phone-1.log` (with the debug lines passed through) and `joiner-seat-phone-2.log` (tallied), until pruned.

`docs/strands.md` states no seating cost, so it was not changed.

## The scenario change (already in the working tree)

- Each attempt at the joiner's seat transaction, and the wait for the seat to reach the founder, is a measured window (`measuredWindow`). Each window gets the same counts as the rounds: deadline events by `debug` namespace, frames on the link, and streams opened. The window is reported when it ends, including when it fails, because a failed attempt is the case worth reading. `measureRounds` became `measureWindow(aStrand, bStrand)`, and `reportRounds` became `reportWindow`.
- The per-minute progress line covers seating as well as rounds (`withProgress`, which replaces `reportedRound`).
- The phone arm has a no-op test, `seats both parties`, so that `-t 'seats both parties'` runs only the seating in `beforeAll`. It is documented in "Running it". It stays opt-in, like the rest of the phone arm.
- The fix stage already ran these: `tsc --noEmit` and `eslint` on the file are clean, and the loopback arm passes (the seat opens 7 cluster streams and takes 0.4 s, and 8 rounds run in 0.7 s).

## TODO

- Re-read the diff of `strand-workload-on-a-phone-link.integration.ts` for anything the fix stage left rough. In particular, the window labels currently read "during the B's seat, attempt 1".
- Re-run the loopback arm (`yarn workspace @serfab/integration-tests exec vitest run strand-workload-on-a-phone-link`), plus typecheck and lint for the package.
- The phone arm cannot finish inside one agent command (a seat attempt runs about 4-5 minutes, and up to 4 attempts are allowed), so do not re-run it here. A human run of the seating on a quiet machine would add the quiet-machine row the 2026-10-30 block lacks.
