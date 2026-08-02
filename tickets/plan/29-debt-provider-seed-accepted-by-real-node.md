---
description: No test proves that a node hosted by the multi-tenant provider actually accepts a delivered join bundle — every existing test stops at the provider's own boundary, so the claim that the feature works end-to-end rests on a sibling product doing the same thing.
files: packages/cadre-provider/src/service/__tests__/container-seed-endpoint.test.ts, packages/cadre-provider/src/service/docker-orchestrator.ts, packages/cadre-provider/src/service/container-service.ts, packages/cadre-host/src/__tests__/orchestrator-pin-keys.test.ts, packages/integration-tests
difficulty: medium
---

# Prove a provider-hosted node accepts the seed the provider delivers

A "seed" is the signed bundle that tells a fresh node which peers form a cadre and how
to dial them. On the hosting-provider path a customer creates a container, names the
owner key(s) whose seeds that node should trust, and later hands the provider a seed to
deliver. Two independent gates decide the outcome: the provider must be allowed to
deliver (a per-container bearer token), and the node must be willing to honour what was
delivered (its own trust check against the keys it was started with).

Everything currently tested is on the provider's side of that boundary:

- the environment variable carrying the trusted keys is built and injected,
- the keys are forwarded from the create request through to the container runtime,
- the create endpoint validates and echoes the field,
- and `container-seed-endpoint.test.ts` replaces the network call with a stub, so no
  real node ever decides anything.

The claim "a customer creates a container with their key pinned, delivers a seed, and
the node accepts it" therefore rests on the *self-hosted* product (`cadre-host`) proving
the equivalent path with the same environment-variable contract — not on any test of the
provider itself. If the provider's side of that contract drifts (variable renamed, list
joined differently, injected under a condition that stops holding), every provider test
still passes and every customer's first seed is silently refused.

## What would close it

An integration scenario that runs a real node started the way the provider starts one
and shows the trust decision actually happening:

- a node process launched with the same environment the provider's orchestrator builds,
  with one owner key pinned;
- a seed signed by that owner delivered through the provider's delivery path;
- assertion that the node **accepted** it (peers added), and that a seed signed by a
  *different* owner is **refused** — the negative case is the one that proves the check
  is real rather than absent;
- ideally, a restart showing that the second seed from the same owner no longer needs the
  pin, because the first accepted seed is remembered on the container's durable volume.

Spawning a real Docker container in CI may be more than this is worth; driving a real
node child process with the provider-built environment gets nearly all the value. Either
is acceptable — what is not acceptable is another test that stubs the network call, since
that is exactly the layer this gap is about.

## Not in scope

The provider-side unit coverage already exists and is fine; this ticket is only about the
missing cross-boundary proof.
