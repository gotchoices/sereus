---
description: Writes to the shared party database survive a brief network hiccup by being retried; reads do not, so a momentary blip makes an ordinary lookup fail outright even though repeating it a moment later would work.
files: packages/cadre-core/src/control-database.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/control-write-retry.ts
severity: wrong-result
likelihood: normal-use
tradeoffs: Reads are cheap and most callers are on a timer that will come round again, so a maintainer may reasonably judge the extra machinery (and the risk of masking a genuinely unreachable peer behind seconds of retrying) as not worth it.
repro: static
---

# Control-database reads have no transient-failure retry

## The asymmetry

Every write to the control database goes through one funnel
(`ControlDatabase.lockedWithRetry`) that classifies the failure and re-presents the write
up to three times inside a 10 s budget when the cause was transient — a cohort member that
did not answer, a stream that reset mid-flight. That funnel exists because those failures
were observed in the wild and are self-healing.

Reads go through nothing. `queryPeerRecord`, `queryCadrePeers`, `queryRevokedStamps` and
their siblings issue the query once and propagate whatever comes back. They are **not**
local-only: they cross the network to whichever machine coordinates the key, and a prior
successful read does not make the next one local.

## The observed instance

`CadreNode.registerSelf` — the periodic self-address publish every node runs — reads its
own row before writing it. During the review of the control-write retry coverage
(2026-08-12) that read was measured dying in **23–28 ms** on the first injected stream
reset:

```
Error during query on table 'Revocation': … cause=Cannot write to a stream that is closed
```

The write half of the same call, a few lines later, absorbs exactly that failure and
commits on its second attempt. So the transient class the retry was built for can still
take out the whole call — it just takes it out through the read half, before the funnel is
ever consulted. This is why the integration scenario has to drive `updateSelfPeerRecord`
directly rather than `registerSelf`.

## Why this is a class, not one call site

Retrying a read is *safer* than retrying a write: a read has no signature to re-present, no
use number to lose, and no indeterminate-commit hazard — the whole reason the write
classifier is narrow. So the shape wanted is not "retry this one query" but a read seam
with the same bounded policy, applied wherever a control read leaves the machine.

Two things a design pass must settle:

- **What counts as transient for a read.** The write classifier deliberately vetoes the
  transactor's commit-phase aggregate; a read cannot produce one, so a read classifier is
  a different (probably wider) set, not a reuse.
- **Where the budget lives.** Several control reads sit on hot paths that already have
  callers with their own deadlines (address resolution during a dial). Seconds of silent
  retrying inside one of those is its own failure mode.

## Not the same as the other read ticket

`blocked/control-reads-blocked-by-stalled-write` is about a read *waiting* behind an
in-flight write on the same node. This ticket is about a read *failing* on a transient
network fault with no second attempt. Different site, different fix; the standing `it.fails`
case in the degraded-cohort scenario belongs to that one, not this one.
