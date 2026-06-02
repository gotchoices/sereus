description: Review — strand bootstrap-seed derivation from CadrePeer cohort, and cohort-inferred strand mode on both the explicit (addStrand) and control-discovered (handleStrandAdded) launch paths in @serfab/cadre-core.
files: packages/cadre-core/src/strand-cohort.ts, packages/cadre-core/src/strand-instance-manager.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/types.ts, packages/cadre-core/src/strand-database.ts, packages/cadre-core/test/strand-cohort.spec.ts, packages/cadre-core/test/strand-instance-manager.spec.ts, packages/cadre-core/test/cadre-node.spec.ts, docs/architecture.md
----

## What was implemented

Two cadre-core defects from the plan are addressed:

1. **Empty bootstrap seed.** `StrandInstanceManager.startStrand` no longer hardcodes `bootstrapNodes: []`. `StartStrandConfig` gained `bootstrapNodes?: string[]`; the libp2p node is created with `config.bootstrapNodes ?? []`. The stale `// Will be populated from strand cohort` comment is gone.

2. **Mode dropped on the discovery path.** Both `CadreNode.addStrand` and `CadreNode.handleStrandAdded` now route through a single private `launchStrand(strand, sAppConfig, explicitMode?)` helper, which:
   - calls `resolveCohortSeed()` → queries `controlDatabase.queryCadrePeers()` and derives the seed via `deriveCohortSeed(peers, selfPeerId)` (self excluded);
   - selects the mode via `selectStrandMode(explicitMode, seed.hasOtherPeers)` — explicit wins, else `bootstrap` (solo) / `networked` (cohort has other members);
   - starts the strand with both `bootstrapNodes` and `mode`, tracks hibernation, emits `strand:started`.

   `handleStrandAdded` passes no explicit mode (inferred). `addStrand` forwards its (possibly `undefined`) `mode`, giving the mixed-path parity the plan asked for: a solo `addStrand` caller that omits `mode` now also infers `bootstrap`.

### New pure module — `strand-cohort.ts`
`deriveCohortSeed(peers, selfPeerId)` → `{ bootstrapNodes, hasOtherPeers }`. Excludes self, splits comma-joined `Multiaddr`, trims fragments, drops empties, dedups. `hasOtherPeers` tracks membership presence (not dialability), so an addr-less cohort still selects `networked`. `selectStrandMode(explicit, hasOtherPeers)` does the `?? (hasOtherPeers ? 'networked' : 'bootstrap')`.

### Docs / comments
Updated `StrandConfig.mode` / `StartStrandConfig.mode` doc comments, the `strand-database.ts` plugin-registration comment, and the `docs/architecture.md` "Strand Mode" section to describe cohort-inferred mode + cohort-derived `bootstrapNodes`.

## Validation performed

- `yarn build` (cadre-core) — clean, `dist/strand-cohort.js` emitted.
- `yarn test` (cadre-core) — **202 passed / 16 files**, no failures. No `.pre-existing-error.md` filed (suite was green).
- New `strand-cohort.spec.ts` (9 tests, pure/no-network): empty seed, self-exclusion, comma split, addr-less-other-peer counts toward membership only, dedup, trim/empty-drop, undefined-self, and all four `selectStrandMode` cases.
- `strand-instance-manager.spec.ts`: added a `bootstrapNodes` acceptance smoke. It uses a **real generated Ed25519 peer id** in the multiaddr (a fake peer id makes libp2p's bootstrap module throw `Incorrect length`); the strand still reaches `status: 'active'`. This run takes ~8s because libp2p actually attempts to dial the seed — which is incidental proof the value is forwarded to `createLibp2pNode`.
- `cadre-node.spec.ts`: added a solo cold-start test — `addStrand` on a fresh node with no `mode` (empty cohort) yields an `active` instance, demonstrating bootstrap inference without an explicit mode.

## Use cases to exercise in review

- Solo / first-launch node, `addStrand` without `mode` → strand comes up in `bootstrap` (local transactor), no peer round trips, schema applies.
- Node with other `CadrePeer` rows present → `addStrand`/discovery infers `networked` and seeds `bootstrapNodes` from their multiaddrs.
- `handleStrandAdded` (control-discovered strand with a pre-registered sAppConfig) → same inference path; `strand:error` still emitted on failure (try/catch preserved).
- Explicit `mode: 'networked'` on a solo node still forces `networked` (explicit wins).

## Known gaps / honest flags (treat as a floor)

- **Seed is empty in the live system today.** `registerSelf` is still an authorization-gated no-op (explicitly out of scope, `cadre-node.ts`), so no `CadrePeer` rows are written in practice yet. This ticket reads whatever rows exist and is correct when there are none — but until `registerSelf` actually inserts rows, `deriveCohortSeed` returns an empty seed and `selectStrandMode` always infers `bootstrap` on the discovery path. The end-to-end value only lands once self-registration writes rows. Reviewer may want to confirm this is the intended sequencing.
- **No direct unit test of `launchStrand` with populated `CadrePeer` rows.** Seeding `CadrePeer` requires an authorized control-DB insert (gated, see above). The seed-derivation + mode-selection logic is covered by the pure `strand-cohort.spec.ts`; the `CadreNode` wiring is exercised only via the empty-cohort cold-start path. The non-empty-cohort wiring (`resolveCohortSeed` reading real rows, mode flipping to `networked`) is **not** integration-tested here. A control-DB integration test that authorizes a CadrePeer insert and asserts the resulting mode/seed would close this.
- **`bootstrapNodes` forwarding is asserted indirectly.** The smoke test infers forwarding from "node dials the seed / reaches active" rather than spying the exact array passed to `createLibp2pNode`. Per the plan, a `vi.mock('@optimystic/db-p2p', ...)` spy was deemed not worth the brittleness; the exact value-derivation lives in the pure specs. If the reviewer wants a hard assertion, a mock-based spy on `createLibp2pNode` is the cleaner-than-dialing route.
- **DHT absence unchanged (out of scope).** optimystic `db-p2p` still lacks a Kademlia DHT; discovery beyond the seed still leans on FRET gossip. Acknowledged in the plan as a separate concern.
- Network-heavy seed/formation specs in this package are inherently flaky; this run was green but a re-run may surface unrelated timeouts.
