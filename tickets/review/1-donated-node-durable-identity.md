---
description: Machines lent to another person's group now keep one network identity in their own folder instead of inventing a new one at every start, so the group keeps recognising them and they keep the addresses they need to dial back in.
files: packages/cadre-host/src/orchestrator/node-identity.ts, packages/cadre-host/src/orchestrator/host-process-orchestrator.ts, packages/cadre-host/src/orchestrator/__tests__/node-identity.test.ts, packages/cadre-host/src/__tests__/orchestrator-node-identity.test.ts, docs/architecture.md, docs/cadre-host.md
difficulty: medium
---

# Review: donated nodes get a durable identity key in their workdir

## What changed

Donated nodes (every node `HostProcessOrchestrator.createContainer` spawns for a
requester) were launched with no identity of any kind: `CadreNode` generated a fresh
libp2p keypair per process, and because `cadre-cli start` opens
`FileBootstrapPeerStore` / `FileTrustedOwnerStore` only when
`config.identityProtobufKeyFile` is set, both node-local stores silently fell back to
in-memory. Result: a restart made the node a stranger to the cadre that approved it
*and* erased the dial addresses its seed nominated.

Three edits:

- **New `packages/cadre-host/src/orchestrator/node-identity.ts`** — `nodeIdentityPath(workdir)`
  and `ensureNodeIdentity(workdir)`. The latter is `loadIdentity` when
  `<workdir>/identity.key` exists and `generateIdentity` when it does not, both reused
  verbatim from `src/installer/identity.ts` (protobuf bytes, `mkdirSync` of the parent,
  `chmod 0600` on POSIX). No key handling was re-implemented.
- **`createContainer`** now computes the workdir via a new private
  `workdirFor(containerId)` (extracted from `launchChild`, which uses it too), ensures the
  identity before spawning, and passes `--identity-protobuf <path>` in `extraArgs`. That
  flag routes through `CADRE_IDENTITY_PROTOBUF` → `identity.protobufKeyFile`, so
  `resolveConfig` populates `identityProtobufKeyFile` and both stores open in the workdir.
  `launchChild` and `ensureOwnerNode` are otherwise untouched — the owner node still
  supplies the host's own installer identity path and does not go through the new helper.
- **Docs** — `docs/architecture.md` cold-start-retries bullet (the "every
  `cadre-host`-spawned child" claim was false; now stated correctly plus what was broken
  before) and `docs/cadre-host.md` identity/anchor paragraph (new donated-node paragraph;
  also names the bootstrap-peer store file, which the paragraph previously omitted).

**Reuse, not rotation, is the load-bearing property.** Any path that re-spawns a donated
node with the same `containerId` must land on the same key; generating afresh would
reproduce the original bug.

## Use cases to validate

- **Fresh loan.** `createContainer({containerId:'donated-1', pinnedOwnerKeys:[…]})` →
  child's command line carries `--identity-protobuf <rootDir>/donated-1/identity.key`;
  that file exists and decodes via `privateKeyFromProtobuf` to a `12D3Koo…` peer id.
- **Restart of a live loan.** `stopContainer` then `createContainer` with the same
  `containerId` → identical peer id and identical file bytes. (Reuse is also unit-tested
  directly against `ensureNodeIdentity`.)
- **Loan terminated.** `removeContainer` → workdir gone, so identity key, bootstrap-peer
  store, and trusted-owner store all gone with it. Nothing the donated node persisted
  outlives the loan.
- **Owner node unaffected.** `ensureOwnerNode` still passes `config.identityPath`
  (`<dataDir>/identity.key`), and its workdir must NOT acquire a second key.
- **POSIX permissions.** `identity.key` is `0600`. (Mode assertion skipped on win32, as
  `installer/__tests__/identity.test.ts` does.)

## Validation run

- `yarn workspace @serfab/cadre-host test` — 57 files, 462 passed, 4 skipped.
- `yarn workspace @serfab/cadre-cli test` — 8 files, 94 passed.
- `yarn lint` — clean. `tsc --noEmit` on cadre-host — clean. `yarn workspace
  @serfab/cadre-host build` — clean (dist refreshed so integration-tests' dist-freshness
  globalSetup stays happy).
- New specs: `src/orchestrator/__tests__/node-identity.test.ts` (4 cases) and
  `src/__tests__/orchestrator-node-identity.test.ts` (3 cases, fake-CLI harness).

## Known gaps — treat the tests as a floor

- **No real node was started.** Both new specs use the fake-CLI entrypoint, so they prove
  the *spawn argument* and the *key file*, not that `FileBootstrapPeerStore` /
  `FileTrustedOwnerStore` actually materialise in the workdir. That link is inferred from
  `packages/cadre-cli/src/commands/start.ts:147-164` + `config/loader.ts:283-290` and is
  currently unproven end-to-end. An `integration-tests` scenario asserting
  `bootstrap-peers.<partyId>.json` appears in a donated node's workdir after a seed push
  would close it — not filed, since the sibling ticket
  `node-state-dir-decoupled-from-identity-key` touches the same seam and may want to own it.
- **Nothing in production re-spawns a donated node yet.** The reuse property is exercised
  only by the new tests; the missing re-spawn path is `backlog/bug-donated-nodes-never-respawned`.
- **Already-running donated nodes change peer id once.** Their workdirs have no
  `identity.key`, so the first restart under this code generates one. Those nodes had no
  stable id to begin with, so this is strictly an improvement, but it is a one-time change
  and not a migration.
- **Windows leaves the key at inherited ACLs** — `chmodSync` is a no-op there. Pre-existing
  behaviour of `installer/identity.ts`, not introduced here.

## Review findings

- Tripwire parked as a `NOTE:` at the p2p allocation in `createContainer`
  (`host-process-orchestrator.ts`): the p2p port is re-allocated per spawn, so a re-spawned
  donated node keeps its peer id but may announce a different port. Recoverable (it dials
  out to its retained bootstrap peers and republishes its own `CadrePeer` row), so it is
  conditional, not a defect; pinning the port per `containerId` belongs to
  `backlog/bug-donated-nodes-never-respawned` if reconnect latency ever bites.
- Donated nodes now also get a durable `FileTrustedOwnerStore` in their workdir. Harmless:
  the host re-supplies the pinned owner key via `CADRE_OWNER_KEYS` on every spawn, so the
  anchor recovered on its own before and simply persists now too.
