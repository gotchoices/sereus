---
description: A customer's node on the shared hosting service invents a brand-new network identity every time its container restarts, so the customer's group stops recognising it; give each node one identity that it keeps for as long as the customer's container exists.
files: packages/cadre-cli/docker/entrypoint.sh, packages/cadre-provider/src/service/docker-orchestrator.ts, packages/cadre-provider/src/service/container-service.ts, packages/cadre-provider/src/types.ts, packages/cadre-provider/src/config/types.ts, packages/cadre-cli/docker/docker-compose.yml, docs/architecture.md, docs/STATUS.md
difficulty: medium
---

# Container-hosted nodes keep one identity across restarts

## Root cause (reproduced)

The container image *already tries* to keep an identity. It fails for two independent
reasons, both in `packages/cadre-cli/docker/entrypoint.sh`, and neither is specific to
cadre-provider — the `docker-compose.yml` deployment path in the same folder is affected
identically.

**1. Config is generated before the identity exists.** The script runs
`generate_config` (guarded by "config file missing") and *then* `create_identity`. The
`identity:` block is written only `if [ -f "$CADRE_KEY_FILE" ]` — on a fresh container the
key does not exist yet, so the block is never written. The config is then never regenerated
(the guard sees the file), so no later start gains it either.

**2. `CADRE_KEY_FILE` is never exported.** Line 9 is a plain shell assignment:

```sh
CADRE_KEY_FILE="${CADRE_KEY_FILE:-$DATA_DIR/cadre-peer.key}"
```

POSIX `sh` does not export a variable that was not already in the environment, and nothing
(Dockerfile `ENV`, cadre-provider) puts `CADRE_KEY_FILE` in the container environment. So
the `exec node … start` child does not see it, and the `CADRE_KEY_FILE → identity.keyFile`
entry in `ENV_MAPPINGS` (`packages/cadre-cli/src/config/types.ts`) never fires. (`DATA_DIR`
*is* exported — the Dockerfile sets it — which is why that one works.)

Net effect: `/data/cadre-peer.key` is written on first start and never read by anything.
`resolveConfig` returns `privateKey: undefined`, `CadreNode` generates a fresh libp2p
keypair on every start, and `RestartPolicy: { Name: 'unless-stopped' }` in
`DockerOrchestrator.createContainer` makes restarts the designed behaviour.

### How this was reproduced

No Docker daemon needed — the defect is entirely in the entrypoint's ordering and export.
Run `entrypoint.sh` in a scratch directory with a stub `node` on `PATH` that (a) writes
`<output>/<name>.key` for `enroll create` and (b) prints `${CADRE_KEY_FILE:-<UNSET>}` for
`start`, with `DATA_DIR`, `CADRE_PARTY_ID` and `CADRE_BOOTSTRAP_NODES` set. Observed on the
first run: config written with **no** `identity:` section, key created *after* it, and
`CADRE_KEY_FILE = <UNSET>` in the started child. Second run: identical, config unchanged.

Also verified by direct round-trip that the key file `cadre enroll create` writes is
loadable — it is the hex encoding of `privateKeyToProtobuf(...)`, and
`loader.ts:decodePrivateKey` tries `privateKeyFromProtobuf` first, so `identity.keyFile`
pointed at `/data/cadre-peer.key` yields the same peer id it was generated with. The
identity mechanism is sound; only the wiring is broken.

## Where the state must live

`/data` is the only durable surface, and everything node-local already lands there:

- identity key — `$DATA_DIR/cadre-peer.key`
- generated config — `$DATA_DIR/cadre.yaml`; `resolveConfig` defaults `nodeStateDir` to the
  directory holding the config file, so it resolves to `/data`
- bootstrap-peer store + trusted-owner anchor — `FileBootstrapPeerStore` /
  `FileTrustedOwnerStore` open under `nodeStateDir`, i.e. `/data`
- storage — `/data/storage`

So once the identity wiring is fixed, the node-local stores come along for free, provided
`/data` itself survives.

Today `/data` survives only by accident: the image declares `VOLUME ["/data"]`, so Docker
creates an **anonymous** volume at create time. That survives `restart` and `stop`/`start`
(which is the restart-policy case this ticket is about), but it is invisible in the
provider's records, it does not survive recreating the container for an image upgrade, and
`removeContainer`'s `remove({ force: true })` leaves it orphaned — one leaked volume per
terminated tenant.

**Decision: mount an explicit named volume per container** — `cadre-<containerId>-data` at
`/data`, labelled `sereus.container-id`. Named because the provider must be able to name,
find and delete it; per-container because the ticket's requirement is that removing the
tenant's container removes the tenant's state. Recreating the container under the same
provider `containerId` (image upgrade) then keeps the identity, which is the behaviour we
want and which an anonymous volume cannot give.

**Decision: the node mints its own key, on first start, into the mounted volume.** That is
what `create_identity` already does; the provider needs no key handling, no key ever
crosses the provider/tenant boundary, and the fix stays a wiring fix. The provider learns
the resulting peer id by reading the node's live `/status`, which
`ContainerService.getPeerInfo` already does.

## Expected behaviour after this lands

- Restarting a tenant's container (crash, `unless-stopped` policy, daemon restart, explicit
  stop/start) leaves its peer id unchanged, so the tenant's cadre keeps recognising it.
- Bootstrap peers delivered at runtime via `POST /seed` survive the same restarts, so a node
  that could not reach the cadre on its first try keeps retrying with real addresses.
- Removing the tenant's container removes its volume, and with it identity, stores and
  storage. No orphaned volumes accumulate.
- A container created before this change gains a stable identity on its next start (it
  re-keys once, from ephemeral to durable) — it never had a stable id to lose.

## Notes for the implementer

- The env override is the load-bearing half of the entrypoint fix, not the config block:
  `applyEnvironmentOverrides` runs over the loaded file every start, so an exported
  `CADRE_KEY_FILE` fixes containers whose `cadre.yaml` was generated by the old script and
  is never regenerated. Reordering `create_identity` above `generate_config` fixes the
  written config too, but only for containers created after the change — do both, and treat
  the config block as a debugging mirror of the authoritative env value.
- Note that empty env values are skipped by `applyEnvironmentOverrides` (`value.trim() === ''`),
  so exporting an empty `CADRE_KEY_FILE` is a no-op rather than a clobber.
- `HostConfig.Mounts` (`Type: 'volume'`) rather than `Binds` — no host path to configure and
  it works against a remote Docker daemon.
- `v: true` on container removal only reaps *anonymous* volumes; a named volume needs an
  explicit `docker.getVolume(name).remove()`. Pass both: `v: true` cleans up volumes left by
  containers created before this change, and the explicit removal handles ours. Read the
  container's `Mounts` via `inspect` *before* removing it rather than trusting an in-memory
  map — `DockerOrchestrator`'s `containerPorts` map is already lost across a provider
  restart, and volume cleanup must not inherit that weakness.
- `createContainer`'s failure path already releases ports and force-removes a partially
  created container; the volume has to join that cleanup, or a failed provision leaks one.
- Volume names: provider container ids are `ctr_<nanoid16>`; nanoid's alphabet is
  `A-Za-z0-9_-`, all legal in a Docker volume name (`[a-zA-Z0-9][a-zA-Z0-9_.-]*`).
- Seed *trust* is a separate defect with its own ticket
  (`provider-owner-key-pinning`) — a provider container currently rejects every seed
  regardless of this fix. Do not conflate the two; this ticket is only about the identity
  and the state surviving.

## TODO

### Entrypoint (`packages/cadre-cli/docker/entrypoint.sh`)

- Move `create_identity` above the `generate_config` guard so the key exists before the
  config is written.
- `export CADRE_KEY_FILE` so `ENV_MAPPINGS` picks it up in the started child; likewise
  export `CADRE_NODE_STATE_DIR="$DATA_DIR"` so node-local stores stay on the volume even if
  an operator points `CADRE_CONFIG_FILE` elsewhere.
- Log the resolved identity path at start so a wiring regression is visible in
  `docker logs` rather than silent.
- Keep the `identity:` block in the generated config (now that it is written after the key
  exists), and note in a comment that the exported env var is the authoritative source.

### Provider (`packages/cadre-provider/src/service/docker-orchestrator.ts`)

- Mount a named volume `cadre-<containerId>-data` at `/data` via `HostConfig.Mounts`,
  labelled with `sereus.container-id`.
- Create the volume explicitly (`docker.createVolume`) with those labels, so it is
  discoverable by label rather than by parsing names, and so an image-upgrade recreate
  re-attaches the same one.
- Extend the create failure path to remove a volume created in that attempt.
- In `removeContainer`, inspect for the container's mounts first, remove the container with
  `{ force: true, v: true }`, then remove the named volume; log-and-continue on volume
  removal failure (a missing volume must not fail a termination).

### Provider record (`packages/cadre-provider/src/types.ts`, `container-service.ts`)

- Add `peerId?: string` to `Container` and populate it in `waitForEnrollment` when the node
  first reports healthy (read it from the same `/status` payload `getPeerInfo` uses), so a
  tenant can be told which peer id is theirs without a live round-trip. Leave `getPeerInfo`
  reading live — it is the source of truth for multiaddrs, which do change.

### Tests

- Entrypoint: a test that runs `entrypoint.sh` under `sh` with a stub `node` on `PATH`
  (recipe above) and asserts (a) the child sees `CADRE_KEY_FILE` pointing at an existing
  file and (b) the generated config carries the `identity:` block. Gate it on `sh` being
  available so it skips rather than fails on a Windows dev box.
- `DockerOrchestrator` with the existing fake-dockerode harness
  (`__tests__/orchestrator-port-leak.test.ts`, `docker-orchestrator-push.test.ts` show the
  shape): the create call carries the expected `Mounts` entry; a failed create removes the
  volume it made; `removeContainer` removes both container and volume; a container whose
  volume is already gone still terminates cleanly.
- `ContainerService`: `peerId` is recorded on the container record once the node reports
  healthy.

### Docs

- `docs/architecture.md` — the durable-identity/cold-start-retry bullets currently describe
  cadre-host only; extend to the container path.
- `docs/STATUS.md` — record that the provider-side equivalent of the donated-node identity
  fix has landed.
