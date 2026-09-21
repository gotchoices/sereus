description: Our relay tests all run on the local machine, where messages arrive instantly, so nothing catches problems that only appear on a real internet connection. Add a reusable way to slow a test's network down, and one test that runs with a realistic delay so the phone-to-phone case is checked against something closer to reality.
architecture: docs/testing.md#topology-coverage-map
files:
  - packages/integration-tests/src/harness/ws-latency.ts (written; already in the working tree)
  - packages/integration-tests/src/scenarios/blind-relay-phone-to-phone-e2e.integration.ts (imports it; the scenario to give a latency arm)
  - packages/integration-tests/src/harness/index.ts (deliberately does NOT re-export ws-latency; see below)
  - docs/testing.md (topology coverage map + "Where measurements live")
  - tickets/backlog/debt-relay-scenarios-never-see-link-latency.md (this fulfils it; delete when this lands)
difficulty: medium
----

# A reusable link-latency fixture for relay scenarios, and a scenario that uses it

This came out of investigating gotchoices/sereus#13, which reported that two-party strand formation over a relay breaks at 10 ms of per-frame latency. **It does not** — that threshold is an artifact of how the reporter's injector applies its delay (see `blocked/report-issue-13-latency-threshold-is-a-harness-artifact` for the full measurement and the reply owed to the reporter). There is no correctness bug to fix here.

What the investigation did establish is that `backlog/debt-relay-scenarios-never-see-link-latency` was right: every relay scenario runs on loopback, where a message arrives in microseconds, so nothing in the suite would notice if a change made relayed bring-up ten times more sensitive to link delay. This ticket lands the fixture that closes that gap. It is test infrastructure only — no production code changes.

## What is already in the working tree

`packages/integration-tests/src/harness/ws-latency.ts` is written, linted, type-checked and used. `blind-relay-phone-to-phone-e2e.integration.ts` imports it as its first line. With no environment variables set it is inert: the scenario was re-run afterwards and passes unchanged.

How it works: `@libp2p/websockets` dials with a bare `new WebSocket(uri)` against the global constructor, so replacing that global reaches every socket libp2p *dials* and nothing else. Listening sockets come from the `ws` package and are untouched.

That approach sidesteps both pitfalls the backlog ticket recorded from its ad-hoc TCP-proxy version. There is nothing to bypass — a node that opens a direct connection to the relay's real port still goes through the same global constructor — and frame order is preserved by construction rather than by a proxy's queue.

Three environment knobs, all off by default:

- `WS_SEND_DELAY_MS` — hold each outbound frame this long. `0` (default) holds nothing.
- `WS_SEND_DELAY_MODE` — `pipelined` (default) or `serial`. **This is the setting that decides what a number means.**
- `WS_FRAME_STATS=1` — count frames with no delay at all, to get a baseline.

`pipelined` releases each frame `WS_SEND_DELAY_MS` after that frame was written, so frames stay overlapped in flight the way they do on a real link; a constant delay preserves their order on its own. `serial` queues every frame on one chain per socket, so frame *k* waits for the *k-1* ahead of it — which models a per-socket frame-rate cap, not latency. The reporter's injector is `serial`, which is why it is kept.

Whichever mode is used, the fixture prints a summary line every 5 s carrying `worst observed send wait` — the delay a run actually experienced. In `serial` mode that number runs far above the configured delay, which is what makes the two modes' results incomparable.

## The measurements that justify the fixture

All from `blind-relay-phone-to-phone-e2e` on one Windows machine, four nodes in one process over the loopback dedicated relay.

Baseline, counters only, no delay: **4,735 outbound frames across 4 dialed sockets, busiest socket 2,192 frames**, scenario passes in 3.5 s. That frame count is the multiplier on any per-frame cost, and it is the reason the two modes diverge so sharply.

`serial` mode (the reporter's shape):

| delay | outcome |
|---|---|
| 1 ms | fails — first sync completes, but the joiner's membership rows miss the scenario's 20 s gate |
| 2 ms | fails — `StrandAwaitingFirstSyncError` after 60 s; worst observed send wait 2,358 ms |
| 5 ms | fails — `StrandAwaitingFirstSyncError` |
| 10 ms | fails — `StrandAwaitingFirstSyncError`; worst observed send wait 2,274 ms |

`pipelined` mode (constant one-way latency):

| delay | outcome |
|---|---|
| 10 ms | **passes**, 9.2 s; worst observed send wait 117 ms |
| 50 ms | **passes**, 31.8 s and 24.6 s over two runs; worst observed send wait 128–153 ms |
| 100 ms | first sync completes; joiner's membership rows miss the scenario's 20 s gate |
| 150 ms | same as 100 ms |

Note the shape of the `serial` numbers: worst observed send wait lands near 2.3 s at both 2 ms and 10 ms, an order of magnitude above the configured delay, because a burst of frames on one stream serializes behind itself and stalls every other stream sharing that node's single relay socket. That stall is the whole failure. In `pipelined` mode the observed wait tracks the configured delay plus timer slop, as it should.

## Why the failures above 50 ms are not a bug to fix here

At 100 ms and 150 ms of real one-way latency the strand still becomes writable — first sync works. What misses is the scenario's own `JOIN_FINISH_MS` gate of 20 s on the joiner's `Strand.Member` and `Strand.MemberPeer` rows. That gate is deliberately tight (the scenario's comment says so: below the reconciler's 30 s poll interval, so "the join waits out a full interval" fails rather than passes slowly), and the reconciler retries on a ladder starting at 1 s and doubling to that 30 s cap (`INITIAL_JOIN_RETRY_INTERVAL_MS` in `packages/cadre-core/src/strand-membership-reconciler.ts`). A join that takes a rung or two longer on a 100 ms link is slow, not broken — and **it was not confirmed that the join eventually finishes**, because the scenario aborts at the gate.

The underlying cost — how chatty relayed bring-up is — is already owned by `blocked/optimystic-strand-operations-cost-dozens-of-relay-round-trips`, and this investigation's frame counts have been appended to it as corroborating evidence. Do not re-file that here.

## What to build

The fixture is env-var-only, which is fine for ad-hoc investigation but cannot express "this scenario runs with latency" as a committed test. Two things are missing.

**A programmatic entry point.** A scenario cannot set `WS_SEND_DELAY_MS` for itself, because the module reads it once at evaluation. Export an `installWsLatency({ delayMs, mode })` that does the swap, with the environment variables kept as the ad-hoc override so the investigation above stays reproducible verbatim. Guard against a second install replacing an already-installed shim.

**A committed latency arm.** The recommendation is a second `it()` inside `blind-relay-phone-to-phone-e2e.integration.ts` at 10 ms `pipelined`, sharing the existing body rather than copying it — extract the ~200-line test body into a function taking the latency option and have both cases call it. 10 ms measured 9.2 s against gates of 60 s and 20 s, so the arm costs about ten seconds and keeps real margin. 50 ms was also measured passing, but at 24–32 s against a 60 s gate the margin is too thin to commit as a gate on slower CI hardware.

What that arm pins is worth stating plainly, because it is not a bug reproduction — the bug turned out not to exist. It pins a piece of the product specification that nothing else covers: two phones form a strand and replicate through a relay when the link is not instant. That is the headline case the relay work exists to serve, and today a change that made relayed bring-up far more latency-sensitive would pass every test in the suite.

## An open design question: per-node delay

`backlog/debt-relay-scenarios-never-see-link-latency` asks for delay on **one node's** connection, so a scenario can model a slow phone talking to a fast desktop. This fixture cannot do that: the swap is on the global constructor, so it delays every node in the process equally.

That is a real gap, and the honest options are worth weighing rather than guessing:

- **Accept process-wide for now.** Everything-is-slow is the harsher and simpler case, and it is what the phone-to-phone topology actually looks like. Cheapest; leaves the asymmetric case uncovered.
- **Key the delay by destination port.** Give `DedicatedRelay` more than one listen address and hand each node its own; the shim reads the dial URI, so it can apply a different delay per port. No proxy, and nothing to bypass — a direct dial to any of those ports still goes through the same constructor. This looks like the best answer, but it has not been prototyped and the relay fixture change is not free.
- **A delaying TCP proxy per node.** What the backlog ticket tried. Its recorded failures (nodes bypassing the proxy; a connection gater added to stop them changing behaviour enough to produce failures the device run never showed) are reason enough not to return to it.

Pick one and say which in the review handoff. If per-node is deferred, keep the "Process-wide" note in the module header accurate and leave the backlog ticket's asymmetric half on the board rather than deleting the whole ticket.

## Documentation

`docs/testing.md` is the anchor. Two places need a line:

- **Topology coverage map** — the relay lines currently describe shapes, not link conditions. Say which relay scenario runs with latency and at what delay, so "relayed but instant" stops reading as full coverage of the relayed shape.
- **Where measurements live** — the frame counts and the two tables above are measurements, and this is where the file says they belong.

Both should state the `pipelined` / `serial` distinction once, because a number quoted without its mode is misleading by an order of magnitude — that is exactly the mistake issue #13 made.

## TODO

- Export `installWsLatency({ delayMs, mode })` from `ws-latency.ts`, keeping the environment variables as an override and making a second install a no-op (or an explicit error) rather than a silent re-wrap.
- Decide whether `ws-latency.ts` is re-exported from `harness/index.ts`. It is deliberately excluded today because a side-effect module in the barrel would reach every scenario importing it; once the install is a called function rather than an import side effect, that objection goes away.
- Extract the body of `blind-relay-phone-to-phone-e2e.integration.ts` into a function parameterized by latency, leaving the existing zero-delay case behaviourally identical.
- Add the 10 ms `pipelined` arm alongside it. Run both several times and record the spread — 9.2 s is a single measurement, and a committed gate needs to know its variance, not just one sample.
- Choose an answer to the per-node question above and record which, with the reason.
- Update `docs/testing.md` in the two places named.
- Delete `tickets/backlog/debt-relay-scenarios-never-see-link-latency.md` if the per-node half is also satisfied; if per-node is deferred, edit it down to just that remaining half instead.
- Leave `tickets/blocked/report-issue-13-latency-threshold-is-a-harness-artifact.md` alone — it is a human's to act on and does not gate this work.
