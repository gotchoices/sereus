---
description: A node only keeps its durable notes — which group members to dial, which owners it trusts — when its key happens to be stored in one particular format; nodes configured any other way silently lose those notes on every restart.
prereq: donated-node-durable-identity
files: packages/cadre-cli/src/commands/start.ts, packages/cadre-cli/src/config/loader.ts, packages/cadre-cli/src/config/types.ts, packages/cadre-cli/test/protobuf-identity.spec.ts, docs/architecture.md, docs/cadre-host.md
difficulty: easy
---

# Node-local stores should not hinge on which identity source won

## What is wrong

`cadre-cli start` opens the two durable node-local stores — `FileBootstrapPeerStore` (the
cold-start dial addresses a seed nominated) and `FileTrustedOwnerStore` (the out-of-band
owner-key anchor) — only when `config.identityProtobufKeyFile` is set
(`packages/cadre-cli/src/commands/start.ts:147-164`). That field is populated by
`resolveConfig` **only** when `identity.protobufKeyFile` is the source that wins
(`packages/cadre-cli/src/config/loader.ts:283-290`).

So a node configured with `identity.keyFile` or `identity.privateKeyHex` has a perfectly
stable identity and still falls back to the in-memory stores: it forgets its dial addresses
on every restart, which is exactly the stranding the bootstrap-peer store was built to
prevent. Nothing about either store needs to sit beside a key — the addresses are not secret
and dialing grants no authority. The key's directory is being used purely as a convenient
location, and that coincidence is currently load-bearing for correctness.

## Expected behaviour

Every node the CLI runs keeps its node-local stores on disk, whatever form its identity is
configured in, in a directory that belongs to that node alone.

## Shape

Resolve an explicit node-state directory in `resolveConfig` and have `start.ts` open both
stores from it unconditionally:

- `ResolvedConfig.nodeStateDir: string` — new, always set.
- Precedence: explicit config (`nodeState.dir`, plus a `CADRE_NODE_STATE_DIR` entry in
  `ENV_MAPPINGS`) → otherwise the **directory containing the config file** that
  `resolveConfig` was handed. Every launcher already writes a per-node config into that
  node's own working directory (`cadre-host`'s orchestrator writes `<workdir>/cadre.json`),
  so that default is node-specific by construction.
- Drop the `config.identityProtobufKeyFile ?` gating in `start.ts`; keep
  `identityProtobufKeyFile` itself only if something else still reads it.

## Tradeoff to record in the handoff

This **relocates** the host's own owner node's existing stores, from `<dataDir>/` (beside
`identity.key`) to `<dataDir>/orchestrator/owner/`. That directory is deliberately preserved
across owner restarts (`ensureOwnerNode` never deletes it), and the owner node re-establishes
its anchor on its own — genesis `ensureOwnerKey` plus the operator pins — so the effect is a
one-time cold start of state that self-heals. Per the project's "no backwards compat yet"
rule this needs no migration, but it does need saying out loud in the docs: `docs/cadre-host.md`
currently tells operators to back up `<dataDir>` because it holds both the identity *and* the
node-local anchor, and that sentence stops being true.

## TODO

- Add `nodeState.dir` to `CliConfigFile`, `CADRE_NODE_STATE_DIR` to `ENV_MAPPINGS`, and
  `nodeStateDir` to `ResolvedConfig`; resolve it in `resolveConfig` with the precedence above.
- Open both stores from `config.nodeStateDir` in `start.ts`, ungated.
- Test in `packages/cadre-cli/test/`: `nodeStateDir` defaults to the config file's directory;
  an explicit `nodeState.dir` and the env override both win; a `keyFile`-identity config
  still yields a directory (the regression this ticket closes).
- Update the `docs/architecture.md` cold-start bullet ("under the identity-key directory") and
  the `docs/cadre-host.md` back-up-them-together paragraph.
- `yarn workspace @serfab/cadre-cli test`, `yarn workspace @serfab/cadre-host test`, `yarn lint`.
