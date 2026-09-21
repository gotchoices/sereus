description: Somebody reported that two people cannot share a workspace through a relay server once the network is even slightly slow, and concluded the feature cannot work outside a local network. We re-ran their test and the alarming number turns out to come from how their test simulated slowness, not from our software — at a realistic internet delay it works. Someone needs to decide whether and how to tell them.
architecture: docs/testing.md#topology-coverage-map
files:
  - packages/integration-tests/src/harness/ws-latency.ts (the corrected injector, with both modes)
  - packages/integration-tests/src/scenarios/blind-relay-phone-to-phone-e2e.integration.ts (the scenario both sets of numbers come from)
difficulty: easy
----

# Human action: answer gotchoices/sereus#13 — the 10 ms threshold is an artifact of the reporter's injector

## Why this is a human's call, not an agent's

Replying to a public issue posts under a person's account, in our project's name, and it tells a careful outside contributor that their headline conclusion is wrong. How that is said matters, and it is not an agent's call to say it. Everything needed to write the reply is below, including draft text. What is missing is the decision to send it and somebody to send it.

Nothing about this blocks other work. The fixture that produced these numbers is landing separately (`implement/latency-injection-fixture-for-relay-scenarios`).

## What they reported

`kjeib` reported, on 2026-09-20, that two-party strand formation over a relay stops working once each outbound WebSocket frame is delayed by 10 ms: 5 ms passed, 10 ms failed twice with `StrandAwaitingFirstSyncError`. They concluded that a single WAN round trip is 20–100 ms, so phone-to-phone through a relay cannot work outside a local network. They diagnosed it as a FRET announce timing out, leaving the host out of the joiner's ring so the cohort stayed at one member.

The report is careful, it rules out several explanations by hand, and it carries a reproduction that needs no device. It deserves a real answer.

## What we found

The reproduction was run against this repo's own `blind-relay-phone-to-phone-e2e` scenario rather than a transcription of it. Their injector holds each frame on **one promise chain per socket**, so frame *k* does not leave until the *k-1* frames ahead of it have each served their delay. The added delay is cumulative, not per-frame. That is a model of a per-socket frame-rate cap (1000 / delay frames per second), not of network latency: on a real link frames stay overlapped in flight and a constant delay shifts them all by the same amount rather than stacking.

The size of that difference is set by how many frames the scenario sends. Counted with no delay: **4,735 outbound frames across 4 dialed sockets, busiest socket 2,192 frames**, for a run that passes in 3.5 s. At 10 ms of cumulative delay, that busiest socket alone is forced to spend at least 22 seconds pushing frames for 3.5 seconds of work. The measured stalls bear this out — worst observed frame wait was 2,358 ms at a *2 ms* configured delay and 2,274 ms at 10 ms, both an order of magnitude above the setting.

Running the same scenario with each frame released independently — constant one-way latency, order preserved, frames overlapped, which is what a real link does:

| one-way delay | outcome |
|---|---|
| 10 ms | passes, 9.2 s |
| 50 ms | passes, 31.8 s and 24.6 s over two runs |
| 100 ms | first sync completes; the joiner's membership rows miss the scenario's deliberately tight 20 s gate |
| 150 ms | same as 100 ms |

So at 50 ms one-way — five times their reported threshold, and a plausible WAN figure — formation, first sync and two-way replication all complete. There is no 10 ms cliff.

One limit on that claim, which the reply should not overstate past: this models latency and nothing else. Bandwidth stays unlimited, so these runs say delay alone does not break the scenario — not that a real congested mobile link would carry it. Given how frame-heavy the path is (below), a bandwidth-limited link is the case still worth measuring, and nothing here has measured it.

Their own caveat ("our injection delays outbound frames only, which is harsher than symmetric RTT") was pointing at this, but understates it: the problem is not the asymmetry, it is that the delay compounds across frames.

Two further corrections to the reported diagnosis, from FRET and key-network debug logs on failing runs:

- **No announce timeout to the host's strand node appeared.** The only announce errors were `foreign-protocol` against the relay, which is expected — the dedicated relay speaks no FRET protocol at all.
- **The strand cohort did reach two members**, within 2–7 s, on runs that then failed first sync 60 s later. The reported `cohort=1` is not what this reproduction shows.

## What is genuinely true, and worth telling them

- Relayed bring-up is expensive in round trips, which is why a per-frame cost multiplies so violently. That is already tracked at `tickets/blocked/optimystic-strand-operations-cost-dozens-of-relay-round-trips`, which measured 48–130 exchanges for a single message insert and has these frame counts appended to it.
- Above roughly 100 ms one-way the joiner's membership rows stop landing quickly, though the strand does become writable. Degraded, not broken — and it was not confirmed how long the join eventually takes, because the scenario aborts at its own gate.
- Their diagnostics point about `addressless` / `selfRelayOnly` was fair and those fields did their job.
- **Their Galaxy S7 evidence is not explained by any of this.** Dials taking 1.6–39 s on a physical phone over Wi-Fi is not a latency figure any link produces; it looks more like CPU-bound handshake cryptography on an old ARM device. That is worth its own investigation and should not be closed out by this reply.

## Decisions for the person taking this

- **Whether to reply at all, and in what tone.** They did good work and found a real weakness in our test coverage; the conclusion is what is wrong, not the effort.
- **Whether to close #13 or re-scope it.** Closing it outright discards the two true findings above. Re-scoping it to the device-side dial latency, or to the round-trip cost, may serve better.
- **Whether to accept their offered PR** bumping `ops/docker/libp2p-infra` from libp2p 2.x to 3.x. They report no behavioural change and that it clears a spurious `TimeoutNaNWarning`. It is unrelated to this bug either way, and should be judged on its own.
- **Whether to point them at the corrected injector.** `packages/integration-tests/src/harness/ws-latency.ts` carries both modes, with `serial` kept precisely so their numbers stay reproducible, and prints the delay a run actually experienced.

## Draft reply

> Thanks for this — the reproduction ran unmodified against our own `blind-relay-phone-to-phone-e2e` scenario, which made it quick to chase down, and the `addressless`/`selfRelayOnly` diagnostics did exactly what you used them for.
>
> The 10 ms threshold turns out to be an artifact of the injector rather than a property of the stack. Each socket's frames are held on a single promise chain, so frame *k* waits for the *k-1* frames ahead of it to each serve their delay — the delay compounds rather than applying per frame. That makes it a model of an outbound frame-rate cap (1000 / delay frames per second per socket), not of latency, where frames stay overlapped in flight and a constant delay shifts them all equally.
>
> That matters here because the scenario is frame-heavy: 4,735 outbound frames across 4 dialed sockets, 2,192 on the busiest, for a run that completes in 3.5 s. At 10 ms cumulative, that one socket is forced to spend 22+ seconds pushing frames. Our instrumentation confirms it — worst observed frame wait was 2.36 s at a *2 ms* configured delay.
>
> Releasing each frame independently instead (constant one-way delay, order preserved, frames overlapped — latency only, bandwidth left unlimited), the same scenario passes at 10 ms in 9.2 s and at 50 ms in 25–32 s. Above ~100 ms first sync still completes but the joiner's membership rows stop landing inside our test's deliberately tight 20 s gate. So there is no 10 ms cliff, and phone-to-phone over a WAN relay is not blocked in the way the issue describes.
>
> Two smaller corrections from the FRET and key-network logs on failing runs: we saw no announce timeout to the host's strand node (the only announce errors were `foreign-protocol` against the relay, which speaks no FRET protocol), and the strand cohort did reach two members within a few seconds on runs that then failed first sync a minute later.
>
> What your report did find, and we're keeping: our relay scenarios all ran on loopback with no delay at all, so nothing in the suite would have noticed a regression in latency sensitivity. We've landed a latency fixture with both injection modes — yours is kept as `serial` so these numbers stay reproducible — and a committed scenario that runs with delay.
>
> Your Galaxy S7 numbers are a separate matter and we don't think this explains them. Dials taking 1.6–39 s on a physical phone isn't a figure any link latency produces; it looks more like handshake cryptography on an older ARM CPU. If you can capture where that time goes on the device, that's the more interesting thread.
>
> The `ops/docker/libp2p-infra` bump is unrelated to this but please do send it separately.

## Reproducing any of this

That scenario file now holds TWO tests — the original loopback one and a committed 10 ms latency arm — so each command below runs both. Do not narrow them to one test with `-t`: the frame counters have no end-of-run hook, and the latency arm's install is the only boundary in the file that prints an exact total (see "A caveat on the frame counts" below).

```bash
# baseline frame count (no delay, counters only); the FIRST summary line printed after the
# loopback test passes is the baseline total — later lines belong to the latency arm
WS_FRAME_STATS=1 yarn workspace @serfab/integration-tests exec vitest run blind-relay-phone-to-phone-e2e

# the reporter's shape — both tests fail
WS_SEND_DELAY_MODE=serial WS_SEND_DELAY_MS=10 yarn workspace @serfab/integration-tests exec vitest run blind-relay-phone-to-phone-e2e

# constant one-way latency — both tests pass (WS_SEND_DELAY_MS pins the whole process,
# so the committed arm's own 10 ms request is logged and ignored)
WS_SEND_DELAY_MS=50 yarn workspace @serfab/integration-tests exec vitest run blind-relay-phone-to-phone-e2e
```

## A caveat on the frame counts, before this reply is sent

The draft above quotes "4,735 outbound frames across 4 dialed sockets, 2,192 on the busiest". That figure was read off the fixture's periodic 5 s progress line, which is a RUNNING SUBTOTAL, not a total — the environment path has no end-of-run hook at all (vitest recycles its forked workers rather than exiting them). Re-measured on 2026-09-21 at the one boundary that does declare a total, the same loopback journey counts 11,939 and 12,531 frames over two runs.

The two windows are not identical — the boundary-declared one also covers the loopback arm's teardown — so this is a reason to re-measure before sending, not proof the older number is wrong. The 10 ms threshold conclusion, which is what the reply is actually about, does not depend on it: that rests on `pipelined` passing and `serial` failing, both of which still reproduce. But the frame count is quoted to an external reporter as a hard number, so it is worth confirming rather than sending as-is.

All figures above were measured on 2026-09-20 on one Windows machine, four nodes in a single process over the loopback dedicated relay. Single runs except where a spread is given.
