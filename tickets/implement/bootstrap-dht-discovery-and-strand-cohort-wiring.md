description: Seed each strand's libp2p node with cohort-derived bootstrap peers (instead of an empty list) and make the control-discovered (`handleStrandAdded`) path pick bootstrap-vs-networked mode the same way the explicit `addStrand` path does.
files: packages/cadre-core/src/strand-instance-manager.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/types.ts, packages/cadre-core/src/control-database.ts, packages/cadre-core/src/strand-cohort.ts (new), packages/cadre-core/test/strand-cohort.spec.ts (new), packages/cadre-core/test/strand-instance-manager.spec.ts, packages/cadre-core/test/cadre-node.spec.ts
effort: high
----

## Scope

Two in-Sereus defects from the plan ticket, both in `@serfab/cadre-core`:

1. **Empty bootstrap seed.** `StrandInstanceManager.startStrand` always passes `bootstrapNodes: []` to `createLibp2pNode` (`strand-instance-manager.ts:199`, comment `// Will be populated from strand cohort`). The strand boots with no discovery seed and depends entirely on FRET gossip from an initially-empty peer set.

2. **Mode dropped on the discovery path.** `CadreNode.addStrand` threads `mode` into `startStrand` (`cadre-node.ts:534-543`); `CadreNode.handleStrandAdded` does not (`cadre-node.ts:402-410`), so a strand discovered via the control network always defaults to `'networked'` (`strand-instance-manager.ts:231`) and a solo/cold-start node stalls against an absent cohort instead of coming up in `bootstrap` mode.

**Out of scope (do not touch):** the upstream absence of a Kademlia DHT in optimystic `db-p2p` (`../optimystic` `db-p2p/src/libp2p-node-base.ts:301-305`) — acknowledged in the plan as a separate concern. Also out of scope: making `registerSelf` actually write a `CadrePeer` row (it is an authorization-gated no-op today, `cadre-node.ts:377-386`); this ticket reads whatever `CadrePeer` rows exist and behaves correctly when there are none.

## Background (already in place — reuse, don't rebuild)

- `StrandDatabase` already wires the transactor + persistent `rawStorage` correctly from `mode` (`strand-database.ts:95-125`): `bootstrap` → `local` transactor, `networked` → `network`. `StrandMode` is defined in `types.ts:263-276`. This ticket only feeds the right `mode` and `bootstrapNodes` in; it does **not** change `StrandDatabase`.
- `ControlDatabase.queryCadrePeers()` (`control-database.ts:336-346`) returns `Array<{ peerId: string; multiaddr: string | null }>` over `CadreControl.CadrePeer`.
- `CadrePeer.Multiaddr` holds a **comma-joined** list of multiaddr strings, and is `''` (empty string, never null in practice) when a peer was authorized with no addrs — see `seed-bootstrap.ts:200` (`multiaddrs.join(',')`) and the `multiaddr.split(',')` read at `seed-bootstrap.ts:513`. The cohort-seed derivation must split on `,` and drop empty fragments, mirroring that convention.
- `createLibp2pNode`'s `bootstrapNodes` takes an array of multiaddr strings (the control node already passes `controlNetwork.bootstrapNodes` straight through at `cadre-node.ts:308`).

## Design

### 1. Pure cohort/mode helpers — new `strand-cohort.ts`

Keep the decision logic out of the network-heavy classes so it is unit-testable without a libp2p node. New module `packages/cadre-core/src/strand-cohort.ts`:

```ts
import type { StrandMode } from './types.js';

export interface CohortPeerRow {
  peerId: string;
  multiaddr: string | null;
}

export interface CohortSeed {
  /** Dialable multiaddr strings for cohort peers other than self. */
  bootstrapNodes: string[];
  /** True when at least one CadrePeer row other than self exists (even if it has no dialable addr). */
  hasOtherPeers: boolean;
}

/**
 * Derive a strand's bootstrap seed from the control network's CadrePeer rows.
 * Excludes `selfPeerId`, splits each comma-joined `Multiaddr` field, and drops
 * empty fragments. `hasOtherPeers` reflects membership presence, NOT dialability,
 * so a cohort whose addrs are not yet known still selects `networked` mode.
 */
export function deriveCohortSeed(peers: CohortPeerRow[], selfPeerId: string | undefined): CohortSeed { ... }

/**
 * Choose the strand mode. An explicit mode (from `addStrand`) always wins. When
 * omitted (the `handleStrandAdded` discovery path, or an `addStrand` caller that
 * leaves it unset), infer: `bootstrap` for a solo/first node (no other peers),
 * `networked` once the cohort has other members.
 */
export function selectStrandMode(explicitMode: StrandMode | undefined, hasOtherPeers: boolean): StrandMode {
  return explicitMode ?? (hasOtherPeers ? 'networked' : 'bootstrap');
}
```

Dedup `bootstrapNodes` (a peer with several addrs, or duplicate fragments, should not produce repeats). Trim fragments before the empty check.

### 2. Thread the seed into `startStrand`

`StartStrandConfig` (`strand-instance-manager.ts:34-48`) gains:

```ts
/** Cohort-derived discovery seed (multiaddr strings). Defaults to [] when omitted. */
bootstrapNodes?: string[];
```

In `startStrand`, replace the hardcoded `bootstrapNodes: []` (line 199) with `bootstrapNodes: config.bootstrapNodes ?? []` and drop the now-obsolete `// Will be populated from strand cohort` comment.

### 3. One shared launch path in `CadreNode`

Both entry points currently duplicate the `startStrand(...)` + `hibernationManager.trackStrand` + `emit('strand:started')` sequence. Factor a private helper and route both through it:

```ts
private async launchStrand(strand: StrandRow, sAppConfig: SAppConfig, explicitMode?: StrandMode): Promise<StrandInstance> {
  const seed = await this.resolveCohortSeed();          // queries CadrePeer, excludes self
  const mode = selectStrandMode(explicitMode, seed.hasOtherPeers);
  const instance = await this.strandManager.startStrand({
    strandRow: strand,
    sAppConfig,
    storage: this.config.storage,
    network: this.config.network,
    profile: this.config.profile,
    defaultLatencyHint: this.config.hibernation?.defaultLatencyHint ?? 'interactive',
    privateKey: this.config.privateKey,
    bootstrapNodes: seed.bootstrapNodes,
    mode,
  });
  this.hibernationManager.trackStrand(instance);
  this.emit('strand:started', { strandId: strand.Id });
  return instance;
}

private async resolveCohortSeed(): Promise<CohortSeed> {
  if (!this.controlDatabase) return { bootstrapNodes: [], hasOtherPeers: false };
  const peers = await this.controlDatabase.queryCadrePeers();
  return deriveCohortSeed(peers, this.controlNode?.peerId.toString());
}
```

- `handleStrandAdded` (`cadre-node.ts:401-415`): replace its inline `startStrand` + track + emit with `await this.launchStrand(strand, sAppConfig)` (no explicit mode → inferred). Keep the surrounding `try/catch` that emits `strand:error`.
- `addStrand` (`cadre-node.ts:523-549`): keep registering `sAppConfigs`, then replace its inline block with `return await this.launchStrand(strandRow, sAppConfig, mode)`. Passing `mode` (possibly `undefined`) preserves caller choice and gives the **mixed-path parity** the plan calls for: a solo caller that omits `mode` now also infers `bootstrap`.

Add the import: `import { deriveCohortSeed, selectStrandMode, type CohortSeed } from './strand-cohort.js';`.

### 4. Doc-comment touch-ups

- `StartStrandConfig.mode` / `StrandConfig.mode` (`types.ts:288-290`): note that an omitted `mode` is now inferred from cohort membership (`bootstrap` solo, `networked` with peers), not hardcoded to `'networked'`.
- `strand-database.ts` and `docs/architecture.md` "Strand Mode: Bootstrap vs Networked" (`architecture.md:433-442`): add a sentence that mode is auto-selected from `CadrePeer` membership on the discovery path, and that the strand's `bootstrapNodes` seed is derived from cohort `CadrePeer` multiaddrs. Keep it tight — no new doc files (per AGENTS.md).

## Key tests (TDD)

Pure helpers — `packages/cadre-core/test/strand-cohort.spec.ts` (fast, no network):

- `deriveCohortSeed([], selfId)` → `{ bootstrapNodes: [], hasOtherPeers: false }`.
- Excludes self: rows `[{peerId: self, multiaddr: '/ip4/...'}]` → `hasOtherPeers: false`, empty seed.
- Splits comma-joined addrs: `multiaddr: '/a,/b'` (other peer) → `bootstrapNodes` contains `/a` and `/b`.
- Empty/`''`/null multiaddr on an *other* peer → counts toward `hasOtherPeers: true` but contributes no `bootstrapNodes` entry (membership present, not dialable).
- Dedups repeated fragments across peers.
- `selectStrandMode('bootstrap', true)` → `'bootstrap'` (explicit wins); `selectStrandMode('networked', false)` → `'networked'`; `selectStrandMode(undefined, false)` → `'bootstrap'`; `selectStrandMode(undefined, true)` → `'networked'`.

`strand-instance-manager.spec.ts`:

- `startStrand` accepts a `bootstrapNodes` array and still reaches `status: 'active'` (smoke; the existing 30s-timeout pattern). Asserting the value actually reaches `createLibp2pNode` is awkward without mocking that import — prefer to cover the value-derivation via the pure-helper specs and treat this as an acceptance smoke. If a spy is cheap (e.g. `vi.mock('@optimystic/db-p2p', ...)`), assert the forwarded `bootstrapNodes`; otherwise document the gap in the review handoff rather than forcing a brittle mock.

`cadre-node.spec.ts`:

- Existing `addStrand` test (no `CadrePeer` rows present) must still pass and now implies `bootstrap` mode — add an assertion that `addStrand` on a fresh node (empty cohort) yields a working instance, demonstrating solo cold-start no longer requires an explicit `mode`.

Run: `cd packages/cadre-core; yarn test 2>&1 | tee /tmp/cadre-core-test.log` (stream output — strand tests carry 30–60s timeouts). Also `yarn build` (or `yarn tsc --noEmit`) for the package to confirm types. Watch for pre-existing failures unrelated to this diff (see the pre-existing-error rule) — the seed/formation/network specs are network-heavy and may be flaky independent of these changes.

## TODO

- [ ] Add `packages/cadre-core/src/strand-cohort.ts` with `deriveCohortSeed` + `selectStrandMode` (and `CohortPeerRow` / `CohortSeed` types).
- [ ] Add `bootstrapNodes?: string[]` to `StartStrandConfig`; use `config.bootstrapNodes ?? []` in `createLibp2pNode`; remove the stale comment.
- [ ] Add `CadreNode.resolveCohortSeed()` + `CadreNode.launchStrand()`; route `handleStrandAdded` (inferred mode) and `addStrand` (explicit-or-inferred mode) through it; remove the duplicated start/track/emit blocks.
- [ ] Import the helpers in `cadre-node.ts`.
- [ ] Update doc comments in `types.ts`, `strand-database.ts`, and the `docs/architecture.md` Strand Mode section.
- [ ] Write `strand-cohort.spec.ts`; extend `strand-instance-manager.spec.ts` and `cadre-node.spec.ts` per above.
- [ ] `yarn test` + `yarn build` in `packages/cadre-core`, streaming output; flag any pre-existing failures via `tickets/.pre-existing-error.md`.
