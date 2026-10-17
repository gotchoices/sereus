description: The reporter's test from GitHub #48, in which an app on two phones keeps writing and reading a shared strand, is now committed, and one run on the slow phone-shaped link recorded which time limits fire and how often, and why the two sides ended with different data.
architecture: docs/cadre-consistency.md#deadlines-over-optimystics-reads-and-commits
files: packages/integration-tests/src/scenarios/strand-workload-on-a-phone-link.integration.ts (new), packages/integration-tests/src/harness/event-loop-load.ts (new), packages/integration-tests/src/harness/ws-latency.ts (`openWsFrameWindow`), packages/integration-tests/src/harness/index.ts, packages/integration-tests/src/scenarios/joiner-first-commit-over-slow-relay.integration.ts (uses the hoisted `occupyEventLoop`), docs/testing.md (opt-in scenario paragraph), docs/cadre-consistency.md ("Deadlines Below Cadre", one sentence), tickets/implement/strand-workload-count-driven-fixes.md (`## Measured`)
----

# Review: the strand workload scenario and its phone-link measurement

## What landed

- **`strand-workload-on-a-phone-link.integration.ts`**, the reporter's scenario (gotchoices/sereus#48) reshaped as the ticket asked:
  - Each arm is its own `describe`. `beforeAll` seats both parties under a 900 s hook timeout, the test runs 8 rounds plus the convergence check, and `afterAll` undoes setup in reverse. Setup registers each undo step as it starts (`Teardown`), so a hook that times out still stops what it started.
  - The phone arm is opt-in (`describe.skipIf(!process.env.STRAND_WORKLOAD_PHONE)`) and stays `it.fails`.
  - The `read CloseRequest` exemption is gone; loopback passes without it.
  - Deadline events are tallied by pattern and by `debug` namespace, with the ticket's seven added patterns plus one more (below). db-p2p's peer-id suffix in a namespace is shown as the node's name (`coordinator-repo [B strand]`).
  - A progress line prints each minute a round is still running.
  - Each round's start time is printed in ISO form, and setup prints every node's full peer id, so a debug log can be matched against both.
- **`harness/event-loop-load.ts`**: `occupyEventLoop` hoisted from `joiner-first-commit-over-slow-relay`, which now imports it.
- **`ws-latency.ts` → `openWsFrameWindow()`**: frames, bytes, the busiest socket's frames and the worst send wait over an interval the scenario marks.
- **Docs**: a paragraph in `docs/testing.md` beside the other opt-in scenarios, and the sentence in `docs/cadre-consistency.md` → "Deadlines Below Cadre".
- **Measurement**: written into the scenario's doc comment (the authoritative copy) and appended to `tickets/implement/strand-workload-count-driven-fixes.md` under `## Measured`.

## The measurement, in brief

The full figures are in the doc comment. Phone run 2 (the one that measured):

- Rounds of 90.6, 94.8 and 3.1 s; the writes of rounds 1-3 failed.
- Rounds 4-8 then ran in about 10 ms each, every one a solo commit.
- A's strand node held 0 connections to B's after the rounds, and the sides did not converge.

The rows that differ are exactly the five solo commits. Each came about 2 s after FRET marked the other strand node `dead` (its third contact strike). After the rounds:

- 309 read-repair consults, 224 of them on the **control** nodes, which `STRAND_CLUSTER_POLICY` does not reach. The follow-on ticket is told this.
- Clean-workload demand on loopback: the busiest socket sent about 472 frames a round.

## Deviations from the ticket, and why

- **The joiner's seat is retried in setup** (`seatJoiner`, up to 4 attempts, rewriting only the rows not yet present).
  - Why: phone run 1 ended in setup failure. The joiner's seat transaction failed as a partial commit (`Seat` durable, `Party` not) after about 2 minutes of coordinator retries.
  - Cause: since `strand-founder-commits-every-table-collection`, the joiner is connected to the founder when it becomes writable, so its first write crosses the slow link (the same finding as `fix/slow-link-restart-arms-lost-their-lone-commit`).
  - Without a retry, every phone run is a coin toss on whether any rounds are measured. When all attempts fail, setup still fails the file.
  - Reviewer: decide whether 4 attempts is right, and whether a retry belongs in setup at all.
- **`openWsFrameWindow` added to `ws-latency.ts`.** The ticket pointed at "its summary line", but that line's totals run from the install, so they include seating. Its busiest-socket figure is also a socket's lifetime count, which survives `resetStats()`. Neither gives "frames over the rounds", which is what the follow-on's `T_clean` needs.
- **One extra pattern, `FRET peer marked dead`** (`change: contact strike 3 on`). It is the third strike, and it hard-codes FRET's `deadAfterFailures` default of 3, which Optimystic leaves. The follow-on needs dead markings to match the diverged rows by time.
- **`fault` flag on the patterns.** The phone arm's "no deadline event under `DEBUG`" assertion counts only fault patterns. Read-repair consults, deferrals and FRET revivals do not count: they are traffic or recovery, and loopback has 7 consults.
- **The measuring run's command differed from the ticket's.**
  - Detached process: the Bash tool caps a foreground command at 10 minutes and the arm takes about 10 (570 s with the loopback arm). So the run was started with PowerShell `Start-Process`, stdout and stderr redirected into `tickets/.logs/`, and followed with `timeout 570 tail -f … | grep` in the foreground. That pattern is reusable for the follow-on or a human.
  - `WORKLOAD_SHOW_DEBUG=1` was set, keeping every debug line with its timestamp. The time matching of the diverged rows needed it. Cost: the stderr writes during the rounds, which the reporter's runs dropped.

## Validation

- `yarn lint`, `yarn workspace @serfab/integration-tests typecheck`, and the three `check:*` coverage scripts: clean.
- Loopback arm: passes, run seven times across the session (8 rounds in 0.6-1.2 s, no failure, converged at once).
- `WS_FRAME_STATS=1` loopback: twice (7 427 / 7 503 frames over the rounds).
- Phone arm: run 1 failed in setup (before the retry existed). Run 2 reported `1 expected fail`, and the file passed.
- Reproduce:
  - `yarn workspace @serfab/integration-tests exec vitest run strand-workload-on-a-phone-link` (loopback; seconds).
  - `STRAND_WORKLOAD_PHONE=1 DEBUG='optimystic:*,libp2p:connection-monitor*' WORKLOAD_SHOW_DEBUG=1 yarn workspace @serfab/integration-tests exec vitest run strand-workload-on-a-phone-link` (about 10 minutes).
- Not run: `joiner-first-commit-over-slow-relay` after the hoist. Its arms take tens of minutes, and the change there is a removed local function plus one barrel import, which the typecheck covers. The new scenario imports the same export at runtime.

No tests added: the change is test instrumentation and a scenario, and none of its logic pins a part of the specification.

## Known gaps for the reviewer

- **One measured run.** Run-to-run spread is unknown. The reporter's runs varied 2-5× in event counts between runs on one stack.
- **The setup failure was checked by observation, not by forcing.** The 1 ms seating timeout check the ticket suggests was not done. Run 1 is a real setup failure: `Test Files 1 failed`, and the setup-failure reporter printed `NOT RUN 1 test`.
- **FRET's and libp2p's lines carry no logging node.** Their counts cannot be split by node from the namespace. The timeline in the doc comment comes from the full peer ids in the message text.
- **The stream counter counts only opens that succeed.** No FRET stream succeeded during the phone rounds, so FRET's maintenance traffic over them is not in the per-protocol counts.
- **The namespace regex** (`DEBUG_LINE`) assumes `debug`'s non-TTY format, `<ISO time> <namespace> `. A colored TTY run would tally everything under `(no namespace)`. Vitest's forked workers write to a pipe, so it holds for the commands above.
- **The swallowing stderr hook** calls a write's callback on a microtask when it drops the chunk. The reporter's version dropped callbacks; nothing observed depends on either.
- **`strand-workload-count-driven-fixes` has not been re-planned.** Its "Measured" section raises the control-node consults and the 3-of-8 rounds that crossed the link, but its decision table is unchanged.
