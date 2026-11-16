description: The node-rental service's default setting for fetching the node image is named "if not present", but it never fetches anything, so on a machine that lacks the image every rental fails until an operator loads the image by hand.
architecture: packages/cadre-provider/README.md#settings
files: packages/cadre-provider/src/service/docker-orchestrator.ts, packages/cadre-provider/src/config/types.ts, packages/cadre-provider/src/config/schema.ts, packages/cadre-provider/example.provider.yaml, packages/cadre-provider/README.md
repro: static
severity: edge-case
likelihood: unusual
tradeoffs: No node image is published to a registry, so with the default image name a pull could not succeed anyway; the setting only helps an operator who pushed the image to a registry of their own, and the README already says what the code does today.
----

# The default image pull policy never pulls

## What is wrong

cadre-provider's `docker.pullPolicy` setting accepts three values: `always`, `if-not-present` and `never`. The default is `if-not-present` (`DEFAULT_CONFIG` in `config/types.ts`, and `example.provider.yaml`).

`DockerOrchestrator.createContainer` has one branch on the setting: it calls `pullImage()` when the value is `always`. No code inspects whether the image is on the Docker host. `if-not-present` and `never` therefore do the same thing, which is nothing, and the default behaves as `never`.

When the image is absent, Docker refuses the container create, the orchestrator releases the ports and the container record ends in `error`. Every rental on that host fails the same way until someone builds or loads the image.

`packages/cadre-provider/README.md` (Prerequisites and the Settings table) now describes this behaviour accurately, so the documentation is not wrong. The setting's name is: the same three names in Docker Compose and Kubernetes mean "pull when the image is missing" for the middle value, and an operator reading the config file will assume that.

## Expected behaviour

One of these, chosen when the ticket is planned:

- `if-not-present` checks the Docker host for `docker.image` before a create and pulls when the image is missing. The provisioning time limit (`CONTAINER_PROVISIONING_TTL_MS` in `container-service.ts`) already allows for a pull during create.
- Or the value is removed from the schema and the default becomes `never`, so the config file says what happens.

Whichever is chosen, a failed pull should end the create in `error` with the pull failure as the reason, as `always` does today.

## Use case

An operator pushes the node image to a private registry, sets `docker.image` to that name, leaves `pullPolicy` at its default, and adds a second Docker host. The second host never receives the image, and rentals placed there fail.

## Evidence

Read from the code, not run. `createContainer` in `docker-orchestrator.ts` is the only reader of `pullPolicy` in `packages/cadre-provider/src` (a search for `pullPolicy` finds the type, the schema entry, the default and that one comparison). No spec under `src/service/__tests__` sets `pullPolicy` or covers `pullImage`.

To confirm at run time: start a provider with the Docker orchestrator and the default policy against a Docker host that lacks `docker.image`, post a container create, and observe that the record ends in `error` and that the Docker daemon received no pull request.
