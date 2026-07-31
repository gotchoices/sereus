description: The self-hosted manager hands its own entire environment to every node it launches, so a single setting meant for the manager can silently reconfigure — or misconfigure — all of its child nodes at once.
files: packages/cadre-host/src/orchestrator/host-process-orchestrator.ts, packages/cadre-cli/src/config/types.ts
difficulty: easy
---

# Problem

`HostProcessOrchestrator.launchChild` builds each child node's environment as
`{ ...process.env, ...extraEnv, <fixed per-child vars> }`. It pins only the
vars it explicitly cares about (startup token, health/metrics ports, listen
addrs, seed token, and — as of the `node-state-dir-decoupled-from-identity-key`
review — the node-state directory). **Every other** `CADRE_*` variable set on
the manager process leaks into every child.

The cli's `ENV_MAPPINGS` table turns those inherited vars into config
overrides, and an env override beats the per-child config file the orchestrator
writes. So an operator who sets one of these on the manager — reasonably
expecting it to configure the manager — silently overrides it for all children:

| Inherited var | Effect on every child node |
|---|---|
| `CADRE_PARTY_ID` | every node joins that party, ignoring the party its config names — a donated node lands in the wrong cadre |
| `CADRE_STORAGE_PATH` | all nodes share one storage directory |
| `CADRE_IDENTITY_PROTOBUF` | all nodes assume the SAME libp2p identity (same peer id) |
| `CADRE_BOOTSTRAP_NODES`, `CADRE_PROFILE`, `CADRE_STRAND_FILTER`, `CADRE_PUSH`, … | uniformly override per-child values |

This is not hypothetical breakage of an obscure path: the per-child config file
the orchestrator writes exists precisely to give each node distinct values, and
inheritance defeats it. It is pre-existing (not introduced by the node-state
work), which is why it is filed rather than fixed inline.

# Expected behavior

A child node's configuration should come from the config file the orchestrator
wrote for it plus the vars the orchestrator deliberately sets — never from an
ambient value on the manager process.

Concretely: the child environment should start from a **scrubbed** copy of
`process.env` with every key in the cli's `ENV_MAPPINGS` set removed, then have
the orchestrator's own per-child vars applied on top. Non-config vars the child
genuinely needs from the ambient environment (`PATH`, `NODE_OPTIONS`, `DEBUG`,
`HOME`/`APPDATA`, TLS/proxy vars) must keep flowing through.

The var list is owned by `@serfab/cadre-cli` (`ENV_MAPPINGS` in
`src/config/types.ts`); it should be exported and consumed rather than
re-listed in cadre-host, so a new knob cannot be added on one side and forgotten
on the other. Note `ENV_MAPPINGS` is not the whole set — env-only vars
(`CADRE_SEED_TOKEN`, `CADRE_OWNER_KEYS`, `CADRE_STARTUP_TOKEN`,
`CADRE_HEALTH_PORT`, `CADRE_METRICS_PORT`) also belong in the scrub set; the
orchestrator sets each of those per child anyway, so scrubbing them is
belt-and-braces.

Worth a test that spawning two children with different party ids keeps them
distinct while a conflicting `CADRE_PARTY_ID` is set on the parent process.

`cadre-provider`'s `DockerOrchestrator` does not have this problem — it builds
the container's `Env` list explicitly and inherits nothing.
