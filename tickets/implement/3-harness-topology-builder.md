description: Build a test helper that can stand up any shape of network — several people, several machines each, some of them sharing a workspace — so the network sizes we actually ship finally have tests.
files: packages/integration-tests/src/harness/topology.ts, packages/integration-tests/src/harness/node-fixtures.ts, packages/integration-tests/src/harness/control-cohort.ts, packages/integration-tests/src/harness/index.ts, packages/integration-tests/src/scenarios/harness-topology.integration.ts, packages/integration-tests/src/scenarios/strand-late-cadre-join.integration.ts, packages/integration-tests/src/harness/control-trio.ts
difficulty: hard
----

# Topology builder: N parties × M machines of real `CadreNode`s, with a strand-join step

## Why (one paragraph)

The harness today is two disjoint worlds: `TestCadreNetwork`/`TestParty` scales but its drones
are bare libp2p nodes that cannot run a strand (and its star wiring caps a drone's control
cohort at two); the `CadreNode` fixtures are real but fixed at two (`bootPair`,
`bootConnectedPair`) or three (`bootControlTrio`). The largest strand any test reaches is three
machines, all from one-machine parties. This ticket adds the missing general builder. The
first consumer is the planned scenario `scenario-two-multi-machine-cadres-share-one-strand`
(two parties × two machines, one strand — sitting in `tickets/plan/`), so its needs are the
acceptance bar.

## Architecture

New harness module `packages/integration-tests/src/harness/topology.ts`, exported from
`harness/index.ts`. It composes existing seams — `controlNodeConfig`, `makeOwnOwner`,
`connectControlNodes`, `waitForControlConnection`, `readCohort`, `signMessageEd25519`,
`stopStartedNodes` — and invents no parallel ones. `TestParty`/`TestCadreNetwork` are NOT
modified; the two pair fixtures and `bootControlTrio` stay as-is (their orderings are
load-bearing for existing suites).

### Spec and handles

```ts
/** Per-machine knobs the builder forwards into controlNodeConfig. Narrow on purpose:
 *  partyId, privateKey, bootstrapNodes and pinnedOwnerKeys are the builder's to own. */
export interface TopologyMachineSpec {
	/** Default: machine 0 (the owner) 'storage', every other machine 'transaction'. */
	profile?: 'storage' | 'transaction';
	/** Per-machine raw-storage capture (block-store-probe scenarios). */
	storageProvider?: RawStorageProvider;
	strandWatchMs?: number;
	enableRelay?: boolean;
	listenAddrs?: string[];
	reconcileMs?: number;
}

export interface TopologyPartySpec {
	/** Names the party in partyIds, labels and lookups. Unique within the spec. */
	name: string;
	/** Machine 0 is the party owner. Length >= 1 — a party of one is the degenerate
	 *  (and most common) case. Parties may have different lengths: asymmetry is the
	 *  realistic shape, so the spec is a list, never a uniform (N, M) grid. */
	machines: ReadonlyArray<TopologyMachineSpec>;
}

/** Where owner genesis lands relative to the other machines — the same split
 *  bootPair vs bootConnectedPair encodes for pairs, generalized to M machines. */
export type PartyGenesisOrdering = 'genesis-first' | 'genesis-after-cohort';

export interface TopologySpec {
	/** Salts every partyId (`${tag}-${party.name}-${Date.now()}`). */
	tag: string;
	parties: ReadonlyArray<TopologyPartySpec>;
	/** Default 'genesis-first' — the production seed-enrollment ordering. */
	genesis?: PartyGenesisOrdering;
	/** Intra-party control wiring beyond the enrollment link. Default 'full':
	 *  connectControlNodes over every unlinked machine pair, so every machine's
	 *  cohort can reach M. 'star' reproduces owner-only wiring for scenarios that
	 *  deliberately want the capped shape. */
	controlMesh?: 'full' | 'star';
	/** Convenience: strandWatchMs applied to every machine that doesn't set its own. */
	strandWatchMs?: number;
	/** Filled with each node as it starts (the control-trio `handles` pattern), so a
	 *  caller can observe/stop partial state and the failure-path test can assert
	 *  teardown happened. Optional; the builder tears down on throw regardless. */
	started?: CadreNode[];
}

export interface TopologyMachine {
	node: CadreNode;
	key: PrivateKey;
	peerId: string;
	party: string;
	index: number;
}

export interface TopologyParty {
	name: string;
	partyId: string;
	/** The owner's derived owner PUBLIC key (base64url), as makeOwnOwner returns. */
	ownerPublicKey: string;
	/** Sign control-row authorization bytes with this party's owner key
	 *  (same shape as ConnectedPair.ownerSign). */
	ownerSign: (message: Uint8Array) => string;
	/** Index 0 is the owner. */
	machines: ReadonlyArray<TopologyMachine>;
}

export interface Topology {
	parties: ReadonlyMap<string, TopologyParty>;
	/** Lookup by party name + machine index (default 0, the owner). Throws a named
	 *  error on an unknown party or out-of-range index. */
	machine(party: string, index?: number): TopologyMachine;
	/** Every node in boot order. */
	nodes(): ReadonlyArray<CadreNode>;
	/** stopStartedNodes over everything, newest first. Idempotent. */
	stop(): Promise<void>;
}

export async function bootTopology(spec: TopologySpec): Promise<Topology>;
```

### Party bring-up, `genesis-first` (default — the production membership path)

Per party, the recipe already proven in `strand-late-cadre-join.integration.ts`
(`foundStrandAlone` + `enrollNewcomer`) and `control-trio.ts`, generalized to M:

1. Owner starts (`controlNodeConfig`, profile default `'storage'`), `makeOwnOwner`,
   `initializeSeedBootstrap` (inside makeOwnOwner), then wait for its self-published
   `CadrePeer` row to carry addrs (the `queryPeerRecord` poll both source files use —
   seeds minted before that are useless).
2. For each member machine k = 1..M-1, sequentially: generate its key, `authorizePeer`
   its peer id BEFORE it starts (vouch-before-start, as both sources do), start it with
   `pinnedOwnerKeys: [ownerPublicKey]`, `owner.createSeed()` → `member.applySeed(seed)`,
   throw a named error on `applied.success === false`, then poll `hasOutboundTo(member,
   ownerPeerId)` (the gate denies after upgrade — never trust the dial's return).
3. Control mesh: under `'full'`, loop `connectControlNodes` over every machine pair not
   already linked by step 2 (member↔member pairs; owner links exist). Under `'star'`, skip.
4. Readiness barrier: for EVERY machine of the party, wait until its control cohort
   holds >= M members (see the barrier helper below). Under `'star'` the barrier only
   waits on the owner — member cohorts are capped by construction, which is the point
   of asking for `'star'`.

Parties are mutually independent — no cross-party control wiring exists or is added.
Parties boot sequentially (simple, and time is dominated by per-party waits anyway; a
NOTE at the loop may mark parallel party bring-up as a future speed-up if builder time
ever dominates a suite).

### Party bring-up, `genesis-after-cohort`

Generalizes `bootConnectedPair`: all M machines start with no genesis, wired by
`connectControlNodes` full mesh (the seed path NEEDS genesis, so this ordering uses the
test stand-in dial — same tradeoff bootConnectedPair already makes), barrier to M on
every machine, THEN `makeOwnOwner` on machine 0 and `authorizePeer` for each member. This
keeps connect-then-write expressible above M=2, so the builder does not silently become
the only ordering (write-while-alone stays expressible as `genesis-first` with writes
issued before the caller wires anything further — and the pair fixtures remain for pair
scenarios).

### Failure-path teardown

`bootTopology` pushes every node onto an internal array (and `spec.started` when given)
the moment it starts, wraps the whole build in try/catch, and on ANY throw runs
`stopStartedNodes` before rethrowing — the `bootConnectedPair` contract at topology
scale. A throw hands back no handles; a return transfers shutdown to the caller via
`Topology.stop()`.

### Generic cohort barrier (change to `control-cohort.ts`)

`waitForControlCohort` takes a `TestParty`, so `CadreNode` topologies can't use it.
Extract its poll-with-carried-last-error core into:

```ts
/** Poll until `libp2p`'s cohort for the shared probe key holds >= minPeers members.
 *  Works for any node built by createLibp2pNode — control or strand. */
export async function waitForCohortOn(
	libp2p: Libp2p, minPeers: number, options?: WaitOptions & { label?: string }
): Promise<string[]>;
```

Validation: `minPeers` integer >= 1 throws immediately (same rule as today). The
party-count upper-bound check stays in the `TestParty` wrapper only — the generic
helper cannot know the network size, so an unsatisfiable ask burns its timeout there;
the builder itself always passes a satisfiable M. `waitForControlCohort` keeps its
signature and delegates, so no existing caller changes. The rich timeout message
(observed size, members, elapsed, carried last error) moves into the core.

The one-probe-key representativeness bound carries over unchanged: valid below
`CONTROL_REPLICATION_BREADTH` (16) on control networks and below the strand breadth (4)
on strands — both far above anything the builder waits for (strand barrier is capped at
the breadth, below).

### Strand-join step

A free function (composability — a scenario may call it several times, on different
member subsets, against one topology), not a `Topology` method:

```ts
export interface StrandJoinSpec {
	strandId: string;
	sAppConfig: SAppConfig;
	/** Strand row Type. Default 'o'. */
	type?: 'o' | 'c';
	/** The machines that run the strand, in join order. members[0] founds. Machines
	 *  NOT listed never see addStrand — the negative case is first-class. */
	members: ReadonlyArray<TopologyMachine>;
	/** Pass founder: true on members[0]'s addStrand (seats the closed-strand
	 *  membership bootstrap rows). Default false — open strands don't want it
	 *  (see the comment at strand-late-cadre-join's foundStrandAlone). */
	founder?: boolean;
	/** publishStrand(strandId) on members[0] after its addStrand, making the row
	 *  discoverable inside members[0]'s party. Requires members[0] to be its party's
	 *  owner (the insert is owner-signed). Default false — publication is a separate
	 *  claim and scenarios asserting discovery drive it themselves. */
	publish?: boolean;
	/** Strand libp2p wiring. 'full' (default): dial every member pair and wait until
	 *  BOTH sides report the connection (the generalization of the three-party mesh
	 *  block in strand-formation-e2e). 'none': leave wiring to the caller — required
	 *  so discovery-driven scenarios (strand-addr RPC seed, watcher joins) stay
	 *  expressible through the builder's parties. */
	mesh?: 'full' | 'none';
	/** Readiness barrier: every member's strand cohort reaches
	 *  min(members.length, DEFAULT_STRAND_CLUSTER_SIZE) via waitForCohortOn on the
	 *  strand libp2p node. Default true; forced false when mesh is 'none' (an unwired
	 *  strand can never satisfy it — throw on the contradictory combination rather
	 *  than hanging). */
	barrier?: boolean;
	timeoutMs?: number;
}

/** One StrandInstance per member, aligned with spec.members. */
export async function joinStrandOn(spec: StrandJoinSpec): Promise<StrandInstance[]>;
```

Every member calls `addStrand` explicitly with one shared `StrandRow`
(`{ Id, MemberPrivateKey: null, Type }`) — deterministic, cross-party-capable (parties
share no control network, so watcher discovery cannot cross parties; explicit addStrand
is how the three-party e2e already does it). Import `DEFAULT_STRAND_CLUSTER_SIZE` from
`@serfab/quereus-plugin-sereus`'s `cluster-size.ts` (exported) for the barrier cap — the
suite must not restate the constant. A throw mid-join stops nothing itself: every
instance belongs to a topology node, and `Topology.stop()` (in the caller's `finally`)
stops strand instances with their nodes — document this contract on the function.

### Time budget

Ring warm-up is the wall (sub-second to ~5 s per party observed; the 3×3 `TestParty`
precedent needs a 180 s hook against the 30 s default `hookTimeout`). The builder does
not touch `vitest.config.ts` — each scenario passes an explicit per-hook/per-test
timeout. The module header must state a sizing rule of thumb (roughly linear in machine
count; every strand member is a SECOND libp2p node) so the next scenario author budgets
instead of rediscovering. The self-test's own timeouts are explicit and generous.

## Edge cases & interactions

- **Party of one** must work and match what `bootPair`'s A-side produces: own owner,
  storage profile, seed bootstrap initialized, zero members enrolled — most scenarios
  use exactly this.
- **Asymmetric parties** (3 machines + 1 machine) — the spec is per-party lists; the
  self-test must include a non-uniform shape.
- **A machine left out of the strand** must never receive `addStrand` and must end the
  scenario with no strand-scoped storage (assert via `captureRawStorage().scopes()` as
  the late-join "decline" test does).
- **Failure at machine k**: every already-started node must be stopped before the error
  propagates. The self-test forces this deterministically (an invalid `listenAddrs`
  entry on machine k makes `start()` throw) and asserts through `spec.started` that
  each node was stopped.
- **`applySeed` reporting `success: false`** is a throw with the JSON payload in the
  message (the existing fixtures' rule), not a silent continue.
- **Duplicate party names / empty machine lists / empty parties list**: named
  immediate throws — never a timeout-shaped failure.
- **`mesh: 'none'` + `barrier: true`** is contradictory: throw immediately, naming why.
- **`publish: true` with a non-owner `members[0]`**: throw immediately — the insert
  would fail deep in the schema constraint with an unhelpful message otherwise.
- **Both orderings**: self-test exercises `genesis-after-cohort` at M=3 at least once
  (write lands after a 3-cohort formed), so the ordering isn't dead code.
- **`forceFullCohort` interaction**: the builder never uses forced cohorts (real
  barrier instead) — live strand traffic forbids the prototype patch. Nothing to code;
  keep it out.
- **No cross-party control links**: assert in the self-test that a machine in party A
  holds no control connection to any machine of party B (the strand mesh is a separate
  libp2p node with a different peer id — the late-join suite's "strand peer id differs
  from control peer id" check is the pattern).

## TODO

Phase 1 — barrier

- Extract `waitForCohortOn(libp2p, minPeers, options)` in `control-cohort.ts` from
  `waitForControlCohort`'s core (carried-last-error poll, rich timeout message);
  re-point `waitForControlCohort` at it, keeping the party-cap validation in the wrapper.
- Type-check + run `control-cohort-harness-helpers.integration.ts` and
  `harness-party-control-cohort.integration.ts` to prove the wrapper unchanged.

Phase 2 — builder

- `topology.ts`: spec/handle types, spec validation (named throws listed above).
- Party bring-up `genesis-first` (owner genesis → self-registered row poll →
  vouch-before-start → createSeed/applySeed → outbound-connection poll per member),
  then control mesh, then per-machine barrier.
- Party bring-up `genesis-after-cohort` (start all → connectControlNodes mesh →
  barrier → genesis + vouches).
- Failure-path teardown via internal started list + `stopStartedNodes`; `spec.started`
  mirror; `Topology.stop()` idempotent.
- Consider extracting the shared owner-genesis + self-registered-row-poll and the
  per-member enrollment steps as small internal functions; if they can also serve
  `strand-late-cadre-join.integration.ts`'s `foundStrandAlone`/`enrollNewcomer` without
  contorting either side, fold that suite onto them (it is the third copy of the
  recipe — `control-trio.ts` is the second but its checkpoint ordering is its subject,
  leave it alone). If folding fights the suite's phase structure, leave a `NOTE:` at
  the duplication instead — do not force it.
- Export from `harness/index.ts`.

Phase 3 — strand join

- `joinStrandOn`: shared row, founder flag on members[0], optional publish (owner
  check), full-mesh dial with both-sides waits, barrier at
  `min(members, DEFAULT_STRAND_CLUSTER_SIZE)` via `waitForCohortOn` on strand nodes.

Phase 4 — self-test `harness-topology.integration.ts`

- Degenerate: 1 party × 1 machine; owner-genesis surface intact (can write a control
  row, mint a seed).
- 1 party × 3 machines, `genesis-first`: all three machines report a 3-cohort (the
  shape `TestParty` drones can never reach); membership asserted both ways
  (`isMember`/`isAuthorizedMember`) for each member.
- 1 party × 3 machines, `genesis-after-cohort`: genesis row written after the 3-cohort
  formed is readable on a member.
- 2 parties (2 + 2 machines), strand across 3 of the 4: write on members[0] readable on
  both other members; the left-out machine has no strand-scoped storage scope; no
  cross-party control connections. Explicit generous timeout (start at 240 s; record
  the measured wall-clock in a comment).
- Failure-path: machine 2 of a 3-machine party gets an unroutable/invalid listen addr;
  `bootTopology` rejects; every node pushed into `spec.started` is stopped.
- Full suite: `yarn workspace @sereus/integration-tests test` (check the actual
  workspace name in its package.json) in foreground; type check via `yarn typecheck`;
  `yarn lint`.
