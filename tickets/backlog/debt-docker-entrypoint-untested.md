----
description: The startup script inside the hosted-node Docker image is never run by any test. Every test that claims to cover a hosted node actually runs a hand-written stand-in for that script, so if the real one drifts, nothing notices until a customer's node fails to start.
prereq:
files: packages/cadre-cli/docker/entrypoint.sh, packages/cadre-cli/docker/Dockerfile, packages/integration-tests/src/harness/provider-process-orchestrator.ts, packages/integration-tests/src/scenarios/provider-seed-accepted.integration.ts
difficulty: medium
----

# Nothing runs `entrypoint.sh`

`packages/cadre-cli/docker/entrypoint.sh` (190 lines) is what actually starts every node the
multi-tenant provider hosts. On first boot it mints the node's identity key into the container's
durable `/data` volume, generates the node's `cadre.yaml` from environment variables, and derives
and exports two more variables (`CADRE_KEY_FILE`, `CADRE_NODE_STATE_DIR`) that the node re-applies
over its config on every start.

No test executes it. The closest coverage is
`packages/integration-tests/src/harness/provider-process-orchestrator.ts`, which **reimplements**
the script's behaviour in TypeScript so scenarios can start real `cadre-cli` child processes without
Docker. That harness is what `provider-seed-accepted.integration.ts` proves the provider→node
environment contract against — a genuinely valuable test, but it proves the contract against the
*copy*, not the original.

## Why it matters

The two can drift silently in both directions:

- a change to the real script (a renamed variable, a reordered step, a new default) leaves every
  test green while every customer container fails to start or comes up misconfigured;
- a change to the provider's environment output that the harness is updated for, but the script is
  not, has the same effect.

The failure mode is not subtle — it is "the hosted product does not work" — but it is invisible
until someone builds and runs the image.

## What would close it

Some check that runs the real script and observes the real effects. Shape is open; a few
directions, cheapest first:

- run `entrypoint.sh` under a shell against a temp directory with the provider's environment set,
  and assert the identity file, the generated config, and the exported variables — no Docker, no
  image build, but it does need a POSIX shell (the repo is developed on Windows, so this needs a
  decision about where such a test may run);
- build the image and run one container end-to-end, seeding it the way `provider-seed-accepted`
  seeds its in-process children — highest fidelity, but an image build is too slow for the normal
  test run and would need its own opt-in job;
- extract the script's derivations into something both the image and the harness consume, so there
  is only one copy to test. This is the structural fix and probably the right one, but it changes
  the image, so it is a design decision rather than a test-coverage task.

Whoever takes this should pick one deliberately — the first option buys most of the value for
little cost, and the third makes the problem stop recurring.

## Related, deliberately not merged

`backlog/cadre-docker-build-reproducibility` also touches the Docker directory, but it is about the
`Dockerfile`'s non-immutable `yarn install` regenerating the lockfile per build. Different file,
different problem.
