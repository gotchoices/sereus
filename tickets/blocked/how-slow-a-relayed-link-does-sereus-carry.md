description: On a connection slow enough that a message takes about a second and a half each way, two machines that can only reach each other through a relay can no longer connect at all, and nothing sereus owns can change that — the two limits responsible live in a networking library we depend on and are not adjustable from here. This asks for a decision: is that speed one we intend to support, and if so, do we ask that library for the two settings?
architecture: docs/architecture.md#relay-integration
files:
  - packages/integration-tests/src/scenarios/relayed-dial-cost-by-latency.integration.ts (the committed opt-in measurement behind every number here)
  - ../optimystic/packages/db-p2p/src/libp2p-node-base.ts (lines 698-707: the hardcoded `connectionManager`, and `NodeOptions`, which exposes no way in)
  - docs/architecture.md#relay-integration (where a declared ceiling would go)
  - tickets/implement/1-dial-budgets-that-count-round-trips-not-milliseconds.md (the half sereus can do on its own)
repro: verified
----

# Decision: how slow a relayed link does sereus intend to carry, and do we ask db-p2p for the two settings that decide it?

**Blocked because a dependency outside this repo owns the fix** — the two limits are in `@optimystic/db-p2p`, a sibling repository this repo must not edit (`tickets/rules/sibling-repos.md`) — **and because nothing states how slow a link sereus means to support, so there is no way to judge from here whether the limits are wrong.** What unblocks it: an answer to the question below. If the answer is "yes, carry it", the follow-on is a request to db-p2p to expose two libp2p settings on `NodeOptions`; if the answer is "no", the follow-on is a documented ceiling and a clearer failure, and no upstream work at all.

## What was measured

Committed, opt-in, reproducible: `RELAY_DIAL_COST=1 yarn workspace @serfab/integration-tests exec vitest run relayed-dial-cost-by-latency`. Its doc comment is the single home of the numbers. On one Windows machine, over a loopback relay, with a constant one-way delay injected on every frame a node sends:

**Opening a connection to another machine through a relay costs a fixed number of exchanges — 8 one-way link delays — so a limit expressed in milliseconds has a link speed above which it can never succeed.** It took 26 ms with no delay, 7.3 s at 900 ms one-way, and 12.1 s at 1500 ms one-way.

Two limits of 10 000 ms each bound that work, and neither can be set from sereus:

- **The dialing side.** libp2p's connection manager gives a dial 10 s by default. `db-p2p` does not set it and does not expose it, so every dial made without a caller's own deadline gets 10 s. Above ~1250 ms one-way that is less than the connection costs, so the dial is abandoned — every time, forever.
- **The listening side**, and this is the one that makes the failure unreadable. `db-p2p` sets `inboundUpgradeTimeout: 10_000`, so the machine being called abandons the half-built connection at 10 s. At 1500 ms one-way the caller's own dial still *succeeds* (12.1 s) — so it believes it has a connection, while the other machine has already thrown it away. Every stream on it then dies with `Unexpected EOF - stream closed while reading 0/1 bytes`, and the called machine reports no peer at all. That is exactly what the 2026-09-26 reproduction logs show, repeating about every 14.5 seconds for the whole run.

So the boundary is not gradual. Below about a 2.5-second round trip a rejoining machine reconnects (measured 11.2 s end to end at a 1.8-second round trip). Above it, it never does, and the symptom is silence rather than an error.

## The question

Does sereus intend to work on a link with a round trip of about 3 seconds?

A congested mobile connection or a satellite link reaches that. An ordinary mobile or home connection does not — the measurements the current budgets were sized against are a 1.8-second round trip, which works today. Nothing in `docs/` states a ceiling either way, which is why this is a decision and not a bug.

## Recommended default, for a human to accept or edit

**Yes, carry it — up to a 3-second round trip — and say so in `docs/architecture.md` → Relay Integration.** Proposed wording:

> A machine that reaches its cadre only through a circuit relay pays a fixed number of round trips per connection, not a fixed number of milliseconds: about eight one-way link delays to open one. Sereus supports such a machine up to a **3-second round trip** (1.5 s each way) — a congested mobile or satellite link. Every dial budget on that path is therefore derived from a declared link round trip rather than chosen as a duration, and the two libp2p limits that bound it (`connectionManager.dialTimeout` and `connectionManager.inboundUpgradeTimeout`) are declared, not left at their defaults. Above the declared ceiling a relayed connection cannot be opened at all, and the machine must say so rather than wait.

Accepting that has one consequence outside this repo: **db-p2p must expose those two settings on `NodeOptions`.** The request is small and has a precedent in the same file — `connectionMonitor?: ConnectionMonitorInit` was added for exactly this kind of reason (`complete/slow-peer-dropped-on-ping-timeout`), as a type-only passthrough with no default of its own. The same shape works here: pass `connectionManager` through (or just the two fields), keep `maxConnections: 16` as the default it already has, and substitute no default for the two budgets so libp2p's own remain in force when nothing is declared. Worth telling db-p2p at the same time, from the same measurement: its `DEFAULT_DIAL_TIMEOUT_MS` and the several `pushDialTimeoutMs ?? 3000` defaults cannot open a relayed connection above **375 ms one-way**, so on any relayed link every one of those RPCs fails its dial before it starts.

## Alternatives considered, and why they are not the recommendation

- **Declare the ceiling at 2 seconds round trip and stop there.** No upstream work, and it is honest about what ships today. Rejected as the default because the shape of the failure — the called machine silently discarding a connection the caller thinks it has — is bad whatever the ceiling is, and because the link that reaches 3 seconds is a congested phone, which is the deployment sereus exists for.
- **Give every cadre dial its own long deadline and never rely on libp2p's default.** Tempting, because a caller's signal replaces `dialTimeout` entirely. It does not work: the *listener's* `inboundUpgradeTimeout` is not a caller's to pass, so the called machine still abandons the connection at 10 s. This is why the fix cannot be done from sereus alone.
- **Vendor or fork the libp2p node construction inside sereus.** Would work and needs no upstream change. Rejected: it duplicates `libp2p-node-base.ts`'s whole option set, which carries a dozen decisions of its own, to reach two fields.

## If we do nothing

Sereus keeps working up to about a 2.5-second round trip and fails silently above it — the machine rejoins, reports nothing wrong, holds no connection, and retries a dial that cannot complete roughly every 14.5 seconds for as long as it is left running. That last part is a cost paid on a relay's bandwidth by a phone that can never succeed. `implement/1-dial-budgets-that-count-round-trips-not-milliseconds` lands the part sereus owns regardless (the block catch-up's 3-second dial budget, which has never once worked through a relay), so "do nothing here" is not "do nothing at all".

## Reversibility

High. A declared ceiling in a document and two passthrough fields are both cheap to change; no data format, protocol or stored state is involved, and the measurement that would justify a different ceiling is committed and takes about two minutes to run.
