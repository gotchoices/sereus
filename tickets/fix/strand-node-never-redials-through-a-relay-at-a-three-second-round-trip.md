description: On a connection slow enough that a message takes about a second and a half each way, a machine rejoining a shared workspace through a relay never manages to reach the other machine again — it keeps trying and every attempt gives up too early. At half that delay the same rejoin takes eleven seconds.
architecture: docs/architecture.md#replication-cluster-size
files:
  - packages/cadre-core/src/peer-join-backfill.ts (dialTimeoutMs default 3000, around line 95)
  - packages/cadre-core/src/strand-instance-manager.ts (the push dial budget, around line 1365; buildStrandRuntime)
  - packages/cadre-core/src/relay-reservation.ts (DEFAULT_RELAY_RESERVE_TIMEOUT_MS = 10_000, bounding a whole reservation drive)
  - packages/cadre-core/src/peer-dial.ts (DEFAULT_CONTROL_COHORT_DIAL_TIMEOUT_MS, the control-side analogue)
  - packages/cadre-core/src/cadre-node.ts (resolveCohortSeed, which contributed no addresses in every run below)
  - packages/integration-tests/src/harness/ws-latency.ts, packages/integration-tests/src/harness/counting-proxy.ts (the two delay instruments)
repro: verified
----

# A strand node cannot re-dial its peer through a relay once the round trip reaches three seconds

## What happens

Two relay-only machines (`listenAddrs: []`, a shared dedicated relay — the phone shape) share a strand. One of them detaches (`stopStrand`) and then re-attaches (`addStrand`) over the same local store. At a one-way link delay of 900 ms — a round trip of about 1.8 s — its strand node reaches the other machine's strand node again in about 11 seconds. At 1500 ms one way — a round trip of about 3 s — **it never reaches it at all**: not within 60 s, and not within 200 s.

This is a separate limit from the cohort read deadline that `implement/2-declare-cohort-read-deadline-for-relayed-phones` is about, and it is not fixed by declaring one: the 200 s run above was taken with a 5000 ms cohort deadline in force and behaved identically. It is also not the strand first-sync wait, which never gets a chance to matter because no strand peer is ever connected.

## What was measured

2026-09-26, one Windows developer machine. Reduced blind-relay topology: parties A and B are each one relay-only `CadreNode` on one shared loopback dedicated relay; A founds a closed strand, B forms and attaches and reads a row, `B.stopStrand(strandId)`, the one-way outbound frame delay is raised (`harness/ws-latency.ts`, `pipelined`), and B re-attaches with `addStrand` against the same raw-storage capture. The gate is "B's strand node holds a connection to A's strand node".

| one-way delay | round trip | B's strand node reaches A's again |
| --- | --- | --- |
| 900 ms | ~1.8 s | 11.2 s (2 runs) |
| 1500 ms | ~3 s | never — 60 s gate (1 run), 200 s gate (1 run) |

With `DEBUG='sereus:cadre*'`. Logs (pruned on the usual schedule): `tickets/.logs/strand-first-sync-fails-over-wan-cohort-deadline.redial-900-debug.log` and `...redial-1500-debug.log`.

What the logs show, at both delays:

- `resolveCohortSeed` finishes having contributed **no addresses**. Its strand-addr dials go to the relay, which speaks no `/sereus/strand-addr/1.0.0` — expected and benign for a dedicated relay — and the formation-carried seed is not in play on a re-attach. So on both runs B starts its strand node with an empty seed and finds its peer (or is found) by some other path. Establishing which path succeeds at 1.8 s is the first thing to pin down: it is what the 3 s case is failing to do.
- B's control-node relay reservation is `reserved` throughout, and `addStrand` itself resolves in 5-9 s at both delays. The failure is after that.

Only at 1500 ms: `peer-join-backfill ... push to peer=<a strand peer> failed for 30 block(s): dial timeout`. No such line appears in the 900 ms run. That is the one behavioural difference the logs name, and it is the obvious place to start.

## Hypothesis

One or more dial budgets in cadre-core are shorter than a circuit-relayed connection setup costs at a 3 s round trip, and every retry hits the same wall, so the machine never gets past the first handshake. A relayed connection setup is several round trips (relay hop connect, Noise handshake, multistream, identify), so at 3 s per round trip it needs tens of seconds, and these budgets are single-digit:

- `peer-join-backfill.ts`'s `dialTimeoutMs` default of **3000 ms** — one round trip, before any handshake.
- The strand push dial budget in `strand-instance-manager.ts`, also **3000 ms** by default.
- `DEFAULT_RELAY_RESERVE_TIMEOUT_MS`, **10 s** for a whole reservation drive (dial, reservation request and the wait for the circuit address).
- libp2p's own connection-manager dial timeout as `@optimystic/db-p2p` configures it. Read that before assuming anything about it, and do not edit the sibling checkout (`tickets/rules/sibling-repos.md`).

Unverified: which of these actually bounds the attempt that matters, and whether raising it is enough or the retry ladder also gives up. The discriminating experiment is to raise each candidate in turn and re-run the 1500 ms recipe above.

## Questions this has to answer before it becomes an implement ticket

- Which budget bounds the successful 1.8 s re-dial, and how much headroom does it have there? An 11 s re-dial against a 10 s budget would mean 1.8 s is already at the edge and the 3 s failure is the same defect one step further along.
- Is a 3 s round trip a condition sereus intends to carry? A congested mobile or satellite link reaches it; an ordinary one does not. If the answer is no, the outcome may be a documented boundary plus a clearer failure than "the connection never appears" — but say so deliberately rather than by omission.
- Does anything retry indefinitely at a cost while this is failing? The 200 s run showed backfill pushes repeating; a phone burning a relay's bandwidth on dials that can never complete is worth knowing about either way.

## Reproduction recipe

There is no committed instrument for the shape. See `implement/2-declare-cohort-read-deadline-for-relayed-phones` → "How to re-measure" for the recommended home (a new opt-in configuration of `relay-round-trip-measure.integration.ts`) and for why the delay has to be raisable after formation rather than set from the start. The scratch scenario used here was not committed.
