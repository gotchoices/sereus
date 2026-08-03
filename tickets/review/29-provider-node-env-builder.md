description: Pulled the hosting provider's container-environment list (party id, bootstrap peers, seed token, owner keys, etc.) out of the Docker orchestrator's inline code into one shared function, so tests outside Docker can build a node the same way the provider does.
files: packages/cadre-provider/src/service/container-env.ts, packages/cadre-provider/src/service/docker-orchestrator.ts, packages/cadre-provider/src/index.ts, packages/cadre-provider/src/service/__tests__/container-env.test.ts
difficulty: easy
---

# Provider node-env builder — extraction complete

Pure extraction, no behaviour change, per ticket `29-provider-node-env-builder`.

## What changed

- New `packages/cadre-provider/src/service/container-env.ts`: exports
  `buildNodeEnv(spec: NodeEnvSpec): string[]` plus `NodeEnvPorts` /
  `NodeEnvSpec` types. Builds the exact same ordered, `.filter(Boolean)`-ed
  `KEY=value` array `DockerOrchestrator.createContainer` used to build inline
  (`docker-orchestrator.ts:197-252` before this change) — all explanatory
  comments (seed-token rationale, `CADRE_PUSH` PEM-newline note, the
  `CADRE_OWNER_KEYS` "never a bare var" note) moved across verbatim onto the
  code that now owns them.
- `ports` param defaults to `{ health: 8080, metrics: 9090, p2p: 4001 }` —
  the image's fixed in-container ports, matching today's literals exactly.
  Nothing in the provider passes a non-default `ports`; it exists so the
  planned non-Docker consumer (`debt-provider-seed-accepted-by-real-node`,
  which starts a real `@serfab/cadre-cli` child) can substitute real ports.
- `DockerOrchestrator.createContainer` now calls
  `Env: buildNodeEnv({ request, seedToken, resources })` — `resources` is
  still computed once (`request.resources ?? this.config.defaultResources ?? {}`)
  in the orchestrator and shared with the `Memory`/`NanoCpus` HostConfig
  parsing, per the ticket's "resource merge site" note.
- Re-exported `buildNodeEnv`, `NodeEnvPorts`, `NodeEnvSpec` from
  `packages/cadre-provider/src/index.ts`.

## Retarget check (ticket asked to verify)

`container-owner-keys.test.ts` does **not** assert on the `Env` array — it
drives `ContainerService` against a fully mocked `Orchestrator`
(`createContainer: vi.fn()`), so `DockerOrchestrator`/`Env` never enters that
file. No retarget was needed or done there. The tests that *did* assert on
`Env` are `orchestrator-port-leak.test.ts` (seed-token/PortBindings) and
`docker-orchestrator-push.test.ts` (`CADRE_PUSH` / `CADRE_OWNER_KEYS`) — both
left as-is; they still pass unmodified against the refactored orchestrator.

## New tests (`container-env.test.ts`)

- Minimal request → exactly the seven always-present vars, no empty entries.
- `pinnedOwnerKeys: ['a','b']` → contains `CADRE_OWNER_KEYS=a,b`; `[]` and
  `undefined` → no `CADRE_OWNER_KEYS` key at all (two separate cases, per the
  ticket's `?.length` vs `?.join` distinction).
- Custom `ports` → `CADRE_HEALTH_PORT` / `CADRE_METRICS_PORT` /
  `CADRE_LISTEN_ADDRS` carry the substituted values.
- Equality test against `fake-docker.ts`: spins up a real `DockerOrchestrator`
  with a fake dockerode, captures the `Env` array passed to
  `createContainer`, and asserts it **equals**
  `buildNodeEnv({ request, seedToken: result.seedToken, resources: request.resources })`
  for a request exercising every optional field (`strandFilter`, `resources`,
  `push`, `pinnedOwnerKeys`) — this is the assertion that keeps the shared
  function honest as what the provider actually sends, not a parallel copy.

## Validation run

- `yarn workspace @serfab/cadre-provider typecheck` — clean.
- `yarn workspace @serfab/cadre-provider test` — 20 files / 132 tests passed
  (126 pre-existing + 6 new in `container-env.test.ts`).
- `yarn lint` — clean, repo-wide.

## Gaps / notes for reviewer

- No behaviour change was intended or made; this is scoped extraction only.
  Worth a diff-read of `docker-orchestrator.ts`'s `createContainer` to
  confirm nothing besides the `Env:` line moved.
- `buildNodeEnv` is not yet consumed by anything outside
  `DockerOrchestrator` — the actual non-Docker consumer is
  `tickets/implement/29.5-provider-seed-accepted-by-real-node.md`, which
  lists `prereq: provider-node-env-builder` (this ticket) and is now
  unblocked. This ticket only makes that consumer possible; it doesn't add it.
- Didn't add a test asserting `buildNodeEnv`'s return type/shape independent
  of the orchestrator wiring (e.g. exported symbol shape) — TypeScript
  compilation of `index.ts`'s re-export is the only check that the exported
  types line up; if the reviewer wants a stronger contract test, none exists
  yet.
