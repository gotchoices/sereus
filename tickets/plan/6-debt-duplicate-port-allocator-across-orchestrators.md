---
description: Two of our node managers each keep their own private copy of the same little "which network ports are in use" tracker, so a fix or improvement to one silently misses the other.
files: packages/cadre-host/src/orchestrator/port-allocator.ts, packages/cadre-provider/src/service/docker-orchestrator.ts
difficulty: easy
---

# What is duplicated

Two orchestrators hand out ports from a bounded range, and each carries its own
implementation of the tracker that does it.

- `packages/cadre-host/src/orchestrator/port-allocator.ts` — exported class
  `PortAllocator` (45 lines), plus the helper `allocateNodePorts` (lines 66–91)
  that takes a node's whole four-port set all-or-nothing.
- `packages/cadre-provider/src/service/docker-orchestrator.ts` — a module-private
  class also named `PortAllocator` (lines 39–60), plus a method `allocatePorts(count)`
  (lines 82–91) that is the same all-or-nothing wrapper for three ports.

The `allocate()` and `release()` bodies are line-for-line identical between the
two classes — about 15 lines of exact overlap. The provider's copy is the
smaller one: it has no `markUsed()`, no `has()`, and no constructor validation
of the range, so a provider bug in any of those areas would have to be fixed
twice or would simply not exist to be fixed.

The duplication predates the ticket that noticed it
(`debt-failed-respawn-strands-donated-workdir`), but that ticket added the
second all-or-nothing wrapper, so the overlap is now wider than it was.

# Why it is worth closing

`@serfab/cadre-host` already depends on `@serfab/cadre-provider` (it implements
provider's `Orchestrator` interface), so one direction of sharing needs no new
dependency edge. The other option is `@serfab/cadre-core`, which both already
depend on.

# Expected outcome

One port tracker, imported by both orchestrators, keeping the richer of the two
feature sets (`markUsed`, `has`, range validation). The all-or-nothing "take N
ports or take none" wrapper is part of it, parameterised so both a three-port
and a four-port caller can use it — the provider tracks `health/metrics/p2p`
and cadre-host additionally tracks `admin`.

Behaviour must not change: cadre-host's port assignment order
(`health, metrics, p2p, admin`) is what existing deployments already hold, and
`allocateNodePorts`'s reserve-overrides-before-allocating rule exists so an
override that lands inside the managed range cannot be handed out twice.

# Not in scope

Anything about *which* ports get chosen, the size of the default range, or
persisting reservations across restarts. This is a de-duplication only.

The restart case is now filed separately as
`bug-provider-port-allocator-forgets-live-ports-on-restart` — it wants the
shared tracker's `markUsed`, so this ticket landing first makes it smaller, but
it stays out of scope here.
