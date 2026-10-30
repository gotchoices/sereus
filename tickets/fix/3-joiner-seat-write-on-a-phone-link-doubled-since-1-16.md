description: On a phone-shaped link, the joiner's first write (its seat) takes about 188 s on Sereus 1.19.0, and seating as a whole about 220 s, against 108-110 s in total on 1.16.0. The reporter of gotchoices/sereus#48 saw it in all three 1.19.0 runs, while every later round got faster. Find out whether this is a regression or the cost of the seat no longer committing alone, and fix it if it is a regression.
architecture: docs/strands.md
repro: none
files: packages/integration-tests/src/scenarios/strand-workload-on-a-phone-link.integration.ts (`seatJoiner` ~443, `seatParties`, `seatedWorkload`, the dated tables in the header), packages/integration-tests/src/scenarios/joiner-first-commit-over-slow-relay.integration.ts (same link, a smaller first transaction), packages/cadre-core/src/strand-first-sync-gate.ts, docs/strands.md (first-sync gate ~234), tickets/blocked/decide-link-deadlines-from-measured-response-time.md
----
## Report

gotchoices/sereus#48, the reporter's 2026-10-27 rerun on 1.19.0 (Mac, Node 24.11, npm Optimystic 1.19.0 / Quereus 4.20.3). They ran `STRAND_WORKLOAD_PHONE=1 DEBUG='optimystic:*,libp2p:connection-monitor*' … vitest run strand-workload-on-a-phone-link`:

| | 1.16.0 | 1.16.0 | 1.19.0, load 4-8 | 1.19.0, quiet | 1.19.0, quiet |
|---|---|---|---|---|---|
| joiner writable after joining | — | — | 31.8 s | 31.9 s | 31.9 s |
| joiner seated after joining | 108.0 s | 109.9 s | 331.6 s | 220.2 s | 220.3 s |
| 8 rounds | 1056.2 s | 602.6 s | 1844.3 s | 444.7 s | 442.6 s |

On the quiet runs, the seat write is 188 s on its first attempt. Rounds improved (no failed operation, converged for the first time), and only seating got slower.

## Hypotheses, in the order to test them

1. **On 1.16.0 the seat committed alone; on 1.17.0+ it does not.** Since #47's fix (Sereus 1.17.0), the joiner becomes writable while connected to the founder, so its first commit goes to both members over the phone link instead of to a cohort of one. Check the 1.16.0 run logs or rerun for `commit:solo-cohort` on the seat. If 1.16.0's seat was solo, this is a correct commit's cost and not a regression. Record that, and look at why one two-member commit of the seat's rows takes 188 s on this link: how many blocks, round trips and retries. That is the per-commit cost `decide-link-deadlines-from-measured-response-time` covers.
2. **The seat waits behind first-sync or reactivity work** that 1.17-1.19 added: the first-sync gate reads every table, peer-join backfill, and the multi-collection commit (Optimystic 1.19.0 #42). Look at the timeline between "writable" (31.9 s) and the seat's commit.
3. **A retry or deadline inside the commit** (commit retried, cohort silent) on its first attempt. Count the `DEADLINE_EVENTS` inside the seat window rather than over the rounds only.

## Measuring

- The phone arm's full run is about an hour, so it can't run inside one agent command. The **seating happens in `beforeAll`** and takes about 4 min, so add an opt-in way to stop after seating, or measure with `-t` on a no-op arm. Keep it opt-in, like the rest of the phone arm.
- Measure on the current release (Optimystic 1.20.1). 1.20.0 changed the commit path internally (segments, the coordinator entry commit), so the number may already differ from 1.19.0.
- For the 1.16.0 comparison, prefer the reporter's numbers and the scenario header's dated tables (`seated after joining | 103 s; 100 s | 108.0 s; 109.9 s`) over re-running an old tag. Re-run 1.16.0 only if hypothesis 1 can't be settled from logs.
- Add a dated block to the scenario header with what you measured. Don't overwrite earlier blocks.

## Disposition

- If it's hypothesis 1: no code change here. Record the finding in the scenario header and in `docs/strands.md` if it states a seating cost, and add the per-commit numbers to `blocked/decide-link-deadlines-from-measured-response-time` as evidence. Then output a `complete/` ticket, stating the reason the implement stage was skipped.
- If it's a Sereus-side wait (hypothesis 2): emit an `implement/` ticket with the site and the fix.
- If it's upstream: write a report in `blocked/` naming the Optimystic code, with the measurement.

## Edge cases & interactions

- Load decides the outcome on this link (the reporter's loaded run took 331 s). Measure on a quiet machine, and say what the load was.
- The seat writes several tables (`JOINER_SEAT`) in one transaction. Since Optimystic 1.19.0 that is one batched commit, so compare it with a single-table write on the same link (`joiner-first-commit-over-slow-relay`'s first transaction) before concluding anything about the seat's size.

## TODO

- Measure seating on 1.20.1 with the deadline events tallied inside the seat window.
- Settle hypothesis 1 from logs (solo seat on 1.16.0?).
- Dispose as above; add the dated header block.
