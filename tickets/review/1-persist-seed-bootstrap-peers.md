---
description: A machine invited to a group that could not reach it on the first try used to forget the group's addresses when it restarted and gave up forever; it now keeps a durable on-device note of those addresses and keeps retrying.
files: packages/cadre-core/src/bootstrap-peer-store.ts, packages/cadre-core/src/bootstrap-peer-store-file.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/types.ts, packages/cadre-core/src/index.ts, packages/cadre-core/package.json, packages/cadre-cli/src/commands/start.ts, packages/cadre-core/test/bootstrap-peer-store.spec.ts, packages/cadre-core/test/cadre-node-control-cohort.spec.ts, docs/architecture.md
difficulty: medium
---

# Persisted the seed's bootstrap dial addresses

## What was wrong

`CadreNode` held its cold-start retry addresses in a plain in-memory `Map`
(`controlBootstrapPeers`). Nothing else on disk recorded that a seed had been applied —
`applySeed` writes no control row, and a `CadrePeer` row fills in only *after* a
connection succeeds — so a restart erased the only addresses the node had and stranded it
permanently. `cadre-cli start --seed <blob>` masked it by re-applying on every start; the
two runtime seed paths (`/sereus/seed/1.0.0`, and `cadre-host`'s donation flow pushing to
the node's `POST /seed`) never get a `--seed` argument on the next start, so a container
restart lost the addresses for real.

## What landed

A node-local, non-replicated bootstrap-peer store, shaped exactly like the trusted-owner
anchor:

- `src/bootstrap-peer-store.ts` — `BootstrapPeerEntry` (`addrs`, `recordedAt`),
  `BootstrapPeerStore` (`partyId`, `all()`, `record()`), `MemoryBootstrapPeerStore`.
  Exported from `src/index.ts`. `record()` REPLACES a peer's addresses (never merges) and
  must be visible in `all()` synchronously — the promise tracks durability only, which is
  what lets the synchronous `recordSeedBootstrapPeers` keep its signature.
- `src/bootstrap-peer-store-file.ts` — `FileBootstrapPeerStore.open(dir, partyId)`,
  `bootstrap-peers.<encoded partyId>.json`, atomic snapshot via `fs-atomic.ts`, serialised
  write chain. Node-only, exported solely through the new
  `./bootstrap-peer-store-file` subpath in `packages/cadre-core/package.json`.
- `CadreNodeConfig.bootstrapPeers?: { store?: BootstrapPeerStore }` in `types.ts`,
  cross-linked to `trustedOwners` and to the mobile/web plan ticket.
- `CadreNode.initializeBootstrapPeerStore()` (sync — an injected store has already loaded)
  called from `start()` right after `initializeTrustedOwnerStore()`, before any network
  bring-up; party-scope mismatch throws there. Plus a `getBootstrapPeerStore()` accessor.
- `controlBootstrapPeers` retired. `recordSeedBootstrapPeers` fires
  `void store.record(...).catch(log)` — a persist failure costs restart survival, never
  this session's retry set, and never fails an already-accepted seed.
  `dialColdStartBootstrap` snapshots `store.all()` once per pass and iterates that. The
  owner-only / has-addrs / not-self filter and the `bootstrapDialAddrs` peer-id binding are
  untouched.
- `cadre-cli start` opens a `FileBootstrapPeerStore` beside the identity key when
  `identityProtobufKeyFile` is set — this is what makes the `cadre-host` donation flow
  survive a container restart, since the host runs nodes through this CLI.

## Deliberate non-decisions worth not re-opening

- **Nothing persisted here is re-verified on load, because nothing here is trust-bearing.**
  Only dial targets are stored — never a seed, signature, or authority claim. The seed was
  signature-checked against the trusted-owner anchor before its addresses were retained,
  and a dial grants no authority (`bootstrapDialAddrs` binds each address to the peer id it
  was retained under, so a dial cannot be redirected to whoever answers). Written out in
  the `bootstrap-peer-store.ts` module comment so the next reader doesn't re-litigate it.
- **The loader does drop structurally junk entries** — unparseable peer id, empty `addrs`,
  non-string/empty address, non-numeric `recordedAt`, non-object entry — rather than
  carrying them into a dial loop that would log a parse failure once per 15 s forever. Junk
  is dropped per entry, not per file: one bad entry must not discard a node's only way back
  into its party.
- **Load-failure policy copied verbatim from `FileTrustedOwnerStore.open`:** missing /
  unparsable / unknown-shape / foreign-`partyId` ⇒ cold start (empty); present-but-
  unreadable (EACCES, EISDIR, EIO) ⇒ **throw**, because loading empty would hide a real
  misconfiguration *and* let the next `record()` snapshot-write destroy a still-intact file.

## Testing / validation

Ran and green: `yarn workspace @serfab/cadre-core build`, `yarn workspace
@serfab/cadre-core test` (66 files, 1025 passed / 1 pre-existing skip), `yarn typecheck`
(all workspaces), `yarn lint` (all workspaces). No pre-existing failures surfaced.

New coverage:

- `test/bootstrap-peer-store.spec.ts` — a shared contract suite run against BOTH backends
  (empty start + partyId, record→`all()`, synchronous visibility, replace-not-merge,
  snapshot decoupling) plus file-backend specifics: round-trip across a reopen, cold start
  on missing dir / corrupt JSON / unknown shape / foreign embedded partyId, two parties
  sharing a directory, throw on present-but-unreadable, junk entries dropped while good
  ones survive, 8 concurrent `record()` calls all landing durably, no `.tmp` debris.
- `test/cadre-node-control-cohort.spec.ts` — the headline regression, in the existing
  cold-start describe block: **`a restarted node re-dials the seed it applied in a previous
  process`**. Node A records a seed; a second, fresh `CadreNode` with no second seed shares
  the same `BootstrapPeerStore` instance and its first `reconcileControlCohort` dials the
  seed's owner address. `injectCohort` now takes an optional `bootstrapStore` (defaults to a
  fresh `MemoryBootstrapPeerStore`) — that shared instance is what stands in for the file
  surviving the process. `bootstrapPeers(node)` now reads `store.all()` and returns entries,
  so the retention assertions read `.addrs`.

### Suggested review focus / use cases to poke at

- **The half-closed headline case.** React Native and the browser inject no durable
  backend, so a phone app relaunch still loses the retry set. That is the ticket's own
  scoping decision, tracked in `tickets/plan/2-durable-node-local-stores-on-mobile-web.md`
  (which covers the same gap for the trusted-owner anchor) and linked from the code comment
  on `CadreNodeConfig.bootstrapPeers`. Worth confirming the doc and comment say this
  plainly rather than implying the bug is fully closed.
- **`recordSeedBootstrapPeers` with a null store** logs and retains nothing. Argued
  unreachable in production: `start()` builds the store before any network bring-up, and an
  uninitialized `SeedBootstrapService.applySeed` returns `seedRejected('Service not
  initialized')` so `noteAppliedSeed` returns before reaching it. Verify that reasoning
  rather than taking it on faith — if there *is* a reachable pre-start intake path, the
  silent-loss branch is a real defect.
- **Repeat `record()` of identical addresses still writes the file** (it refreshes
  `recordedAt`). So `cadre-cli start --seed` costs one snapshot write per start. Judged not
  worth a dirty-check; disagree if you see a hot re-seed path.
- **`FileBootstrapPeerStore` on Windows.** `writeFileAtomically`'s rename can fail
  `EPERM`/`EBUSY` if another process holds the destination open — pre-existing property of
  the shared helper, but this store now puts a second file in the identity-key directory,
  so two `cadre-cli` processes pointed at the same directory for the same party is a new
  concurrency surface worth a thought.

### Known gaps (not papered over)

- **No end-to-end restart scenario.** The integration scenario
  `packages/integration-tests/src/scenarios/control-cohort-cold-start-retry.integration.ts`
  was **not** extended to restart node B with a `FileBootstrapPeerStore` — the ticket marked
  that desirable-but-optional and the run hit its token budget first. So the restart claim
  is proven at unit level (shared in-memory store hydrating a second `CadreNode`, plus the
  file backend's own reopen round-trip) but **never over real libp2p with a real file**. The
  seam between them — `cadre-cli start` actually injecting the store, and the file actually
  being reopened by a second process — is currently unexercised by any test.
- **`cadre-cli start`'s new wiring has no test of its own.** It mirrors the adjacent
  `FileTrustedOwnerStore.open(...)` call, which is likewise untested there.
- **Eviction tripwire, not a ticket.** Entries are never evicted and the file grows across
  the node's whole lifetime. Parked as a `NOTE:` on `BootstrapPeerStore.record`'s doc
  comment in `src/bootstrap-peer-store.ts`: if a node ever applies seeds naming many
  distinct owners, add eviction (oldest `recordedAt`, or a cap) rather than letting the file
  grow unbounded — `recordedAt` exists so eviction has something to sort by.
