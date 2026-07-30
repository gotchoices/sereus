----
description: Add a real-network test proving that two nodes of the same party join the same strand together when the second node asks the first for its address over the network. The groundwork (making a strand's lifecycle mode visible on its instance record) is already done; this ticket writes the test itself.
prereq:
files: packages/integration-tests/src/scenarios/strand-addr-seed-convergence.integration.ts (new), packages/integration-tests/src/scenarios/push-wake-e2e.integration.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/strand-instance-manager.ts, packages/cadre-core/src/types.ts, packages/cadre-core/src/strand-addr-protocol.ts, packages/cadre-core/src/strand-cohort.ts
difficulty: hard
----

Continuation of `strand-addr-seed-convergence-integration-test` — the prior run hit
its token budget after landing Phase 1 (the observable-mode production change).
**Phase 1 is DONE and verified** (cadre-core build + typecheck green); this ticket
is Phase 2 only: the integration scenario, plus the deferred validation.

## Phase 1 — ALREADY LANDED (do not redo; context for the test's assertions)

- `StrandInstance.mode: StrandMode` added in `packages/cadre-core/src/types.ts`
  (required field, documented as read-only reporting of the runtime's lifecycle
  mode — `bootstrap` = purely local transactor, `networked` = cluster transactor).
- `StrandInstanceManager.buildStrandRuntime` hoists `const mode = config.mode ?? 'networked'`
  and assigns `instance.mode = mode` right after `instance.libp2pNode = node`, so
  resume (which re-runs `buildStrandRuntime`) refreshes a `bootstrap → networked`
  shift. The instance construction in `startStrand` seeds the field with the same
  expression so an instance that errors mid-build still type-checks.
- All 19 test-double constructions of `StrandInstance` updated (cadre-core
  `test/cadre-node.spec.ts`, `test/types.spec.ts`, `test/hibernation-manager.spec.ts`,
  `test/push-fanout.spec.ts`, `test/strand-wake-protocol.spec.ts`;
  reference-app-rn `test/chat-strand.spec.ts`).
- Verified: `yarn workspace @serfab/cadre-core build` and `... typecheck` both pass.
- NOT yet run (budget): `yarn workspace @serfab/cadre-core test`, `yarn lint`. Run
  both as part of this ticket's validation — the touched unit specs got a new field
  in their stubs, nothing behavioral, but confirm.

## Facts verified against the code (trust these; they were read, not assumed)

- **`initializeSeedBootstrap` self-anchors the owner key** with `'genesis'`
  provenance (`cadre-node.ts` ~3618-3642). So founder A does NOT need
  `A.trustOwnerKeys([aOwnerPub], …)` for its own key — but still assert
  `await A.isAuthorizedMember(bPeerId) === true` before the RPC (see below).
- API signatures: `authorizePeer(peerId: string, multiaddrs?: string[])`,
  `trustOwnerKeys(keys, source)` (source `'invite'`), `addStrand(config: StrandConfig)`
  returning `StrandInstance`, `isAuthorizedMember(peerId)`, and `collectStrandAddrs`
  is exported from `@serfab/cadre-core` (push-wake scenario 3 already imports it).
- **A joiner's `StrandDatabase.initialize` writes nothing** — the founder membership
  bootstrap is gated on `config.founder === true` (`strand-database.ts:127`), so B's
  `networked` bring-up needs no cluster commit and won't hang at `addStrand`.
- `resolveCohortSeed` (`cadre-node.ts:3239`): RPC targets = CadrePeer rows minus self,
  **intersected with currently-open control connections**. Seed failure is silent
  (`[]`) — hence the direct-RPC assertion before B's `addStrand`.
- `selectStrandMode(explicit, hasOtherPeers)` (`strand-cohort.ts:75`): explicit wins;
  else row-presence decides. `getStrandMultiaddrs` (`cadre-node.ts:3369`) answers for
  any live strand node regardless of mode — a `bootstrap` founder answers.
- Strand nodes inherit `network.transports` + `listenAddrs` from `CadreNodeConfig`
  (`strand-instance-manager.ts` `buildStrandRuntime`), so `/ip4/127.0.0.1/tcp/0/ws`
  + websockets works for them with no extra config. `bootstrapNodes` become libp2p
  `bootstrap()` peer discovery; the connection manager auto-dials discovered peers
  (same mechanism push-wake scenario 2 relies on). **No manual dial anywhere.**
- integration-tests vitest default `testTimeout` is 60 s — give the `it()` an
  explicit `120_000`. File uses TABS (match push-wake).

## The scenario

New file `packages/integration-tests/src/scenarios/strand-addr-seed-convergence.integration.ts`,
modeled on `push-wake-e2e.integration.ts`. Copy its local helpers (`wsTransports`,
`SIMPLE_SCHEMA`, `createSignedSAppConfig`, `NodeOpts`/`nodeConfig`, `controlAddrs`,
`makeOwnOwner`, `connectControlNodes`) — leave a `NOTE:` comment at the copy site
naming `integration-test-harness-helper-consolidation` (not landed; copy, don't
refactor). Reuse `waitUntil` / `waitForCadrePeerConverged` from `../harness/index.js`.
File header: explain what the unit loopbacks (stubbed `dialProtocol`, hand-built
`StrandAddrService` over `duplexPair`) cannot prove — mirror push-wake's header
style. **Never hand-dial strand nodes** — the whole subject is that the RPC-resolved
seed alone is enough.

Topology — one party, single owner (forced: the network-backed control DB is
party-shared; a second `OwnerKey` genesis insert fails once the first replicates).
Founder **A**: sole owner + `profile: 'storage'` + **stable identity** — pass
`privateKey: aKey` in `nodeConfig` AND `makeOwnOwner(A, aKey)` (push-wake scenario 3
style: same key for node identity and owner). A's own `CadrePeer` row is the RPC
target and what flips B `networked`, so its peerId must be real and stable. Joiner
**B**: plain member, stable `privateKey: bKey`, `bootstrapNodes: [aControlAddr]`
(makes A unconditionally admitted by B's fail-closed control-stream gate once B's
member snapshot goes non-empty).

Ordering (every write a clean 2-node commit):

- Start A; `aOwnerPub = await makeOwnOwner(A, aKey)`. Genesis ALONE.
- Start B (key + bootstrap as above).
- `await B.trustOwnerKeys([aOwnerPub], 'invite')`. (A self-anchors via genesis — see
  verified facts.)
- `await connectControlNodes(B, A)` (both-sides confirmed) BEFORE any gated write.
- `await A.authorizePeer(aPeerId)` then `await A.authorizePeer(bPeerId)`.
- `await waitForCadrePeerConverged(B.getControlDatabase()!, aPeerId, { timeoutMs: 30_000, … })`;
  assert `await B.isMember(aPeerId) === true`.
- Assert both gates explicitly (distinguishes gate failure from addr-lookup failure):
  `await A.isAuthorizedMember(bPeerId) === true` and `await B.isAuthorizedMember(aPeerId) === true`.

Subject of the test:

- `A.addStrand({ strandRow: { Id: strandId, MemberPrivateKey: null, Type: 'o' }, sAppConfig, mode: 'bootstrap' })`.
  Assert `status === 'active'`, `mode === 'bootstrap'` (the Phase-1 field),
  `libp2pNode!.getMultiaddrs().length > 0`. Capture `aStrandPeerId` and
  `aStrandAddrs` (strings). Assert `aStrandPeerId !== aPeerId` immediately (derived
  transport key must not collapse to the control identity — else the test passes
  vacuously).
- **Responder half, direct RPC:**
  `collectStrandAddrs(B.getControlNode()!, [{ peerId: aPeerId }], strandId)` —
  assert non-empty, every addr ∈ `aStrandAddrs`, intersection with `controlAddrs(A)`
  empty, and no returned addr contains A's control peerId (regression guard: the old
  bug seeded strand meshes with control addrs).
- Re-assert the B↔A control connection is still open (the connected-siblings filter
  makes a dropped link an empty seed), then:
- **Requester half:** `B.addStrand({ strandRow: {…same Id…}, sAppConfig })` with NO
  `mode`. Assert `status === 'active'`, `mode === 'networked'`.
- **Convergence:** `waitUntil` (30 s, no manual dial) B's strand
  `libp2pNode!.getConnections()` has a connection with
  `remotePeer.toString() === aStrandPeerId`, and symmetrically A's strand node sees
  B's strand peerId.
- **Negative:** B's strand connections' remote peerIds all equal `aStrandPeerId`
  (in particular, never A's CONTROL peerId).

Teardown: `try/finally`, stop B then A (stopping founder first makes B's mid-dial
noise). Party id + strand id `Date.now()`-suffixed.

Do NOT assert data replication between A and B: a `bootstrap`-mode founder commits
through a purely local transactor (`strand-database.ts:94`,
`strand-instance-manager.ts` runtime build) — connection + seed content is the claim.
If a later ticket wants data convergence it needs both nodes `networked` (third node
or explicit mode on A) — note that in the review handoff, don't build it here.

## Edge cases (from the original research — keep in mind while writing)

- Empty seed is silent (`collectStrandAddrs` folds per-peer failure to `[]`) — the
  direct RPC assertion exists to catch responder-side failure before blaming
  discovery.
- A's own `addStrand` also runs a seed pass (targets = [bPeerId], B answers `[]`
  since its strand isn't running) — harmless, expected.
- `collectStrandAddrs` filters `node.peerId` from candidates — only pass A's peerId.
- If auto-dial convergence proves genuinely flaky (not merely slow), do NOT add a
  manual `dial` — report observed timings in the review handoff as a real
  seeding/discovery gap.

## Validation

- `yarn workspace @serfab/cadre-core test` — Phase 1 touched five unit-spec files'
  stubs; not yet run.
- `yarn lint` — fully-enforced gate; not yet run on the Phase 1 diff either.
- `yarn workspace @serfab/cadre-core build && yarn workspace @serfab/cadre-core typecheck`
  only if cadre-core src changes again (already green on the landed diff; the
  integration suite's stale-build guard needs dist ≥ src).
- Run ONLY the new scenario, streaming:
  `yarn workspace @serfab/integration-tests test src/scenarios/strand-addr-seed-convergence.integration.ts 2>&1 | tee /tmp/strand-addr-seed.log`
  Do NOT run the whole integration suite inline (>10 min, out-of-band/CI).

## Handoff notes for the reviewer (carry into the review ticket)

- Whether auto-dial convergence was stable across runs, with timings.
- Data replication A↔B deliberately NOT asserted (bootstrap-mode local transactor).
- Push-wake helpers copied, not shared — consolidation tracked in
  `integration-test-harness-helper-consolidation`; `NOTE:` comment at the copy site.
- Phase 1 (observable `mode`) landed in the preceding commit of this same pipeline
  run; its unit-test stub updates were mechanical (`mode: 'networked'` added to
  doubles).
