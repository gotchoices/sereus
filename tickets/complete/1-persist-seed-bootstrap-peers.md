---
description: A machine invited to a group that could not reach it on the first try used to forget the group's addresses when it restarted and gave up forever; it now keeps a durable on-device note of those addresses and keeps retrying.
files: packages/cadre-core/src/bootstrap-peer-store.ts, packages/cadre-core/src/bootstrap-peer-store-file.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/types.ts, packages/cadre-core/src/index.ts, packages/cadre-core/src/fs-atomic.ts, packages/cadre-core/package.json, packages/cadre-cli/src/commands/start.ts, packages/cadre-core/test/bootstrap-peer-store.spec.ts, packages/cadre-core/test/cadre-node-bootstrap-peers.spec.ts, packages/cadre-core/test/cadre-node-control-cohort.spec.ts, docs/architecture.md
difficulty: medium
---

# Persisted the seed's bootstrap dial addresses

## What landed

`CadreNode` used to hold its cold-start retry addresses in a plain in-memory `Map`. Nothing
else on disk recorded that a seed had been applied, so a restart erased the only addresses
the node had and stranded it permanently.

A node-local, non-replicated bootstrap-peer store now holds them, shaped exactly like the
trusted-owner anchor:

- `src/bootstrap-peer-store.ts` — `BootstrapPeerEntry`, `BootstrapPeerStore`
  (`partyId` / `all()` / `record()`), `MemoryBootstrapPeerStore`. `record()` REPLACES a
  peer's addresses and is visible in `all()` synchronously; the returned promise tracks
  durability only, which is what lets the synchronous `recordSeedBootstrapPeers` keep its
  signature.
- `src/bootstrap-peer-store-file.ts` — `FileBootstrapPeerStore.open(dir, partyId)`,
  atomic JSON snapshot per party, serialised write chain. Node-only, exported solely
  through the `./bootstrap-peer-store-file` subpath.
- `CadreNodeConfig.bootstrapPeers?: { store?: BootstrapPeerStore }`, adopted by
  `CadreNode.initializeBootstrapPeerStore()` during `start()` before any network bring-up;
  a party-scope mismatch throws there. `getBootstrapPeerStore()` exposes it.
- `dialColdStartBootstrap` snapshots `store.all()` once per pass. The owner-only /
  has-addrs / not-self filter and the `bootstrapDialAddrs` peer-id binding are unchanged.
- `cadre-cli start` opens a `FileBootstrapPeerStore` beside the identity key when
  `identityProtobufKeyFile` is set.

Nothing persisted here is trust-bearing and nothing is re-verified on load — only dial
targets are stored, the seed was signature-checked against the trusted-owner anchor before
its addresses were retained, and every address is re-bound to its peer id before the dial.
The loader does drop structurally junk entries, per entry rather than per file.

## Review findings

Checked: the full implement diff read before the handoff summary; store and file-backend
design against the `FileTrustedOwnerStore` / `fs-atomic` originals; `CadreNode` lifecycle
(`start` ordering, `stop()→start()`, `cleanup`); both seed intake paths; every claim the
handoff made about reachability; docs in `docs/architecture.md`, `docs/STATUS.md`, and the
prerequisite plan ticket; repo-wide grep for stale references to the retired
`controlBootstrapPeers`. Ran `yarn lint` (all workspaces, clean) and the cadre-core specs
for the store contract, the node wiring, and the control-cohort branch (47 tests, all
green). No pre-existing failures surfaced, so `tickets/.pre-existing-error.md` was not
written.

**Major — one new ticket filed.** The handoff's headline claim that the `cadre-cli start`
wiring "is what makes the `cadre-host` donation flow survive a container restart" does not
hold. `HostProcessOrchestrator.createContainer` — the donation path, and the motivating use
case — writes the child's `cadre.json` with no `identity` block and spawns `cadre-cli start`
with no `--identity-protobuf`, unlike `ensureOwnerNode`. So `identityProtobufKeyFile` is
undefined for donated nodes, no `FileBootstrapPeerStore` is opened, and they fall back to
the ephemeral store. The same launch also gives them no identity key at all, so they
generate a fresh libp2p identity per spawn, and `DonationService.applySeed` is a one-time
requester-driven call that is never replayed. Filed as
`tickets/fix/1-donated-nodes-lose-restart-state.md`. The store itself is correct and the
`/sereus/seed/1.0.0` path on any node launched *with* an identity key is genuinely fixed —
the defect is in how donated nodes are launched, not in this diff.

**Major — one backlog ticket filed.** `bootstrap-peer-store-file.ts` and
`trusted-owner-store-file.ts` are near-identical: same envelope, validator, path builders,
load-failure policy, write chain, and snapshot write, diverging only in payload type and
one-bad-entry policy. With mobile and browser backends already planned, that is three
copies. Filed as `tickets/backlog/debt-file-store-snapshot-duplication.md`.

**Minor — fixed in this pass.**

- Missing wiring coverage: `initializeBootstrapPeerStore` had no test — no coverage of the
  in-memory default, injected-store adoption, survival across `stop()→start()`, or the
  fail-closed party-scope throw, and `getBootstrapPeerStore()` had no caller at all.
  Added `test/cadre-node-bootstrap-peers.spec.ts`, mirroring the anchor's
  `cadre-node-trusted-owners.spec.ts`.
- Broken doc link: `recordSeedBootstrapPeers`'s comment still pointed at the retired
  `{@link controlBootstrapPeers}` member. Repointed at `bootstrapPeerStore`.
- Stale module comment: `fs-atomic.ts` listed only two consumers. Added the new one.

**Verified, not defects.** The handoff asked for three claims to be checked rather than
taken on faith, and all three hold. (1) The null-store branch in `recordSeedBootstrapPeers`
is genuinely unreachable: `SeedBootstrapService.applySeed` returns
`seedRejected('Service not initialized')` when `libp2pNode` is unset, so `noteAppliedSeed`
returns before reaching it, and the `onSeedApplied` path needs an initialized service.
(2) Repeat `record()` of identical addresses writing the file again is the right trade —
one write per start is nothing against a dirty-check that would have to compare address
arrays. (3) The load-failure policy and the per-entry junk drop are both correctly copied
from the anchor, and the divergence (per-entry vs whole-file rejection) is the right call
for a store whose entries are a node's only way back into its party.

**Tripwires — recorded in code, not filed.**

- Cross-process concurrency: two processes opening the same directory for the same party
  would each snapshot-write their own view, dropping the loser's entries (and on Windows the
  rename can fail `EPERM`/`EBUSY`). Fine today — every launcher gives a node its own
  directory. Parked as a `NOTE:` on the `FileBootstrapPeerStore` class doc in
  `src/bootstrap-peer-store-file.ts`.
- Unbounded growth: entries are never evicted. Already parked by the implementer as a
  `NOTE:` on `BootstrapPeerStore.record` in `src/bootstrap-peer-store.ts`; left as is.
- Durability window on shutdown: `recordSeedBootstrapPeers` fires `void store.record(...)`,
  so a process that exits within milliseconds of accepting a seed can lose the persist. The
  write starts on the next microtask and `stop()` is not instantaneous, and the trusted-owner
  anchor has the identical shape, so this is not worth a flush-on-stop today. Not filed;
  noted here as the one thing that would change if seed intake ever moved to a
  fire-and-exit path.

**Known gap carried forward, unchanged.** The integration scenario
`control-cohort-cold-start-retry.integration.ts` was not extended to restart node B with a
real `FileBootstrapPeerStore`, so the restart claim is proven at unit level (shared store
hydrating a second `CadreNode`, plus the file backend's own reopen round-trip) but never
over real libp2p with a real file. Deliberately not filed as its own ticket: the donation
ticket above changes which launch paths open the store at all, and an end-to-end restart
scenario written now would encode the wrong wiring. It belongs with that work.

**Checked and clean, explicitly.** Type safety — no `any`, no unchecked casts past the
validators; the `unknown`-typed loader boundary is correct. Resource cleanup — the write
chain survives a failed persist and the temp file is removed on every failure path
(`fs-atomic.writeFileAtomically`), and the "no `.tmp` debris" test covers it. Error handling
— no swallowed exceptions; every catch logs, and the one deliberate non-fatal path
(persist failure never fails an already-accepted seed) is argued at the call site. Source
hygiene — both new modules are under 210 lines, functions are short and single-purpose
(`parsePersisted`, `isUsableEntry`, `filePath`, `tempPath`, `persistSnapshot`), and naming
carries the intent without needing the comment blocks to explain mechanics. Docs — the
`docs/architecture.md` cold-start bullet was rewritten accurately, including the honest
"still ephemeral on React Native and in the browser" caveat and the pointer to
`tickets/plan/2-durable-node-local-stores-on-mobile-web.md`, which itself already names this
store correctly; `docs/STATUS.md` has no bullet covering this store and needed none.
