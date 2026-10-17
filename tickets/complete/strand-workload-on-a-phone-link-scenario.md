description: The reporter's test from GitHub #48, in which an app on two phones keeps writing and reading a shared strand, is now committed, and one run on the slow phone-shaped link recorded which time limits fire and how often, and why the two sides ended with different data.
architecture: docs/cadre-consistency.md#deadlines-over-optimystics-reads-and-commits
files: packages/integration-tests/src/scenarios/strand-workload-on-a-phone-link.integration.ts, packages/integration-tests/src/harness/event-loop-load.ts, packages/integration-tests/src/harness/ws-latency.ts (`openWsFrameWindow`), packages/integration-tests/src/harness/index.ts, packages/integration-tests/src/scenarios/joiner-first-commit-over-slow-relay.integration.ts, docs/testing.md, docs/cadre-consistency.md, tickets/implement/strand-workload-count-driven-fixes.md (`## Measured`)
----

# The strand workload scenario and its phone-link measurement

## What landed

The work is in `ticket(implement): strand-workload-on-a-phone-link-scenario`.

- `strand-workload-on-a-phone-link.integration.ts`: the reporter's scenario from gotchoices/sereus#48. Each arm is its own `describe`. Seating happens in `beforeAll`, so a setup failure fails the file instead of passing the phone arm's `it.fails`. Teardown steps are registered as each piece starts. The phone arm is opt-in (`STRAND_WORKLOAD_PHONE=1`). The `CloseRequest` exemption is gone. Deadline events are tallied by pattern and by `debug` namespace, with node names in place of peer-id suffixes, and a progress line prints each minute.
- `harness/event-loop-load.ts`: `occupyEventLoop`, moved out of `joiner-first-commit-over-slow-relay`.
- `ws-latency.ts`: `openWsFrameWindow()`, which counts frames, bytes, the busiest socket and the worst send wait over an interval the scenario marks.
- Docs: an opt-in paragraph in `docs/testing.md`, and one sentence in `docs/cadre-consistency.md` → "Deadlines Below Cadre".
- Measurement: in the scenario's doc comment (the authoritative copy) and under `## Measured` in `implement/strand-workload-count-driven-fixes`. In brief: on the phone arm, the writes of rounds 1-3 failed. FRET then marked each strand node `dead`, and rounds 4-8 each committed with a cohort of only the writer. Those five rows are exactly the rows on which the two sides differ. 224 of the 309 read-repair consults were on control nodes.

## Review findings

**Read first:** the implement diff, then the handoff. Checked the scenario, the harness additions, the hoist, both docs, the follow-on ticket's `## Measured` section, and Optimystic's `createLogger` (`../optimystic/packages/db-p2p/src/logger.ts`, read only), to confirm the 12-character peer-id suffix that `NAMESPACE_PEER_ID_LENGTH` assumes.

**Fixed in this pass (minor):**
- `measureRounds` installed the stderr hook first and only then started the stream counter. The counter can throw (it dereferences each strand node's `libp2pNode`), and a throw there happens before `runWorkload`'s `try`. The hook would then stay installed and swallow stderr for the rest of the worker. The order is now: stream counter, then the frame window, then the stderr hook. A comment at the site gives the reason.
- The comment on the phone `describe` said "about 15 minutes", while the doc comment and `docs/testing.md` both say about 10, which is what the run measured. It now points to the doc comment's "Running it" section, so the duration is stated in one place.
- Three doc-comment lines were not wrapped like the rest. Rewrapped.

**Checked, no change needed:**
- *Setup retry (`seatJoiner`, 4 attempts).* Kept. A partial commit across tables is a documented property of Optimystic's distributed commits. `blocked/strand-half-committed-join-recovery` cites `db-core/src/transaction/errors.ts`. So rewriting only the missing rows is the correct recovery, not a mask. Each failed attempt is logged. The counters start only at the rounds, so retries do not distort the measurement. If every attempt fails, setup still fails the file. Four attempts at about 2 minutes each fit inside the 900 s hook timeout, with writability (45 s measured) on top.
- *Restoring the stderr hook.* It is restored in `runWorkload`'s `finally`, before the convergence check and before any assertion, so vitest's failure output is not swallowed. `round` catches every operation's error, so no round throws past it.
- *`openWsFrameWindow`.* The per-frame cost is a loop over open windows, which is empty unless a scenario opens one. At zero delay the count still happens, before the pass-through send. A send wait is recorded when the frame is released, as the field's comment says. `instrumented` is fixed when the window opens. That is correct for both arms: the phone arm installs in `beforeAll`, and `WS_FRAME_STATS` installs when the module loads.
- *`FRET peer marked dead` is also counted as a contact strike,* so `faultCount` counts it twice. This is harmless, because the only use is the phone arm's `toBe(0)`. The pattern's comment already says so.
- *Teardown order.* The busy event loop and the link delay are undone last, after the nodes and the relay stop. That slows teardown, but `TEARDOWN_MS` (120 s) covers it, and the reverse order follows the order of setup.
- *Cost of tallying on a busy event loop.* The hook runs 14 regexes per debug line. That is small next to `debug`'s own formatting, which runs whether or not the hook is installed. Not measured; no tripwire, because the doc comment already records that `WORKLOAD_SHOW_DEBUG=1` adds stderr writes the reporter's runs did not have.
- *Docs.* `docs/testing.md` and `docs/cadre-consistency.md` describe the scenario as it now is, and neither copies its numbers. `ws-latency.ts`'s `startReporting` comment was updated to point at the window. No other doc names `occupyEventLoop` or the summary line's semantics.

**Tests:** none added or cut. The change is a scenario plus test instrumentation. No defect was found that a test would reproduce, and the loopback arm already exercises `openWsFrameWindow` (under `WS_FRAME_STATS=1`), the namespace tally and the teardown path.

**Major findings / tickets filed:** none. Divergence after a write made alone is already `blocked/optimystic-write-made-alone-owes-no-one`. FRET's deadlines are already `blocked/fret-maintenance-deadlines-below-the-declared-link`. The control-node consults and the decision table have been handed to `implement/strand-workload-count-driven-fixes`, whose re-planning is that ticket's own step.

**Tripwires:** none added. The handoff's caveats are already recorded where a reader will find them: the `DEBUG_LINE` regex assumes non-TTY output, which is stated at the regex; the stream counter counts only opens that succeed, which is stated in the doc comment; and there was one measured run, whose spread is unknown, which is stated in the doc comment and in `## Measured`.

**Known gaps carried forward:**
- There is one phone run, so the spread between runs is unknown.
- The ticket's optional check of forcing a 1 ms seating timeout was not done. Implement run 1 was a real setup failure and showed that the file fails.
- `joiner-first-commit-over-slow-relay` was not re-run after the hoist (its arms take tens of minutes). The change there is one import, and the typecheck covers it.

## Validation (review pass)

- `yarn lint`: clean.
- `yarn workspace @serfab/integration-tests typecheck`: clean.
- `yarn workspace @serfab/integration-tests exec vitest run strand-workload-on-a-phone-link`: run before and after the fixes. Loopback passed both times (8 rounds, no failure, converged at once), and the phone arm was skipped.
- The phone arm was not re-run. The fixes change only when the counters start and the comment text, not what is measured.
