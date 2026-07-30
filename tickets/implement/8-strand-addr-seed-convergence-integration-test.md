description: Add a real-network test proving that two nodes of the same party actually join the same strand together when the second node asks the first for its address over the network — the core scenario the recent seeding fix enables but which today is only checked with stand-in objects.
prereq:
files: packages/integration-tests/src/scenarios/strand-addr-seed-convergence.integration.ts (new), packages/integration-tests/src/scenarios/push-wake-e2e.integration.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/strand-instance-manager.ts, packages/cadre-core/src/types.ts, packages/cadre-core/src/strand-addr-protocol.ts, packages/cadre-core/src/strand-cohort.ts
difficulty: hard
----

## Why this exists

`strand-seed-from-strand-addr-rpc` (commit `aafaea9`) rewired strand seeding: a node
resolves a strand's bootstrap addresses on demand over the control mesh
(`/sereus/strand-addr/1.0.0`) instead of mis-using each sibling's **control**
multiaddr. Today that is proven only by unit loopbacks — every existing test stubs
`controlNode.dialProtocol` and feeds a hand-built `StrandAddrService` over an
in-memory `duplexPair`. No test stands up two real `CadreNode`s with real strand
libp2p instances and verifies the convergence end to end.

Every existing strand integration scenario (`strand-formation-e2e`,
`multi-party-workflows`, `rbac-signed-write`, `convergence-stress`,
`websocket-chat`, `strand-membership-closed-strand-e2e`) hand-dials one strand node
into the other:

```ts
await bobStrand.libp2pNode!.dial(aliceStrand.libp2pNode!.getMultiaddrs()[0]!);
```

**The new scenario must never hand-dial.** Its whole subject is that the seed
`CadreNode` resolved over the RPC is enough for the joining strand node to find and
connect to the founder's strand node on its own.

## Research findings that fix the design

Read these before writing code; they are the load-bearing facts.

- **Seed resolution** — `CadreNode.resolveCohortSeed` (`cadre-node.ts:3239`):
  cohort members come from `CadrePeer` rows (`deriveCohortMembers`), the RPC targets
  are those member peerIds **intersected with currently-open control connections**,
  and the seed is `collectStrandAddrs(controlNode, targets, strandId, { delegatePeerId })`.
  So the joiner needs BOTH a `CadrePeer` row for the founder AND a live control
  connection to it, or the seed is silently `[]`.
- **Mode selection** — `selectStrandMode(explicitMode, hasOtherPeers)`
  (`strand-cohort.ts:75`): explicit mode wins; otherwise `hasOtherPeers ? 'networked' : 'bootstrap'`.
  `hasOtherPeers` is row presence only, not dialability.
- **Responder** — `getStrandMultiaddrs` (`cadre-node.ts:3369`) returns the raw
  `node.getMultiaddrs()` of the local strand instance whenever a live `libp2pNode`
  exists, **regardless of the strand's mode**. A `bootstrap`-mode founder therefore
  answers. Gate is `isAuthorizedMember` (voucher on the requester's `CadrePeer` row,
  verified against the responder's node-local trusted-owner anchor) — a row alone is
  not enough.
- **Seed → connection** — `StrandInstanceManager.buildStrandRuntime` passes
  `bootstrapNodes` into `createLibp2pNode`, which turns it into
  `peerDiscovery: [bootstrap({ list })]` (optimystic `libp2p-node-base.ts:663`).
  libp2p's connection manager auto-dials discovered peers; this repo already relies on
  that (`push-wake-e2e` scenario 2 waits for a control node to auto-connect to its
  configured `bootstrapNodes`). No explicit dial call exists anywhere in that path.
- **Connection gater** — the membership gater is applied to the CONTROL node only
  (`cadre-node.ts:958`); strand nodes get the raw configured gater (none in these
  tests). So no delegate-admission grant is needed for a same-host direct dial
  between two strand nodes. (Grants only matter for relays.)
- **`mode` is currently unobservable.** `StrandInstance` (`types.ts:476`) carries no
  `mode`, `StrandDatabase` does not expose it, and `strand-cohort.ts` is not exported
  from `cadre-core/src/index.ts`. The test cannot assert "B came up networked" today —
  see the first phase below, which fixes that.
- **`bootstrap` mode uses a purely local transactor** (`strand-database.ts:94`,
  `strand-instance-manager.ts:302-316`). So a founder in `bootstrap` mode does NOT
  commit through the strand cluster: **do not assert data replication between A and B.**
  The assertion is the strand-network CONNECTION plus the resolved seed's content.

## Decisions taken (do not re-litigate)

1. **Founder A launches with an explicit `mode: 'bootstrap'`.** Deterministic
   regardless of whether B's `CadrePeer` row has already converged into A's control DB
   when A launches, and it directly exercises the documented claim that a
   `bootstrap`-mode first node still answers the RPC. Tradeoff: it does not also prove
   the *derived* `bootstrap` selection — that is already unit-covered by
   `selectStrandMode`, and leaving it implicit would make the test order-dependent.
2. **Joiner B calls `addStrand` with NO `mode`,** so the mode is cohort-inferred —
   the same `launchStrand(row, sApp, undefined, …)` path the control-discovered join
   takes. Tradeoff: this skips the `StrandWatcher` discovery poll (5 s) and its
   `strand:discovered` event; that path adds latency and moving parts without touching
   the seam under test. Both nodes construct the strand row locally (push-wake style);
   no `publishStrand` is needed.
3. **Assert connection, not replication** (see the `bootstrap`-mode transactor note).
4. **Same-host direct dial only.** NAT/relay strand reachability stays in
   `strand-network-nat-relay-reachability`; cross-party discovery stays out entirely.
5. **`mode` becomes observable on `StrandInstance`** rather than exporting
   `strand-cohort.ts` and restating the pure function in the test. Asserting the input
   to a pure function is not the claim; the claim is what the instance actually ran as.

## Phase 1 — make the strand's lifecycle mode observable

Small production change, prerequisite for the test's central assertion.

- Add `mode: StrandMode` to `StrandInstance` in `packages/cadre-core/src/types.ts`,
  documented as "the lifecycle mode this instance's runtime was built with —
  `bootstrap` (purely local transactor) or `networked` (cluster transactor)".
- Set it in `StrandInstanceManager.buildStrandRuntime`
  (`strand-instance-manager.ts:241`) from the same value already handed to
  `StrandDatabase`: `config.mode ?? 'networked'`. Assign it on the instance next to
  `instance.libp2pNode = node`, so **resume also refreshes it** — `resumeStrand`
  re-runs `buildStrandRuntime` with `resumeConfig`, which is exactly where a
  `bootstrap → networked` shift lands and where a stale field would lie.
- Seed the field at instance construction (`strand-instance-manager.ts:207`) so an
  instance that fails during `buildStrandRuntime` (status `'error'`) still type-checks
  and reads sensibly; it is immediately overwritten by the runtime build.
- Do NOT change any behavior driven by mode. This field is read-only reporting.

## Phase 2 — the scenario

New file `packages/integration-tests/src/scenarios/strand-addr-seed-convergence.integration.ts`,
modeled on `push-wake-e2e.integration.ts`. Copy its local helpers (`wsTransports`,
`SIMPLE_SCHEMA`, `createSignedSAppConfig`, `nodeConfig`, `controlAddrs`,
`makeOwnOwner`, `connectControlNodes`) — see the harness note at the bottom before
deciding where they live. Reuse `waitUntil` / `waitForCadrePeerConverged` from
`../harness/index.js`.

**Topology — one party, single owner (this is forced, not stylistic):** the
network-backed control DB is party-shared, so two nodes cannot each self-genesis; the
second `OwnerKey` insert fails the `Authorized` bootstrap check once the first has
replicated. Founder **A** is the party's sole owner + `profile: 'storage'`; joiner
**B** is a plain member.

Ordering that makes every write a clean 2-node commit:

- Start A. `makeOwnOwner(A, aKey)` → `aOwnerPub`. A genesises ALONE.
- Start B with a stable `privateKey` and `bootstrapNodes: [aControlAddr]` (the
  bootstrap entry is what makes A unconditionally admitted by B's fail-closed
  per-stream control-DB gate once B's member snapshot goes non-empty — see push-wake
  design note 3).
- **A needs a real, non-ephemeral control identity here** — unlike push-wake, where
  the owner is deliberately ephemeral. A's own `CadrePeer` row IS the RPC target and
  the thing that flips B to `networked`. Pass `privateKey: aKey`-style config so A's
  peerId is stable, and write A's own row with `await A.authorizePeer(aPeerId)`.
- `await B.trustOwnerKeys([aOwnerPub], 'invite')` and
  `await A.trustOwnerKeys([aOwnerPub], 'invite')` if A does not already trust its own
  owner key — **verify this** before assuming: `initializeSeedBootstrap` may already
  self-pin. A must end up with `isAuthorizedMember(bPeerId) === true` or the RPC
  returns an empty list and the test fails for the wrong reason. Assert it explicitly.
- `await connectControlNodes(B, A)` (both-sides confirmed) BEFORE any write the
  assertions hinge on.
- A writes both rows: `A.authorizePeer(aPeerId)` and `A.authorizePeer(bPeerId)`.
- `await waitForCadrePeerConverged(B.getControlDatabase()!, aPeerId, …)`, then assert
  `await B.isMember(aPeerId) === true`.

Then the subject of the test:

- A launches the strand: `A.addStrand({ strandRow: { Id: strandId, MemberPrivateKey: null, Type: 'o' }, sAppConfig, mode: 'bootstrap' })`.
  Assert `status === 'active'`, `mode === 'bootstrap'` (phase 1 field), and
  `libp2pNode!.getMultiaddrs().length > 0`. Capture `aStrandPeerId =
  aStrand.libp2pNode!.peerId.toString()` and `aStrandAddrs` (strings).
- **Direct RPC assertion (the responder half).** From B's control node, call the
  exported `collectStrandAddrs(B.getControlNode()!, [{ peerId: aPeerId }], strandId)`.
  Assert the result is non-empty, that every returned addr is in `aStrandAddrs`, and —
  the regression guard — that the intersection with `controlAddrs(A)` is **empty** and
  that no returned addr contains A's control peerId. A `bootstrap`-mode node answering
  at all is itself part of the claim.
- **Joiner (the requester half).** `B.addStrand({ strandRow: {…same Id…}, sAppConfig })`
  with **no `mode`**. Assert `status === 'active'` and `mode === 'networked'`.
- **Convergence.** `waitUntil` B's strand `libp2pNode!.getConnections()` contains a
  connection whose `remotePeer.toString() === aStrandPeerId`; and symmetrically that
  A's strand node sees B's strand peerId. Generous timeout (30 s) — bootstrap discovery
  plus auto-dial is not instant. **No manual `dial` anywhere in this test.**
- **Negative.** Assert B's strand node has NO connection to `aPeerId` (A's *control*
  peerId), and that B's strand node's known/dialed addresses never included a control
  addr — the practical form is: the connection set's remote peerIds ⊆ {aStrandPeerId},
  and `aStrandPeerId !== aPeerId` (assert that too; if the derived transport key ever
  collapsed to the control identity the whole test would pass vacuously).

Teardown: `try/finally` stopping B then A, as push-wake does.

## Edge cases & interactions

- **Founder in `bootstrap` mode meshing with a `networked` joiner.** The founder's
  local transactor means no cross-node commit path — assert connection only. If a later
  ticket wants data convergence, both nodes must be `networked`, which needs a third
  node or an explicit mode on A; out of scope here, note it in the handoff.
- **Empty seed is silent.** `collectStrandAddrs` folds every per-peer failure to `[]`
  and `resolveCohortSeed` returns `[]` with no error, so a broken RPC surfaces as "B
  never connects" 30 s later. The direct `collectStrandAddrs` assertion BEFORE B's
  `addStrand` exists precisely so that failure mode is diagnosed at the responder, not
  blamed on discovery.
- **Connected-siblings filter.** If the control connection drops between
  `connectControlNodes` and `B.addStrand`, `targets` is empty and the seed is `[]`.
  Re-assert the control connection immediately before `B.addStrand`.
- **Ordering: strand up before the joiner asks.** If B launches before A's strand
  node is listening, the RPC legitimately returns `[]` and B stands up
  networked-with-empty-seed. The sequence above forbids that; keep the launch of A's
  strand strictly before B's.
- **Self-exclusion.** `collectStrandAddrs` filters `node.peerId` out of candidates. A
  test that accidentally passed B's own peerId would get `[]`; use A's peerId only.
- **Authorization gate is the responder's, not the requester's.** A rejects B with an
  empty list (not an error) if B's row is missing/unvouched or A's anchor lacks
  `aOwnerPub`. Assert `await A.isAuthorizedMember(bPeerId) === true` before the RPC so
  a gate failure is distinguishable from an address-lookup failure.
- **Port/identity collisions.** Both strand nodes listen on `/ip4/127.0.0.1/tcp/0/ws`
  (ephemeral). A's strand transport peerId is DERIVED from its identity key
  (`strand-transport-key.ts`) and must differ from its control peerId — asserted above.
- **Teardown ordering.** Stop the joiner first; stopping the founder's strand node
  while B is mid-dial produces noisy but non-fatal errors.
- **Cross-test interference.** Party id and strand id must be `Date.now()`-suffixed
  like every push-wake scenario; the suite runs `fileParallelism: false` but files
  share the machine.

## Validation

- `yarn workspace @serfab/cadre-core build && yarn workspace @serfab/cadre-core typecheck`
  (phase 1 touches production types; the integration suite's stale-build guard fails
  the run if `dist` predates `src`).
- `yarn lint` — fully-enforced gate.
- Run ONLY the new file, streaming so the runner's 10-minute idle timer never fires:
  `yarn workspace @serfab/integration-tests test src/scenarios/strand-addr-seed-convergence.integration.ts 2>&1 | tee /tmp/strand-addr-seed.log`
  One scenario at ~60–90 s is agent-runnable. **Do not** run the whole
  `integration-tests` suite inline — that is the >10-minute, out-of-band/CI job.
- If the auto-dial convergence proves genuinely flaky (not merely slow), do NOT paper
  over it with a manual `dial` — that erases the claim. Report it in the review handoff
  with the observed timings so it can be triaged as a real seeding/discovery gap.

## TODO

Phase 1 — observable mode
- Add `mode: StrandMode` to `StrandInstance` (`types.ts`), documented as the runtime's
  lifecycle mode.
- Set it in `buildStrandRuntime` from `config.mode ?? 'networked'`, next to
  `instance.libp2pNode = node`, so resume refreshes it; seed it at instance
  construction.
- Build + typecheck `cadre-core`.

Phase 2 — scenario
- Create `packages/integration-tests/src/scenarios/strand-addr-seed-convergence.integration.ts`
  with a file header explaining what the unit loopbacks cannot prove (mirror the
  push-wake header's style and depth).
- Stand up the one-party, single-owner A/B topology with the ordering above; assert
  `isAuthorizedMember` both ways before touching the RPC.
- Launch A's strand `mode: 'bootstrap'`; assert active + mode + non-empty strand addrs.
- Assert the direct `collectStrandAddrs` result: non-empty, ⊆ A's strand addrs,
  disjoint from A's control addrs.
- Launch B's strand with no explicit mode; assert active + `mode === 'networked'`.
- `waitUntil` both strand nodes report a connection to each other's strand peerId —
  with no manual `dial` anywhere in the file.
- Assert the negative: B's strand node never connects to A's CONTROL peerId, and
  A's strand peerId ≠ A's control peerId.
- Run lint, build, and the single scenario file with `tee`.

Handoff notes for the reviewer
- State plainly whether the auto-dial convergence was stable across runs, with timings.
- Note that data replication between A and B is NOT asserted, and why
  (`bootstrap`-mode local transactor).
- Note whether the push-wake helpers were copied or shared; the consolidation is
  tracked in `integration-test-harness-helper-consolidation`, which has not landed —
  copy now, and leave a `NOTE:` comment at the copy site naming that ticket rather than
  pre-emptively refactoring the harness here.
