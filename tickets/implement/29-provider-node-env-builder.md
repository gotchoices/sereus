---
description: The list of settings the hosting provider hands a new customer node is built inline inside its Docker code, so nothing outside Docker can reproduce it — pull that list into one shared function so a test can start a real node exactly the way the provider does.
files: packages/cadre-provider/src/service/docker-orchestrator.ts, packages/cadre-provider/src/service/container-env.ts, packages/cadre-provider/src/index.ts, packages/cadre-provider/src/service/__tests__/container-owner-keys.test.ts, packages/cadre-provider/src/service/__tests__/fake-docker.ts
difficulty: easy
---

# Extract the provider's node environment into one reusable function

`DockerOrchestrator.createContainer` builds the container's environment as an
inline array literal inside the `docker.createContainer({ ... })` call
(`packages/cadre-provider/src/service/docker-orchestrator.ts:197-252`). That array
is the entire contract between the provider and the node it starts: party id,
bootstrap peers, profile, listen address, health/metrics ports, the per-container
`CADRE_SEED_TOKEN` that gates `POST /seed`, and — the load-bearing one —
`CADRE_OWNER_KEYS`, the comma-separated owner keys the node must pin to accept
its first delivered seed.

Because the array is inline, the only way to observe it is through dockerode.
The follow-on ticket `provider-seed-accepted-by-real-node` needs to start a real
`@serfab/cadre-cli` child with *that exact environment* (no Docker), so the
environment has to become a value the rest of the repo can obtain.

This ticket is pure extraction — no behaviour change.

## Shape

New module `packages/cadre-provider/src/service/container-env.ts`:

```ts
/** Ports as seen INSIDE the container (the image's EXPOSE set), not host ports. */
export interface NodeEnvPorts {
  health: number;    // 8080 in the image
  metrics: number;   // 9090 in the image
  p2p: number;       // 4001 in the image
}

export interface NodeEnvSpec {
  request: OrchestratorCreateRequest;
  /** Per-container secret gating POST /seed. */
  seedToken: string;
  /** Defaults to { health: 8080, metrics: 9090, p2p: 4001 }. */
  ports?: NodeEnvPorts;
  /** Effective resources (request.resources merged with the config default). */
  resources?: ContainerResources;
}

/** `KEY=value` entries, empty ones already dropped — Docker `Env` order preserved. */
export function buildNodeEnv(spec: NodeEnvSpec): string[];
```

`DockerOrchestrator.createContainer` then reads
`Env: buildNodeEnv({ request, seedToken, resources })` and keeps every existing
comment about *why* each var is there (move the comments with the code; they are
the only place the seed-token / owner-key rationale is written down).

Export `buildNodeEnv` and its types from `packages/cadre-provider/src/index.ts`
so a consumer outside the package (integration-tests) can import them.

The `ports` parameter exists solely so a non-Docker consumer can substitute real
host ports for the image's fixed in-container ports. Nothing in the provider
passes it; the default reproduces today's literals exactly.

## Edge cases & interactions

- **Empty-string filtering.** Today the array ends in `.filter(Boolean)`, so
  `strandFilter`, `CADRE_STORAGE_QUOTA`, `CADRE_PUSH`, and `CADRE_OWNER_KEYS`
  vanish when unset. `buildNodeEnv` must return the same filtered list — a
  `CADRE_OWNER_KEYS=` entry present-but-empty would make a node *look*
  configured while trusting nobody (that distinction is called out in the
  existing comment at `docker-orchestrator.ts:214-221`).
- **`pinnedOwnerKeys: []`** must produce no `CADRE_OWNER_KEYS` entry at all
  (`?.length` guard, not `?.join`).
- **`push` JSON encoding.** `CADRE_PUSH` is `JSON.stringify(request.push)` —
  keep it, and keep it out of any log line the extraction touches.
- **Resource merge site.** Today `resources` is computed once
  (`request.resources ?? this.config.defaultResources ?? {}`) and used for both
  the env quota var and the Docker memory/cpu limits. Leave that computation in
  the orchestrator and pass the result in, so the memory/cpu path keeps seeing
  the same object.
- **Order stability.** Some existing test may match on the array; keep the
  emitted order identical to the current literal.

## Tests

Provider package (`yarn workspace @serfab/cadre-provider test`):

- `buildNodeEnv` with a minimal request emits exactly the seven always-present
  vars, no empty entries.
- With `pinnedOwnerKeys: ['a','b']` → contains `CADRE_OWNER_KEYS=a,b`; with
  `[]` or `undefined` → no `CADRE_OWNER_KEYS` key at all.
- With custom `ports` → `CADRE_HEALTH_PORT` / `CADRE_METRICS_PORT` /
  `CADRE_LISTEN_ADDRS` carry the substituted values.
- Against `fake-docker.ts`: the `Env` array `DockerOrchestrator` passes to
  `createContainer` **equals** `buildNodeEnv(...)` for the same request — this
  is the assertion that keeps the shared function honest as the real thing the
  provider uses, rather than a parallel copy. Check whether
  `container-owner-keys.test.ts` already asserts on `Env`; if so, retarget it at
  `buildNodeEnv` rather than duplicating.

## TODO

- Add `container-env.ts` with `buildNodeEnv` + types; move the explanatory
  comments across verbatim.
- Rewrite `DockerOrchestrator.createContainer` to call it; verify the resources
  object is still shared with the memory/cpu limit parsing.
- Re-export from `src/index.ts`.
- Add/retarget unit tests as above.
- `yarn workspace @serfab/cadre-provider typecheck && yarn workspace @serfab/cadre-provider test 2>&1 | tee /tmp/provider-env.log`
- `yarn lint`
