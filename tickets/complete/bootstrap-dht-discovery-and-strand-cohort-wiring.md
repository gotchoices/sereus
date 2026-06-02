description: Strand bootstrap-seed derivation from CadrePeer cohort, and cohort-inferred strand mode on both the explicit (addStrand) and control-discovered (handleStrandAdded) launch paths in @serfab/cadre-core. Reviewed and completed.
files: packages/cadre-core/src/strand-cohort.ts, packages/cadre-core/src/strand-instance-manager.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/types.ts, packages/cadre-core/src/strand-database.ts, packages/cadre-core/test/strand-cohort.spec.ts, packages/cadre-core/test/strand-instance-manager.spec.ts, packages/cadre-core/test/cadre-node.spec.ts, docs/architecture.md
----

## What shipped

Two cadre-core defects from the plan are addressed:

1. **Empty bootstrap seed eliminated.** `StrandInstanceManager.startStrand` no
   longer hardcodes `bootstrapNodes: []`. `StartStrandConfig` gained
   `bootstrapNodes?: string[]`; the libp2p node is created with
   `config.bootstrapNodes ?? []`. The stale comment is gone.

2. **Mode preserved on the discovery path.** `CadreNode.addStrand` and
   `CadreNode.handleStrandAdded` now both route through a single private
   `launchStrand(strand, sAppConfig, explicitMode?)` helper that resolves the
   cohort seed (`resolveCohortSeed()` → `queryCadrePeers()` → `deriveCohortSeed`,
   self excluded), selects the mode (`selectStrandMode`: explicit wins, else
   `bootstrap` solo / `networked` cohort), starts the strand with both
   `bootstrapNodes` and `mode`, tracks hibernation, and emits `strand:started`.

New pure module `strand-cohort.ts` holds `deriveCohortSeed` (self-exclusion,
comma-split, trim, empty-drop, dedup, membership-not-dialability `hasOtherPeers`)
and `selectStrandMode`. Doc comments in `types.ts` / `strand-instance-manager.ts`
/ `strand-database.ts` and the `docs/architecture.md` Strand Mode section were
updated to describe cohort inference.

## Review findings

### Validation re-run (this pass)

- **Build:** `yarn build` (cadre-core, `tsc -p tsconfig.build.json`) — clean,
  exit 0, `dist/strand-cohort.js` emitted.
- **Tests:** `yarn test` (cadre-core, `vitest run`) — **202 passed / 16 files**,
  0 failures, ~14s wall. No `.pre-existing-error.md` needed (suite green).
- **Lint:** cadre-core defines no `lint` script (root `yarn lint` is a no-op for
  this package); `tsc` strict is the effective type/lint gate and passes.

### Checked, no change needed

- **Plan fidelity / DRY.** Implementation matches the plan's `launchStrand` /
  `resolveCohortSeed` shape exactly; the two launch paths are properly
  consolidated (no duplicated start/track/emit blocks remain).
- **Self-exclusion correctness.** `resolveCohortSeed` excludes self by
  `this.controlNode?.peerId.toString()`, the same identity `registerSelf` would
  write as `CadrePeer.PeerId` — they agree, so a node will correctly drop its own
  future row.
- **Type/shape alignment.** `CohortPeerRow` matches `queryCadrePeers()`'s inline
  return type (`{ peerId, multiaddr: string|null }`); assignability is enforced
  at the call site, and the `!peer.multiaddr` guard covers both `''` and `null`.
- **Error handling.** `handleStrandAdded` keeps its try/catch → `strand:error`;
  `addStrand` still throws to its caller as before. No behavior regression.
- **Call sites.** `startStrand` is only invoked by `cadre-node.ts` (via
  `launchStrand`) and the manager tests — all consistent with the new optional
  `bootstrapNodes`.
- **Pure-helper test coverage.** `strand-cohort.spec.ts` (9 cases) covers empty,
  self-exclusion, comma-split, addr-less-membership, dedup, trim/empty-drop,
  undefined-self, and all four `selectStrandMode` branches. Good edge coverage.

### Found — fixed inline

- None. No minor defects surfaced that warranted an inline edit; the diff is
  clean, typed, and faithful to the plan.

### Found — filed as new ticket (major / latent)

- **Cohort seed uses control-network addresses, not strand-network addresses.**
  `deriveCohortSeed` feeds `CadrePeer.Multiaddr` (the **control** node's listen
  addrs, per `registerSelf`) into the per-strand libp2p node (`strand-<id>`, a
  separate instance on a different random port). Control and strand nodes share
  a peerId (same `config.privateKey`), so a control multiaddr resolves to the
  right peerId but the wrong libp2p instance — the strand mesh is not actually
  seeded. This is **latent** today because `registerSelf` writes no rows (the
  seed is always empty), and the plan explicitly scoped both `registerSelf`
  row-writing and strand-network/DHT discovery OUT of the originating ticket.
  Captured for the future-discovery design work in
  `tickets/backlog/strand-cohort-seed-uses-control-network-addresses.md`.

### Honest gaps carried forward (acknowledged, not regressions)

- **Seed is empty in the live system today.** `registerSelf` remains an
  authorization-gated no-op, so no `CadrePeer` rows exist in practice; the
  discovery path always infers `bootstrap` until self-registration lands. The
  code is correct for the zero-row case (verified by the cold-start test) and
  for populated rows (verified by the pure derivation specs).
- **No integration test of the non-empty-cohort wiring.** Seeding `CadrePeer`
  requires an authorized control-DB insert (gated). `resolveCohortSeed` /
  `launchStrand` are private and only exercised via the empty-cohort cold-start
  path; the populated-cohort mode-flip-to-`networked` is logic-tested in
  `strand-cohort.spec.ts` but not integration-tested. Closing it cleanly is
  blocked on the same authorized-insert work as `registerSelf` — not worth a
  brittle mock now.
- **`bootstrapNodes` forwarding asserted indirectly.** The manager smoke test
  infers forwarding from "node dials the seed / reaches active" (uses a real
  Ed25519 peer id so libp2p's bootstrap validator accepts it) rather than spying
  the exact array into `createLibp2pNode`. The value-derivation itself is covered
  by the pure specs; a `vi.mock` spy was deemed not worth the brittleness.
- **DHT absence unchanged (out of scope).** optimystic `db-p2p` still lacks a
  Kademlia DHT; discovery beyond the seed leans on FRET gossip. Tracked
  separately and related to the new backlog ticket above.
- Network-heavy seed/formation specs in this package are inherently flaky; this
  run was green but a re-run may surface unrelated timeouts.
