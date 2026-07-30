---
description: A machine lent to someone else's group generates a brand-new network identity every time it starts, so the group stops recognising it and it loses the addresses it needs to dial back in; give it a key of its own that it keeps in its working folder.
files: packages/cadre-host/src/orchestrator/host-process-orchestrator.ts, packages/cadre-host/src/orchestrator/types.ts, packages/cadre-host/src/installer/identity.ts, packages/cadre-host/src/__tests__/orchestrator-pin-keys.test.ts, packages/cadre-cli/src/commands/start.ts, packages/cadre-cli/src/config/loader.ts, docs/architecture.md, docs/cadre-host.md
difficulty: medium
---

# Give a donated node its own persistent identity key

## The defect, reproduced

`HostProcessOrchestrator.createContainer` is the only launcher in the repo that spawns
`cadre-cli start` with **no** identity of any kind. Verified against the real orchestrator
with the existing `spawn.entrypoint` fake-CLI harness (a throwaway spec, since removed —
the fix stage ships tickets, not tests): a fake CLI recorded its own launch and reported

- `--identity-protobuf` argument: absent (empty),
- `cadre.json` `identity` block: `null`,
- the donated node's workdir after spawn: `.startup-token`, `cadre.json`, `node.log`,
  `storage` — nothing identity-shaped, nothing store-shaped.

Two consequences, both of which the just-landed bootstrap-peer store was built to prevent:

- **New network identity on every start.** With `config.privateKey` undefined, `CadreNode`
  generates a fresh libp2p keypair per process. The requester's cadre approved the *old*
  peer id; after a restart the node is a stranger to it.
- **No durable node-local stores.** `cadre-cli start` opens `FileBootstrapPeerStore` and
  `FileTrustedOwnerStore` only when `config.identityProtobufKeyFile` is set
  (`packages/cadre-cli/src/commands/start.ts:147-164`). Donated nodes have no such path, so
  both silently fall back to the in-memory stores, and the dial addresses the requester's
  seed nominated are erased on restart. `DonationService.applySeed` is a one-time
  requester-driven call and is never replayed, so re-seeding is not a recovery path.

## The call this ticket makes

Give donated nodes a **real protobuf identity key file inside their own workdir**, and pass
it with `--identity-protobuf` exactly as `ensureOwnerNode` already does. One change fixes
both symptoms: the identity becomes stable, and because `--identity-protobuf` routes
through the `CADRE_IDENTITY_PROTOBUF` → `identity.protobufKeyFile` env mapping,
`resolveConfig` populates `identityProtobufKeyFile` and both node-local stores open in the
workdir. Terminating the loan already `rm -rf`s that workdir (`removeContainer`), so
everything the node persisted goes with it — the ticket's containment requirement.

The alternative — decoupling the two stores from the identity-key path — is worth doing on
its own merits and is filed separately as `node-state-dir-decoupled-from-identity-key`
(sequence 2). It is **not** a substitute for this ticket: it would fix the addresses and
leave the identity churning. Doing this one first also means store durability for donated
nodes never depends on that second change landing.

## Shape

A new small module rather than inline code in the orchestrator, so the idempotence is
directly testable:

```ts
// packages/cadre-host/src/orchestrator/node-identity.ts
/** Path to a managed node's own protobuf identity key inside its workdir. */
export function nodeIdentityPath(workdir: string): string;

/**
 * Ensure `<workdir>/identity.key` exists, generating an Ed25519 protobuf key on
 * first call and REUSING it on every later call. Returns the path and the
 * resulting peer id (for logging).
 */
export function ensureNodeIdentity(workdir: string): Promise<{ path: string; peerId: string }>;
```

`generateIdentity` / `loadIdentity` in `src/installer/identity.ts` already do exactly the
write (protobuf bytes, `mkdirSync` of the parent, `chmod 0600` on POSIX) and the read. Reuse
them — do not re-implement key handling. `ensureNodeIdentity` is `loadIdentity` when the
file is present, `generateIdentity` when it is not.

`createContainer` then computes the workdir the same way `launchChild` does, ensures the
identity before spawning, and passes the flag:

```ts
const workdir = this.workdirFor(request.containerId);
const identity = await ensureNodeIdentity(workdir);
return this.launchChild({
  …,
  extraArgs: ['--identity-protobuf', identity.path],
});
```

`launchChild` currently derives `workdir` itself with `join(this.rootDir, containerId)`;
extract that into a private `workdirFor(containerId)` and use it in both places rather than
duplicating the join. `launchChild` otherwise stays untouched — `ensureOwnerNode` keeps
supplying the host's own identity path and must NOT be routed through the new helper.

**Reuse, not rotation, is the load-bearing property.** Any code path that re-spawns a
donated node with the same `containerId` must land on the same key. Generating a fresh key
when the file already exists would reproduce the exact bug this ticket closes.

## Notes for the implementer

- The p2p listen port is re-allocated per spawn (`createContainer` allocates from the
  managed range), so a re-spawned donated node keeps its peer id but may announce a
  different port. It dials *out* to its retained bootstrap peers and republishes its own
  `CadrePeer` row once connected, so this is recoverable rather than fatal — but it is worth
  a `NOTE:` at the allocation site, and it belongs to the re-spawn work
  (`backlog/bug-donated-nodes-never-respawned`), not here.
- Donated nodes now also get a durable `FileTrustedOwnerStore` in their workdir. That is
  harmless and mildly beneficial: the host re-supplies the pinned owner key through
  `CADRE_OWNER_KEYS` on every spawn, so the anchor recovered on its own before and simply
  persists now too.
- `identityProtobufKeyFile` is populated **only** when `identity.protobufKeyFile` is the
  source that wins in `resolveConfig` (`packages/cadre-cli/src/config/loader.ts:283-290`).
  Writing `identity.keyFile` into the child's `cadre.json` instead would give the node a
  stable identity but still leave both stores in memory. Use the protobuf path.
- `docs/architecture.md` (the cold-start bootstrap-retries bullet, around line 190) claims
  the CLI wiring covers "every `cadre-host`-spawned child". That is false today and true
  after this ticket — correct the claim rather than deleting it, and name the workdir as
  where a donated node's node-local state lives.
- `docs/cadre-host.md` (around line 158) documents the identity key's directory as also
  holding the node-local trusted-owner anchor, for `<dataDir>` / the owner node. Extend it
  with the donated-node case: each donated node's workdir holds its own identity key and its
  own node-local stores, and both are destroyed when the loan is terminated.

## TODO

Phase 1 — the identity helper

- Add `packages/cadre-host/src/orchestrator/node-identity.ts` with `nodeIdentityPath` and
  `ensureNodeIdentity`, built on `generateIdentity` / `loadIdentity` from
  `src/installer/identity.ts`.
- Unit-test it: generates on first call; returns the *same* peer id and identical file bytes
  on a second call; `0600` on POSIX (skip the mode assertion on win32, as
  `installer/__tests__/identity.test.ts` does).

Phase 2 — wire the orchestrator

- Extract `private workdirFor(containerId: string): string` and use it in `launchChild`.
- In `createContainer`, ensure the identity before `launchChild` and pass
  `--identity-protobuf <path>` via `extraArgs`.
- Update the `createContainer` doc comment: donated nodes now carry a workdir-local identity,
  and that is what makes their node-local stores durable.

Phase 3 — cover the behaviour

- Extend `packages/cadre-host/src/__tests__/orchestrator-pin-keys.test.ts` (or add a sibling
  spec beside it — it already has the fake-CLI + `readChildConfig` harness this needs) with:
  the child receives an `--identity-protobuf` argument pointing inside its own workdir; the
  file exists and decodes as a protobuf private key; a second `createContainer` for the same
  `containerId` yields the same peer id; `removeContainer` leaves no identity file behind.

Phase 4 — validate + docs

- `yarn workspace @serfab/cadre-host test`, `yarn workspace @serfab/cadre-cli test`,
  `yarn lint`, and the host typecheck.
- Correct the `docs/architecture.md` cold-start bullet and extend the `docs/cadre-host.md`
  identity/anchor paragraph as described above.
