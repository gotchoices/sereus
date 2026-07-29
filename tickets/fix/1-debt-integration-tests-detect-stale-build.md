----
description: Some tests launch the real command-line app as a separate program, and if that program was not rebuilt after a code change they quietly test the old version — failing minutes later with a timeout that says nothing about the real cause.
files:
  - packages/integration-tests/src/scenarios/cadre-host-node-donation.integration.ts
  - packages/integration-tests/src/scenarios/cadre-host-owner-node.integration.ts
  - packages/cadre-host/src/orchestrator/host-process-orchestrator.ts
  - packages/integration-tests/package.json
difficulty: easy
----

# Integration scenarios should fail fast on a stale build

## What happens today

A few integration scenarios do not import the code under test — they **spawn the
real `cadre-cli` executable as a child process** and drive it over the network.
That executable runs from the compiled output in `packages/*/dist`, not from
`packages/*/src`. So if someone edits source and runs the scenario without
running `yarn build` first, the child is silently the *previous* build.

The scenario file says so in a header comment ("requires `@serfab/cadre-cli` and
`@serfab/cadre-host` to be built"), but nothing enforces it.

## Why it is worth fixing

The failure mode is expensive and misleading. Observed while reviewing the
seed-trust anchor work: `cadre-host-node-donation` failed with

```
step 4–5: ... → Timeout waiting for donated node accepts seed after 30000ms
step 6: ...   → Test timed out in 90000ms
```

That took ~2.5 minutes to produce and reads like a real regression in seed trust.
The actual cause was an out-of-date `dist`; the same run passed 5/5 immediately
after `yarn build`. Anyone — human or agent — can lose a long debugging detour to
this, and the risk is worst exactly when the change under test is a security
behaviour change, because "the node no longer accepts the seed" is a *plausible*
outcome of the edit.

## Expected behaviour

Before spawning a real binary, a scenario should establish that the build is
current, and if it is not, fail immediately with a message naming the fix
(`yarn build`) rather than timing out later.

Possible directions (for the implementer to choose between, not a plan):

- Have the integration-tests package's test script depend on a build, so the
  scenarios cannot run against stale output at all.
- A cheap freshness assertion in the scenarios' setup: compare newest source
  mtime against the built entry point's mtime for the packages being spawned,
  and throw a clear error on inversion.
- Have the spawned child report its own version/build identity on startup and
  assert it matches the workspace.

Whatever is chosen should cover every scenario that spawns a real binary, not
only the donation one, and must not slow down the ordinary in-process scenarios.
