----
description: Someone starts a workspace on their phone, then adds a second machine to their account. Add the integration test that proves the workspace's existing contents really arrive on that new machine, and still open there when it is on its own.
files: packages/integration-tests/src/scenarios/strand-late-cadre-join.integration.ts, packages/integration-tests/src/harness/node-fixtures.ts, packages/integration-tests/src/harness/block-store-probe.ts, packages/integration-tests/src/harness/control-trio.ts, packages/integration-tests/src/scenarios/strand-unpublish-sibling-convergence.integration.ts, packages/integration-tests/src/scenarios/strand-addr-seed-convergence.integration.ts, packages/integration-tests/src/scenarios/control-offline-read-after-restart.integration.ts, packages/integration-tests/src/scenarios/strand-membership-closed-strand-e2e.integration.ts, packages/cadre-core/src/peer-join-backfill.ts
difficulty: hard
----

# A machine that joins the cadre *after* a strand exists must receive that strand

One new scenario file, plus one small option added to the shared node-config helper.

## The shape being proved

One party (the **cadre** — the set of machines that represent one person). One machine (the
**founder**, standing in for a phone) creates a workspace (a **strand**), publishes it, and writes
rows into it while it is the party's only machine. A **newcomer** machine is then enrolled into the
party, learns about the strand through the product's own discovery path, runs it, and ends up
physically holding the rows that were written before it existed — still readable when it is the
only machine running.

Nothing in the suite covers this today. The two halves are each covered separately and never
together: a machine joining a party late is only ever shown reading the **control** database
(`control-offline-read-after-restart.integration.ts:88-153`,
`cadre-host-node-donation.integration.ts`), and every scenario that runs two real strand instances
starts **both** machines before the strand is created
(`strand-addr-seed-convergence.integration.ts:88,100,139,181`,
`websocket-chat.integration.ts:83,106,121,124`,
`convergence-stress.integration.ts:170,188,201,204`,
`strand-formation-e2e.integration.ts:455,461,493,499`).
`strand-membership-closed-strand-e2e.integration.ts:535-587` comes closest, but its two nodes belong
to different parties and both are up before either joins.

## Design decisions already settled — do not re-open these

**The founder is dialable over loopback WebSockets.** The story says "phone", but the newcomer's
`applySeed` has to dial *someone*, and a founder with no inbound reachability needs a relay. Relayed
reachability is `strand-network-nat-relay-reachability`'s subject and is out of scope here; both
machines listen on `/ip4/127.0.0.1/tcp/0/ws`.

**Enrollment runs the production membership path**, exactly as `control-trio.ts:140-163` does it:
vouch the newcomer (`authorizePeer`) *before* it starts, then `createSeed` on the founder and
`applySeed` on the newcomer. The newcomer pins the founder's owner public key into its node-local
trusted-owner anchor via `ControlNodeOpts.pinnedOwnerKeys`, so the default anchored seed policy
accepts the seed rather than riding an empty-anchor carve-out.

**The newcomer learns the strand from the `strand:discovered` event**, not from a test-side copy of
the strand row. The founder calls `publishStrand` (owner-signed `Strand` row) while alone; the
newcomer's `StrandWatcher` reads that row over the network and, holding no sApp config for the id,
emits `strand:discovered` carrying the full `StrandRow` (`cadre-node.ts:3527-3536`, typed at
`types.ts:903`). The test registers the sApp config and calls `addStrand` with **that** row — the
pattern `strand-unpublish-sibling-convergence.integration.ts:95,127-143` already uses. There is no
hand-dial of the founder's strand address anywhere in the file: the strand mesh must form from
`resolveCohortSeed`'s strand-addr RPC (`cadre-node.ts:4352-4370`), whose targets are cadre siblings
with an open control connection — which the newcomer has, from `applySeed`.

**The strand is open (`Type: 'o'`) and `addStrand` is called without `founder: true`**, matching
every open-strand scenario in the suite. `founder: true` seats the closed-strand membership
bootstrap rows and is not wanted here.

**Both machines get a `captureRawStorage()` of their own** (`harness/block-store-probe.ts`) so the
physical claim can be read off raw stores. These are `MemoryRawStorage`, which
`wrapStorageWithCache` returns **unwrapped** (`quereus-plugin-sereus/src/cached-storage.ts`), so no
read cache sits between the assertion and the store — the durability claim in Phase 4 is clean.

**The cold restart in Phase 4b is a supported path, not a gamble.** `composeStrand` hydrates the
Quereus catalog from the persisted optimystic vtab schemas *before* applying the schema
(`compose-strand.ts:274-320`), so a warm restart re-emits no DDL. `captureRawStorage` memoizes per
scope, so the restarted node is handed the same store — the same trick
`control-offline-read-after-restart.integration.ts:138` uses.

## The one harness change

`controlNodeConfig` (`harness/node-fixtures.ts:121`) builds `storage.provider` itself and gives a
caller no way to supply one, which is why `strand-membership-closed-strand-e2e.integration.ts:190`
carries a private copy. Add an option rather than writing a fifth copy:

- `ControlNodeOpts.storageProvider?: RawStorageProvider` (the type is exported from
  `@serfab/cadre-core`, `types.ts:139`). When set it becomes `storage.provider` verbatim.
- Throw from `controlNodeConfig` when both `storageProvider` and `storageOpDelayMs` are given —
  they are two ways to answer the same question, and silently picking one would be a trap.
- Every existing caller is unaffected: the option is absent and the default
  `() => new MemoryRawStorage()` stands.

This is deliberately the seam `harness-one-node-config-builder` needs in order to absorb the
closed-strand copy; a note has been appended to that ticket.

## The scenario file

`packages/integration-tests/src/scenarios/strand-late-cadre-join.integration.ts`, two tests sharing
one local bring-up function (the `bringUpClosedStrand` shape from
`strand-membership-closed-strand-e2e.integration.ts:500-600`). Keep the bring-up local to the file
rather than hoisting it into `harness/`: `harness-topology-builder` is the ticket that will
generalize bring-ups, and adding a bespoke harness module immediately before it would only give that
ticket more to collapse.

Schema: the one-table sApp already used by two scenarios —
`table Data (Key text primary key, Val text)` — via `createSignedSAppConfig`. Strand tables are
namespaced `App.` (`insert into App.Data (Key, Val) values (?, ?)`).

Watcher cadence `STRAND_WATCH_MS = 1_000` on both nodes (`ControlNodeOpts.strandWatchMs`), with
every quiet window below derived from it so a cadence change cannot make an assertion vacuous.

### Test 1 — the strand follows the newcomer

**Phase 0 — the founder, alone.** Start the founder (`profile: 'storage'`, its own capture),
`makeOwnOwner`, then poll until its own `CadrePeer` row carries addresses (`control-trio.ts` step 1)
— that row is what the newcomer's seed and RPC target selection stand on. `addStrand`,
`publishStrand`, then five `insert into App.Data` writes. Assert the founder's control node holds
**zero** connections at the end of this phase, so "written while alone" is a measured fact rather
than a narration.

Snapshot `preJoinIndex = await readBlockIndex(founderCapture.forStrand(strandId))` here. This is the
set of blocks written before the newcomer existed — including the named collection-header blocks,
which are written exactly once at collection creation and whose revision never moves again. Assert
`preJoinIndex.size` is at least a modest floor and **log the real number**. The closed-strand
anti-vacuity floor at `:1101-1104` is the precedent: measure, then pin conservatively below what you
measured. Do not guess the constant into the file.

**Phase 1 — enrollment.** Derive the newcomer's peer id from its key before constructing the node;
`founder.authorizePeer(newcomerPeerId)`; construct the newcomer (`profile: 'transaction'`, its own
capture, `pinnedOwnerKeys: [ownerPublicKey]`); attach the strand-event collector **before**
`start()`; start; `createSeed` / `applySeed`; poll `hasOutboundTo(newcomer, founderPeerId)`;
converge and assert membership both ways (`waitForCadrePeerConverged`, then `isMember` /
`isAuthorizedMember`).

**Phase 2 — discovery and join, through the product's own path.** Wait for the newcomer's
`strand:discovered` to name the strand; assert the delivered row equals
`{ Id: strandId, MemberPrivateKey: null, Type: 'o' }`; `addStrand` with that row; assert the instance
is `active`. Then poll for the strand mesh in **both** directions (the newcomer's strand libp2p
connected to the founder's strand peer id, and the reverse). Assert the founder's strand peer id
differs from its control peer id, so the mesh assertion cannot pass vacuously on the already-open
control connection (`strand-addr-seed-convergence.integration.ts:152`).

**Phase 3 — the physical claim. Nothing in this phase may read the newcomer's strand database.**
A read issued through the node under test can itself pull blocks into that node's store and mask the
gap — the rule stated in `harness/block-store-probe.ts`. Poll
`compareBlockCoverage(founderStore, newcomerStore)` until `blockCoverageIsComplete`, re-reading both
stores inside each iteration and carrying the last gap into the failure message
(`formatBlockCoverageGap`). Then assert every id in `preJoinIndex` is present in the newcomer's index
and log that id list — the "written before you existed" set named directly, without hardcoding any
header block id string.

This is what distinguishes the scenario from read-through: a row fetched on demand over the network
would satisfy a `select` on the newcomer and would not satisfy this.

**Phase 4 — durability, in two steps.**

- **4a, founder down, instance still up.** Stop the founder; poll until the newcomer's strand libp2p
  reports zero connections; read all five rows from the newcomer's strand database. Same shape as the
  closed-strand offline-durability tests.
- **4b, cold restart.** Stop the newcomer; construct a fresh `CadreNode` on the **same** capture and
  the **same** private key; start; assert zero control connections; assert `queryStrands()` on the
  restarted node still names the strand (the control-plane half of the claim, and evidence the
  production discovery path would work here too); `addStrand` with the locally-held row; assert zero
  strand-network connections at read time; read all five rows again.

Suggested test timeout 180_000.

### Test 2 — a cadre machine that never runs the strand holds none of its blocks

Same bring-up through Phase 1, then the newcomer **never** calls `addStrand`. Wait for its
`strand:discovered` (so it demonstrably saw the strand and declined), hold a quiet window of five
watcher polls, then assert:

- `newcomerCapture.scopes()` does not contain the strand id (log the scopes seen),
- `newcomerCapture.forStrand(strandId)` throws `BlockStoreProbeError`,
- `newcomer.getStrands().size === 0`,
- and — the anti-vacuity guard — the founder's own strand store is non-empty, so the absence on the
  newcomer means something.

This is what makes Test 1's positive claim meaningful: joining the cadre is not what delivers a
strand; running it is. Suggested timeout 120_000.

## Edge cases & interactions

- **Push or pull?** `peer-join-backfill.ts` is a **push** from the block holder to the newly
  connected peer, armed on both sides of a strand (`strand-instance-manager.ts:477-502`, gate-free
  for strand networks by design) and on the control network with a membership gate
  (`cadre-node.ts:1240-1256`). If the newcomer were instead pulling on read, Phase 3's raw-store gate
  is exactly what tells the two apart — Phase 4b's zero-connection read is the second witness.
- **Collection headers.** Every block the founder wrote while alone has a cohort of one, and
  collection headers are written once at creation and never advance. `preJoinIndex` is that set;
  covering it is the whole point of Phase 3's second assertion.
- **Ordering is the subject, so guard it.** The zero-connection assertion at the end of Phase 0, and
  the fact that the newcomer is constructed only after the founder's writes, are both load-bearing. A
  future edit that moves the newcomer's construction earlier turns this file back into a duplicate of
  `strand-addr-seed-convergence`.
- **No test-side strand dial.** Every other multi-node strand scenario hand-dials the founder's
  strand address. This one must not. `resolveCohortSeed` only RPCs siblings it holds an open control
  connection to, and a per-peer failure folds to a silent `[]` rather than throwing, so a broken seed
  path shows up as a Phase 2 mesh timeout. If that timeout fires, check the direct RPC first the way
  `strand-addr-seed-convergence.integration.ts:161-168` does, before blaming discovery.
- **Backfill memoizes a peer after one clean run** (`peer-join-backfill.ts:308`), so the copy this
  scenario observes happens once, roughly one debounce second after the strand connection opens, and
  is not retried while the connection stays up. Blocks the founder writes *after* that run travel by
  ordinary replication, not backfill — that is `scenario-strand-writes-straddle-a-late-join`, the
  companion ticket, not this one.
- **A newcomer whose `addStrand` fails still holds the sApp config.** `addStrand` registers the
  config before launching and deliberately leaves it registered on rejection
  (`cadre-node.ts:3941-3966`), so the watcher keeps retrying the launch in the background. If Phase 2
  ever fails, expect repeated `strand:error` events afterwards; collect them and report the count
  rather than reading only the first.
- **`bug-strand-join-dies-on-missing-block` is live and adjacent.** A joining peer's strand setup
  fails roughly one attempt in nine with `Missing block` while creating tables. Expect to meet it —
  most likely at the newcomer's Phase 2 `addStrand`, less likely at Phase 4b where `hydrate` should
  re-emit no DDL. If it reproduces, that is evidence for that ticket: record it there, do not
  re-diagnose it here, and **do not weaken this scenario's assertions to get a green run.**
- **Pre-existing failures.** `tickets/.pre-existing-known.md` currently tracks
  `control-write-degraded-cohort-member`, `control-cohort-edge-carries-data`, and
  `strand-membership-closed-strand-e2e`'s manager test. If one of those is what fails, say so in the
  handoff and move on.

## Out of scope

Relayed reachability (`strand-network-nat-relay-reachability`). Multi-machine cadres on both sides of
a cross-party strand (`scenario-two-multi-machine-cadres-share-one-strand`). Closed strands and
`MemberPrivateKey` delivery. Hoisting `collectStrandEvents` out of
`strand-unpublish-sibling-convergence.integration.ts` — copy the few lines you need locally and leave
the hoist to `harness-topology-builder`.

## TODO

- Add `storageProvider?: RawStorageProvider` to `ControlNodeOpts` and wire it into
  `controlNodeConfig`, throwing when it is combined with `storageOpDelayMs`. Document the option in
  the same style as its neighbours.
- Create `packages/integration-tests/src/scenarios/strand-late-cadre-join.integration.ts` with a file
  header stating the ordering property, the no-hand-dial rule, and the rule that Phase 3 must never
  read the newcomer's strand database.
- Write the local bring-up covering Phase 0 and Phase 1, returning both nodes, both captures, both
  strand stores, the strand id, the sApp config, and the newcomer's event collector.
- Write Test 1 (Phases 2-4) and Test 2 as described above.
- Measure the founder's pre-join strand block count, log it, and pin the anti-vacuity floor below the
  measured value.
- `yarn workspace @serfab/integration-tests typecheck` and `yarn lint`.
- Run the new file in the foreground with no redirection:
  `yarn workspace @serfab/integration-tests test src/scenarios/strand-late-cadre-join.integration.ts`
  Run it several times — a single green run of a backfill scenario proves little (the note at
  `control-offline-read-after-restart.integration.ts:30-32`). Record the pass/fail tally.
- Run the neighbouring strand scenarios once to confirm the `node-fixtures.ts` change broke nothing:
  `strand-addr-seed-convergence`, `strand-unpublish-sibling-convergence`, `websocket-chat`.
- Hand off to `review/` naming: the measured floor, the run tally, whether `Missing block` was
  observed and where, and any assertion you could not make stand.
