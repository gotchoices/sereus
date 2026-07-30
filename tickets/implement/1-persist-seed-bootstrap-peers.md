---
description: A machine invited to a group that cannot reach it on the first try forgets where the group is when it restarts, and gives up forever; give it a durable on-device note of the addresses to keep retrying.
files: packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/trusted-owner-store.ts, packages/cadre-core/src/trusted-owner-store-file.ts, packages/cadre-core/src/fs-atomic.ts, packages/cadre-core/src/types.ts, packages/cadre-core/src/index.ts, packages/cadre-core/package.json, packages/cadre-cli/src/commands/start.ts, packages/cadre-core/test/cadre-node-control-cohort.spec.ts, docs/architecture.md
difficulty: medium
---

# Persist the seed's bootstrap dial addresses

## The bug, reproduced

A newcomer is admitted to a party by applying a **seed**: a signed bundle naming the
party's owner machines and the addresses they answer on. Applying it dials those owners.
When that dial fails (owner briefly offline, relay reservation not up, not yet vouched),
`CadreNode.reconcileControlCohort` keeps retrying every 15 s against the addresses the
seed carried — held in `CadreNode.controlBootstrapPeers`, a plain in-memory `Map`.

Nothing else on disk records that a seed was ever applied: `applySeed` writes no control
row, and the `CadrePeer` table only fills in *after* a connection succeeds. So a restart
erases the only addresses the node had, and it is stranded permanently — the exact state
`cold-start-control-redial` set out to fix, reachable by nothing more exotic than a phone
app relaunch.

Reproduced during the fix stage with a unit test (deleted before handoff; land it as part
of this work, see TODO): a `CadreNode` records a seed and dials its owner on the first
reconcile pass; a **second, fresh `CadreNode` with the identical config** and no second
seed dials nothing at all.

```
- Expected  [ "/ip4/1.2.3.4/tcp/4001/ws/p2p/12D3Koo…" ]
+ Received  []
```

## Cause

`controlBootstrapPeers` (`cadre-node.ts:280`) is process-scoped state, and the two seed
intake paths that fill it — `noteAppliedSeed` (the `CadreNode.applySeed` wrapper, incl.
the throwaway-service branch) and the inbound `/sereus/seed/1.0.0` handler via
`onSeedApplied` — both funnel through the sync `recordSeedBootstrapPeers`
(`cadre-node.ts:1700`), which writes nowhere else.

`cadre-cli start --seed <blob>` masks the bug by re-applying the seed on every start.
The paths that receive a seed *at runtime* have no second chance:

- the `/sereus/seed/1.0.0` protocol;
- `cadre-host`'s donation flow — the host mints a per-container `CADRE_SEED_TOKEN` and
  pushes the seed to the node's `POST /seed` admin route at runtime
  (`packages/cadre-host/src/orchestrator/host-process-orchestrator.ts:402-518`). The
  spawned CLI process never gets a `--seed` argument, so a container restart loses it.

## Fix: a node-local, non-replicated bootstrap-peer store

Follow the trusted-owner anchor's shape exactly — it solves the same "must outlive the
process, storage differs per platform" problem, and the precedent keeps the two stores
symmetrical for whoever wires a new target.

- `packages/cadre-core/src/bootstrap-peer-store.ts` — cross-platform interface plus an
  ephemeral in-memory implementation, the default when nothing is injected. Mirrors
  `trusted-owner-store.ts` (which is the file to read first).
- `packages/cadre-core/src/bootstrap-peer-store-file.ts` — Node-only, JSON per party,
  atomically replaced through the existing `fs-atomic.ts` helpers
  (`writeFileAtomically`, `encodeFileSafeComponent`, `isNotFound`). Exported **only**
  through a new `./bootstrap-peer-store-file` subpath in
  `packages/cadre-core/package.json`, so the `node:fs` edge never reaches a React Native
  or browser bundle — same isolation as `trusted-owner-store-file` and `key-store-file`.

### Interface

```ts
/** One retained cold-start dial target: an owner peer a seed nominated. */
export interface BootstrapPeerEntry {
	/** Multiaddr strings exactly as the seed carried them (parsed at dial time). */
	addrs: string[];
	/** Wall-clock ms the entry was last recorded (diagnostics / future eviction). */
	recordedAt: number;
}

export interface BootstrapPeerStore {
	/** Party this store is scoped to. */
	readonly partyId: string;

	/** Every retained target, peerId -> entry. Snapshot; safe to iterate while recording. */
	all(): ReadonlyMap<string, BootstrapPeerEntry>;

	/**
	 * Retain (or REPLACE) a peer's dial addresses. Replace, not merge, so a
	 * re-seed after an owner's address changed drops the stale address instead of
	 * accumulating dead ones — the semantics `recordSeedBootstrapPeers` has today.
	 *
	 * Implementations MUST reflect the entry in `all()` SYNCHRONOUSLY; the returned
	 * promise tracks durability only. This is what lets the sync
	 * `recordSeedBootstrapPeers` keep its signature.
	 */
	record(peerId: string, addrs: readonly string[]): Promise<void>;
}
```

On-disk shape for the file backend, versioned and party-stamped like
`PersistedTrustedOwners`:

```ts
interface PersistedBootstrapPeers {
	version: 1;
	partyId: string;
	/** peerId -> entry. */
	peers: Record<string, BootstrapPeerEntry>;
}
```

### Load-time failure policy

Copy `FileTrustedOwnerStore.open`'s policy verbatim, because the reasons carry over:

- missing file, unparsable JSON, unknown shape, or a **`partyId` mismatch** (a directory
  reused for another party must not leak dial targets) ⇒ cold start, empty store;
- **present but unreadable** (EACCES, EISDIR, EIO…) ⇒ **throw**. Loading empty there
  would hide a real misconfiguration *and* let the next `record()` snapshot-write destroy
  a still-intact file.

### Re-validation on load — decided: validate shape, not signatures

The source ticket asked whether a persisted seed should be re-verified on load. It should
not, and there is nothing to verify: only *dial targets* are persisted, never a seed, a
signature, or an authority claim. The reasoning already written on
`recordSeedBootstrapPeers` and on `SeedPeer.isOwner` applies unchanged — the seed was
signature-checked against the trust anchor before these addresses were retained, and **a
dial grants no authority**; `bootstrapDialAddrs` binds each address to the peer id it was
retained under, so a dial cannot be redirected to whoever answers.

What the loader *must* do is drop structurally junk entries rather than carry them into
the dial loop: a `peerId` that is not a parseable peer id, an empty `addrs` array, a
non-string address. Say so in the module doc comment so the next reader does not re-open
the question.

## Wiring

- `CadreNodeConfig.bootstrapPeers?: { store?: BootstrapPeerStore }` in `types.ts`,
  documented next to `trustedOwners` and pointing at it. Absent ⇒ in-memory store
  created at `start()` (ephemeral — today's behaviour, so no target regresses).
- `CadreNode.initializeBootstrapPeerStore()`, called from `start()` immediately after
  `initializeTrustedOwnerStore()` (`cadre-node.ts:514`) — before any network bring-up, so
  a mis-scoped injected store fails closed there and the targets are loaded before the
  first reconcile pass can run. Same party-scope check and same "keep the instance across
  stop()→start()" idempotence as the anchor.
- **Replace** the `controlBootstrapPeers` field with the store rather than caching
  alongside it — one source of truth. `dialColdStartBootstrap` iterates
  `store.all()`; `recordSeedBootstrapPeers` stays synchronous and fires
  `void store.record(peerId, addrs).catch(…)`, logging a persist failure without failing
  the seed (the precedent is `SeedBootstrapService.anchorAcceptedSigner`: durability
  failure loses restart survival only, never this session).
- `cadre-cli/src/commands/start.ts` — open a `FileBootstrapPeerStore` under
  `dirname(config.identityProtobufKeyFile)` when one is configured, exactly beside the
  existing `FileTrustedOwnerStore.open(...)` call (`start.ts:146-151`), and pass it as
  `bootstrapPeers.store`. This is what makes the `cadre-host` donation flow survive a
  container restart, since the host runs nodes through this CLI.
- React Native / browser get the in-memory default and stay ephemeral. That is a real
  remaining gap and the headline "phone app relaunch" case is only half-closed by this
  ticket — tracked in `tickets/plan/2-durable-node-local-stores-on-mobile-web.md`, which
  covers the same gap for the trusted-owner anchor (also ephemeral on those targets
  today). Do not try to solve it here; do link it from the code comment on
  `CadreNodeConfig.bootstrapPeers`.

## Tripwire to record in code, not as a ticket

Entries are never evicted, and persisting them means the file grows across the node's
whole lifetime, not just one process. Fine today — a seed nominates one or a few owners
and entries are keyed by peer id — so put a `NOTE:` at the store's `record()` site:
*if a node ever applies seeds naming many distinct owners, add eviction (oldest
`recordedAt`, or a cap) rather than letting the file grow unbounded.* `recordedAt` exists
so that eviction has something to sort by.

## TODO

Phase 1 — the store

- Add `bootstrap-peer-store.ts`: `BootstrapPeerEntry`, `BootstrapPeerStore`,
  `MemoryBootstrapPeerStore`. Export from `src/index.ts`.
- Add `bootstrap-peer-store-file.ts`: `FileBootstrapPeerStore.open(dir, partyId)`,
  `bootstrap-peers.<encoded partyId>.json`, atomic snapshot write, serialised write
  chain, load policy above (incl. the throw-on-unreadable branch and junk-entry drop).
- Add the `./bootstrap-peer-store-file` subpath to `packages/cadre-core/package.json`.
- Unit-test both backends in `packages/cadre-core/test/bootstrap-peer-store.spec.ts`,
  modelled on `test/trusted-owner-store.spec.ts`: record→`all()` synchronous visibility,
  replace-not-merge, round-trip across a reopen, cold start on missing/corrupt/foreign-
  party file, throw on unreadable, junk entries dropped, concurrent records all landing.

Phase 2 — wire it into the node

- `CadreNodeConfig.bootstrapPeers` in `types.ts`, documented, cross-linked to
  `trustedOwners` and to the mobile/web plan ticket.
- `initializeBootstrapPeerStore()` in `cadre-node.ts`, called from `start()` right after
  `initializeTrustedOwnerStore()`; party-scope mismatch throws before network bring-up.
- Retire the `controlBootstrapPeers` field: `recordSeedBootstrapPeers` records into the
  store (sync-visible, `void`-ed persist with a caught+logged failure);
  `dialColdStartBootstrap` reads `store.all()`. Keep the owner-only / has-addrs /
  not-self filter and the existing `bootstrapDialAddrs` peer-id binding untouched.
- Add the `NOTE:` eviction tripwire at the `record()` site.

Phase 3 — CLI + coverage + docs

- `cadre-cli/src/commands/start.ts`: open `FileBootstrapPeerStore` beside the identity
  key when `config.identityProtobufKeyFile` is set; pass through `bootstrapPeers.store`.
- Land the restart regression test in
  `packages/cadre-core/test/cadre-node-control-cohort.spec.ts`, in the existing
  *cold-start bootstrap branch* describe block: record a seed on one `CadreNode`, then
  build a **second** `CadreNode` sharing the same injected `BootstrapPeerStore` instance
  (an in-memory one is enough to prove hydration — it stands in for the file surviving
  the process) and assert its first `reconcileControlCohort` dials the seed's owner
  address. The block's existing helpers (`injectCohort`, `seedWith`, `recordSeed`,
  `dialedAddrs`) cover everything else; note that `bootstrapPeers(node)` and
  `recordSeed` need updating for the retired field.
- Update the file-backed store's counterpart test if `test/trusted-owner-store.spec.ts`
  shares helpers worth reusing.
- `docs/architecture.md` — the cold-start bullet currently states the restart hole as a
  known limitation. Replace that with what actually happens now, and say plainly that
  durability is Node-only until the mobile/web plan ticket lands.
- Validate: `yarn typecheck` and `yarn lint` (all workspaces), `yarn workspace
  @serfab/cadre-core build`, and the `cadre-core` suite. Stream long runs through `tee`.
  `packages/integration-tests/src/scenarios/control-cohort-cold-start-retry.integration.ts`
  is the closest end-to-end scenario; extending it to restart node B is desirable but
  optional — if it is skipped, say so in the review handoff rather than implying coverage.
