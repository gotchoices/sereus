description: Commit the reporter's test from GitHub #48, in which an app on two phones keeps writing and reading a shared strand, and run it once on the slow phone-shaped link to record which time limits in the stack fire and how often, so the fixes can be aimed at the ones that actually fire.
prereq: strand-founder-commits-every-table-collection
architecture: docs/cadre-consistency.md#deadlines-over-optimystics-reads-and-commits
files: packages/integration-tests/src/scenarios/strand-workload-on-a-phone-link.integration.ts (new), packages/integration-tests/src/harness/event-loop-load.ts (new), packages/integration-tests/src/harness/index.ts, packages/integration-tests/src/scenarios/joiner-first-commit-over-slow-relay.integration.ts (`occupyEventLoop` ~174, `ENV_EVENT_LOOP_BUSY` ~183), docs/testing.md (the opt-in scenario paragraphs ~63-74), tickets/plan/strand-workload-count-driven-fixes.md (append the measurement)
----

# Commit the strand workload scenario and attribute its deadline events

## Why

gotchoices/sereus#48 reports that on a phone-shaped link (every outbound WebSocket frame held 20 ms, one after another, with the event loop 70% busy) a two-party strand's steady work fails: rounds of 11-169 s against 0.1 s on loopback, 5 failed operations per run, dozens of requests abandoned to deadlines and retried, and in one run the strand nodes ended disconnected holding different rows. The reporter's scenario is the acceptance test for the fixes. This ticket commits it and runs it once with debug logging, so the follow-on plan ticket (`strand-workload-count-driven-fixes`) files fixes against measured counts rather than a list read from the code.

The prereq (`strand-founder-commits-every-table-collection`) removes one class of network reads: a table nobody has written now has a collection from founding, so reading it is local. This ticket measures after it, so the counts do not include that class.

## The scenario

Source: the scenario file at the end of the issue body (`gh issue view 48`). Keep its workload, topology and measurements; it is the reporter's, and the issue's numbers were taken with it. Changes:

**Layout: setup in `beforeAll`, rounds in the test.** With `it.fails`, any throw passes the test, including a seating step that timed out, which would keep the arm green while measuring nothing (`joiner-first-commit-over-slow-relay.integration.ts` has the same hazard, its NOTE on `FIRST_SYNC_MS`). So each arm is its own `describe`: `beforeAll` starts the relay and both parties, forms the strand, seats both sides and waits for B's seat to reach A, under the hook's own timeout; the test runs the rounds and the convergence check; `afterAll` stops everything and restores the link and the event loop. A setup failure is then a hook error: the file fails, and `test-harness/setup-failure-reporter.ts` names the test as not run (`docs/testing.md` → "Tests that did not run"). Factor the setup into one function returning a fixture (`{ relay, A, B, aDb, bDb, founded, bStrand, restore() }`) and the rounds into another, so both arms share them.

**The phone arm is opt-in.** The issue's phone runs took 4-10 minutes of rounds after about 100 s of seating, plus up to 180 s of convergence waiting, so the arm costs about 15 minutes. Gate its `describe` with `describe.skipIf(!process.env.STRAND_WORKLOAD_PHONE)`, the precedent being `RELAY_DIAL_COST=1` and `REATTACH_SYNC_MEASURE=1`. The loopback arm runs by default. Tradeoff accepted: an opt-in `it.fails` does not flip by itself when a fix lands; the follow-on tickets that change a deadline name this run as their check.

**No exemption for the unwritten table.** Both arms filter out `read CloseRequest` failures. With the prereq landed, reading `CloseRequest` is local and must not fail, so drop the filter. If the loopback arm still fails reading `CloseRequest`, the prereq did not do what it claims: report it on that ticket's review, not here.

**Attribute each deadline event to the module that logged it.** The reporter's counter matches six patterns in stderr. Keep them, and also tally each hit by its `debug` namespace (in Node's non-TTY format a line is `<ISO time> <namespace> <message>`; FRET logs under `optimystic:fret:*`, Optimystic under `optimystic:db-p2p:*` and `optimystic:db-core:*`), and print a table of pattern × namespace at the end of the rounds. Add these patterns, which the follow-on ticket needs:

| label | pattern | why |
| --- | --- | --- |
| read-repair consult | `cluster-tx:read-repair-triggered` | a read of a block this node holds starts a background cohort consult when the block was last checked more than `readRepairWindowMs` (10 s, Optimystic's default, which cadre does not set) ago. Phone rounds are longer than 10 s, loopback rounds are not, so this may be the extra traffic the issue measured. |
| read-repair deferred | `cluster-tx:read-repair-deferred` | consults dropped because too many were already running |
| ping failure | `aborting connection due to ping failure` | libp2p's connection monitor dropping a connection (`blocked/optimystic-ping-handler-timeout-below-the-monitor-deadline`) |
| no coordinator | `No coordinator available` | a write's retry ran out of peers to try |
| solo commit | `commit:solo-cohort` | a node committed with a cohort of only itself, which is how the two sides can end holding different rows while both are running |
| FRET contact strike | `change: contact strike` | FRET's 2 s maintenance ping to a peer failed; at the third strike the peer is marked `dead` and leaves every cohort (`blocked/fret-maintenance-deadlines-below-the-declared-link`). Logged under `optimystic:fret:service:fret`, already inside `DEBUG='optimystic:*'` |
| FRET peer revived | `revived - stabilization interval` | a peer FRET had marked `dead` answered again and rejoined the ring |

The ping line is logged under `libp2p:connection-monitor`, so the measuring run sets `DEBUG='optimystic:*,libp2p:connection-monitor*'`. Note it in the file's run instructions.

**Progress line.** Print one line per minute while a round is still running (`[workload phone] round 3 still running, 120 s`). The runner kills a process that prints nothing for 10 minutes, the debug output is swallowed by the counter, and one reported round took 169 s; a single slow round must not end the measuring run.

**Hoist `occupyEventLoop`.** The scenario and `joiner-first-commit-over-slow-relay.integration.ts` each define the same function. Move it to `packages/integration-tests/src/harness/event-loop-load.ts`, export it from `harness/index.ts`, and use it in both.

Keep the file's doc comment as the single home for its numbers (the convention `relayed-dial-cost-by-latency.integration.ts` follows): the reporter's table stays, labelled with the versions it was measured on, and this ticket's run is added beside it with date, commit and versions.

## The measuring run

After the loopback arm passes:

```
STRAND_WORKLOAD_PHONE=1 DEBUG='optimystic:*,libp2p:connection-monitor*' yarn workspace @serfab/integration-tests exec vitest run strand-workload-on-a-phone-link 2>&1 | tee tickets/.logs/strand-workload-on-a-phone-link-scenario.phone.log
```

Run it in the foreground (the progress line keeps the runner's idle timer alive). One run is enough for attribution; a second only if the first ended in setup failure. Record:

- per round: time and failures;
- the pattern × namespace table;
- whether A's strand node held a connection to B's after the rounds, and whether the two sides converged within 180 s, with what each side held if not;
- the seating time.

Write these into the scenario's doc comment, and append them, with the log path, to `tickets/plan/strand-workload-count-driven-fixes.md` under a `## Measured` heading, so that ticket's planner starts from them. If the phone arm passes (no failed operation, converged), it is no longer `it.fails`: make it a plain `it` and say so in the handoff; the follow-on ticket then has only the upstream proposals the counts still justify.

If the run cannot finish inside the agent's budget, say so in the handoff with how far it got, and leave the measurement to the review stage or a human.

## Edge cases & interactions

- **Setup failure in the phone arm** must fail the run, not pass `it.fails`. Verified by inspection of the `beforeAll` layout; optionally by forcing a 1 ms seating timeout once locally and seeing the run fail (do not commit that).
- **The counter replaces `process.stderr.write`.** It must be restored in a `finally` even when a round throws, and it must not swallow vitest's own failure output after the rounds. The reporter's version already restores in `finally`; keep that.
- **Two copies of `debug`** in the dependency tree each write to stderr; the interception catches both, which is why it hooks stderr and not one `debug` instance. Do not "fix" it to hook `debug.log`.
- **Hook and test timeouts.** Seating took about 100 s; give `beforeAll` 900 s (the reporter's `FIRST_SYNC_MS`) and the test 3 600 s, as the reporter did.
- **Loopback must stay green on CI.** It ran in about 2 s of rounds in the issue. If it fails after the prereq, that is a regression to report, not to filter.
- **`ws-latency.ts` and the event-loop load are process-wide.** Both arms are in one file; vitest runs a file's describes sequentially, and `afterAll` restores both, so the loopback arm is unaffected when both run. Keep the loopback arm first.

## TODO

- Add `harness/event-loop-load.ts` with `occupyEventLoop`, export it, and switch `joiner-first-commit-over-slow-relay.integration.ts` to it.
- Add `strand-workload-on-a-phone-link.integration.ts` from the issue, with the `beforeAll` layout, the opt-in phone `describe`, the dropped `CloseRequest` filter, the per-namespace tally with the added patterns, and the progress line.
- `yarn lint`, `yarn typecheck`; run the loopback arm.
- Run the phone arm once as above; record the results in the doc comment and in `tickets/plan/strand-workload-count-driven-fixes.md` under `## Measured`.
- Add one paragraph to `docs/testing.md` beside the other opt-in scenarios: what it measures, the env variable, the `DEBUG` value, and that its numbers live in its doc comment.
- Add one sentence to `docs/cadre-consistency.md` → "Deadlines Below Cadre", after its sentence on the ring: this scenario is the one that measured which of those deadlines fire on a phone-shaped link, and its numbers live in its doc comment (do not copy them into the doc). Handed over from `strand-deadline-ladder`, which wrote the table before this file existed.
