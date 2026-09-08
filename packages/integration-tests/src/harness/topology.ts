/**
 * General topology builder: N parties × M machines of REAL `CadreNode`s, plus a
 * strand-join step ({@link joinStrandOn}).
 *
 * The harness's other two worlds each stop short of this: `TestCadreNetwork` /
 * `TestParty` scales but its drones are bare libp2p nodes that cannot run a strand
 * (and its star wiring caps a drone's control cohort at two); the `CadreNode` pair
 * fixtures (`bootPair`, `bootConnectedPair`) and `bootControlTrio` are real but fixed
 * at two or three machines. This module composes the same seams those fixtures use —
 * `controlNodeConfig`, `makeOwnOwner`, `connectControlNodes`, `waitForCohortOn`,
 * `stopStartedNodes` — into an arbitrary-shape builder. The pair fixtures and the trio
 * stay as they are: their orderings are load-bearing for existing suites.
 *
 * TIME BUDGET (sizing rule of thumb for scenario authors). Bring-up cost is roughly
 * LINEAR in total machine count: each machine pays its own start (~1 s), the owner's
 * self-publish wait (~1 s, once per party), enrollment (~1-3 s per member), and the
 * ring warm-up behind each cohort barrier (sub-second to ~5 s per party observed).
 * Budget ~10-15 s per machine of hook/test timeout, and remember every strand member
 * in a {@link joinStrandOn} call runs a SECOND libp2p node — count it as another
 * machine. A 2-party × 2-machine topology with one 3-member strand fits comfortably
 * inside 240 s. Vitest's defaults (60 s test / 30 s hook) are NOT enough beyond the
 * smallest shapes; pass explicit timeouts per scenario — this module never touches
 * `vitest.config.ts`.
 *
 * NOTE: parties boot sequentially. Simple, and wall-clock is dominated by per-party
 * waits anyway; parallel party bring-up is a possible future speed-up if builder time
 * ever dominates a suite.
 */

import { generateKeyPair, privateKeyToProtobuf } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import type { PrivateKey } from '@libp2p/interface';
import { CadreNode, DEFAULT_STRAND_CLUSTER_SIZE } from '@serfab/cadre-core';
import type { RawStorageProvider, SAppConfig, StrandInstance, StrandRow } from '@serfab/cadre-core';
import {
	controlNodeConfig, makeOwnOwner, connectControlNodes, hasOutboundTo, stopStartedNodes
} from './node-fixtures.js';
import { signMessageEd25519 } from './test-network.js';
import { waitForCohortOn } from './control-cohort.js';
import { waitUntil } from './wait-utils.js';

/** The strand libp2p node type, as `StrandInstance` declares it. */
type StrandLibp2p = NonNullable<StrandInstance['libp2pNode']>;

/** Owner self-publish wait — same budget the trio and late-join fixtures use. */
const OWNER_SELF_PUBLISH_TIMEOUT_MS = 20_000;
/** Enrollment's settled-connection poll — the gate denies after upgrade (see below). */
const ENROLL_CONNECT_TIMEOUT_MS = 45_000;
/** Cohort barrier budget — `bootConnectedPair`'s 30 s, which covers ring warm-up 6×. */
const COHORT_BARRIER_TIMEOUT_MS = 30_000;
/** Default budget for {@link joinStrandOn}'s mesh dials and strand cohort barrier. */
const STRAND_JOIN_TIMEOUT_MS = 30_000;

/** Per-machine knobs the builder forwards into `controlNodeConfig`. Narrow on purpose:
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
 *  `bootPair` vs `bootConnectedPair` encodes for pairs, generalized to M machines. */
export type PartyGenesisOrdering = 'genesis-first' | 'genesis-after-cohort';

export interface TopologySpec {
	/** Salts every partyId (`${tag}-${party.name}-${Date.now()}`). */
	tag: string;
	parties: ReadonlyArray<TopologyPartySpec>;
	/** Default 'genesis-first' — the production seed-enrollment ordering. */
	genesis?: PartyGenesisOrdering;
	/** Intra-party control wiring beyond the enrollment link. Default 'full':
	 *  `connectControlNodes` over every unlinked machine pair, so every machine's
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
	/** The owner's derived owner PUBLIC key (base64url), as `makeOwnOwner` returns. */
	ownerPublicKey: string;
	/** Sign control-row authorization bytes with this party's owner key
	 *  (same shape as `ConnectedPair.ownerSign`). */
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
	/** `stopStartedNodes` over everything, newest first. Idempotent. */
	stop(): Promise<void>;
}

/**
 * Run `body`, re-throwing any failure tagged with the boot stage it came from —
 * the `bootControlTrio` pattern. Every straight-line call below touches the control
 * DB, so an untagged transactor error would reach the test naming no stage at all.
 */
async function atStage<T>(stage: string, body: () => Promise<T>): Promise<T> {
	try {
		return await body();
	} catch (error) {
		throw new Error(`bootTopology[${stage}]: ${String(error)}`, { cause: error });
	}
}

/** Named immediate throws for a malformed spec — never a timeout-shaped failure. */
function validateTopologySpec(spec: TopologySpec): void {
	if (spec.parties.length === 0) {
		throw new Error('bootTopology: spec.parties is empty — a topology needs at least one party');
	}
	const seen = new Set<string>();
	for (const party of spec.parties) {
		if (seen.has(party.name)) {
			throw new Error(`bootTopology: duplicate party name '${party.name}' — names must be unique within the spec`);
		}
		seen.add(party.name);
		if (party.machines.length === 0) {
			throw new Error(`bootTopology: party '${party.name}' has an empty machines list — every party needs at least one machine (the owner)`);
		}
	}
}

/** One machine's `CadreNodeConfig`, defaults resolved against the spec. */
function machineConfig(
	partyId: string,
	spec: TopologySpec,
	machine: TopologyMachineSpec,
	index: number,
	key: PrivateKey,
	pinnedOwnerKeys?: string[]
) {
	return controlNodeConfig({
		partyId,
		privateKey: key,
		profile: machine.profile ?? (index === 0 ? 'storage' : 'transaction'),
		...(machine.storageProvider ? { storageProvider: machine.storageProvider } : {}),
		...((machine.strandWatchMs ?? spec.strandWatchMs) !== undefined
			? { strandWatchMs: machine.strandWatchMs ?? spec.strandWatchMs } : {}),
		...(machine.enableRelay !== undefined ? { enableRelay: machine.enableRelay } : {}),
		...(machine.listenAddrs !== undefined ? { listenAddrs: machine.listenAddrs } : {}),
		...(machine.reconcileMs !== undefined ? { reconcileMs: machine.reconcileMs } : {}),
		...(pinnedOwnerKeys ? { pinnedOwnerKeys } : {}),
	});
}

/**
 * Owner genesis plus the self-published-row wait: `makeOwnOwner`, then poll until the
 * owner's own `CadrePeer` row carries addrs — seeds minted before that are useless
 * (the recipe `bootControlTrio` and `strand-late-cadre-join` both use).
 *
 * NOTE: `strand-late-cadre-join.integration.ts`'s `foundStrandAlone`/`enrollNewcomer`
 * remain a separate copy of this recipe ON PURPOSE: that suite interleaves raw-storage
 * captures, strand founding, event collectors attached before `start()`, and vitest
 * assertions between these exact steps — folding it onto the builder would either
 * contort its phase structure or grow this module callback hooks it doesn't need.
 */
async function ownerGenesis(owner: CadreNode, key: PrivateKey, label: string): Promise<string> {
	const ownerPublicKey = await atStage(`${label}: owner genesis`, () => makeOwnOwner(owner, key));
	const ownerPeerId = owner.peerId!.toString();
	await waitUntil(async () => {
		const rec = await owner.getControlDatabase()!.queryPeerRecord(ownerPeerId);
		return !!rec && rec.addrs.length > 0;
	}, {
		timeoutMs: OWNER_SELF_PUBLISH_TIMEOUT_MS, intervalMs: 250,
		description: `${label}: owner self-registers a CadrePeer row with addrs`,
	});
	return ownerPublicKey;
}

/**
 * Enroll one already-started member over the production membership path:
 * `createSeed` → `applySeed`, then poll for the SETTLED outbound connection — the
 * owner's gate denies after the dialer's upgrade completes, so the dial's return
 * value proves nothing. The vouch happened before the member started (see caller).
 */
async function enrollMember(
	owner: CadreNode, ownerPeerId: string, member: CadreNode, label: string
): Promise<void> {
	const seed = await atStage(`${label}: owner mints seed`, () => owner.createSeed());
	const applied = await atStage(`${label}: member applies seed`, () => member.applySeed(seed));
	if (!applied.success) {
		throw new Error(`bootTopology[${label}]: applySeed reported failure: ${JSON.stringify(applied)}`);
	}
	await waitUntil(() => hasOutboundTo(member, ownerPeerId), {
		timeoutMs: ENROLL_CONNECT_TIMEOUT_MS, intervalMs: 250,
		description: `${label}: member holds an outbound control connection to the owner`,
	});
}

/**
 * Wire the intra-party control links step 2's enrollment didn't already create
 * (member↔member pairs; every member↔owner link exists), then barrier.
 * Under 'star' the mesh step is skipped and the barrier waits on the OWNER only —
 * member cohorts are capped by construction, which is the point of asking for 'star'.
 */
async function meshAndBarrier(
	partyName: string, machines: TopologyMachine[], controlMesh: 'full' | 'star',
	alreadyLinked: (i: number, j: number) => boolean
): Promise<void> {
	if (controlMesh === 'full') {
		for (let i = 0; i < machines.length; i++) {
			for (let j = i + 1; j < machines.length; j++) {
				if (alreadyLinked(i, j)) continue;
				await atStage(
					`party ${partyName}: control mesh ${j} -> ${i}`,
					() => connectControlNodes(machines[j]!.node, machines[i]!.node));
			}
		}
	}
	const waitOn = controlMesh === 'full' ? machines : [machines[0]!];
	for (const machine of waitOn) {
		await waitForCohortOn(machine.node.getControlNode()!, machines.length, {
			timeoutMs: COHORT_BARRIER_TIMEOUT_MS,
			label: `party ${partyName} machine ${machine.index}`,
		});
	}
}

/**
 * Bring up one party under `'genesis-first'` — the production seed-enrollment
 * ordering, `foundStrandAlone` + `enrollNewcomer` generalized to M machines.
 */
async function bootPartyGenesisFirst(
	spec: TopologySpec, partySpec: TopologyPartySpec, controlMesh: 'full' | 'star',
	pushStarted: (node: CadreNode) => void
): Promise<TopologyParty> {
	const partyId = `${spec.tag}-${partySpec.name}-${Date.now()}`;
	const name = partySpec.name;
	const machines: TopologyMachine[] = [];

	// 1. Owner starts, becomes its own owner, and its self-published row gains addrs.
	const ownerKey = await generateKeyPair('Ed25519');
	const owner = new CadreNode(machineConfig(partyId, spec, partySpec.machines[0]!, 0, ownerKey));
	await atStage(`party ${name}: owner starts`, () => owner.start());
	pushStarted(owner);
	const ownerPeerId = owner.peerId!.toString();
	machines.push({ node: owner, key: ownerKey, peerId: ownerPeerId, party: name, index: 0 });
	const ownerPublicKey = await ownerGenesis(owner, ownerKey, `party ${name}`);

	// 2. Members, sequentially: vouch BEFORE start (so the owner's inbound gate admits
	//    the cold-start dial), pin the owner key, start, seed, settled connection.
	for (let k = 1; k < partySpec.machines.length; k++) {
		const label = `party ${name} machine ${k}`;
		const key = await generateKeyPair('Ed25519');
		const peerId = peerIdFromPrivateKey(key).toString();
		await atStage(`${label}: owner vouches member`, () => owner.authorizePeer(peerId));

		const member = new CadreNode(
			machineConfig(partyId, spec, partySpec.machines[k]!, k, key, [ownerPublicKey]));
		await atStage(`${label}: member starts`, () => member.start());
		pushStarted(member);
		machines.push({ node: member, key, peerId, party: name, index: k });

		await enrollMember(owner, ownerPeerId, member, label);
	}

	// 3+4. Mesh the pairs enrollment didn't link (every member already holds a link to
	//      the owner), then barrier every machine to M (owner only, under 'star').
	await meshAndBarrier(name, machines, controlMesh, (i, _j) => i === 0);

	const ownerPrivateKeyProtobuf = privateKeyToProtobuf(ownerKey);
	return {
		name, partyId, ownerPublicKey, machines,
		ownerSign: (message) => signMessageEd25519(message, ownerPrivateKeyProtobuf),
	};
}

/**
 * Bring up one party under `'genesis-after-cohort'` — `bootConnectedPair`
 * generalized: all M machines start with NO genesis, get wired by
 * `connectControlNodes` (the test stand-in dial — the seed path NEEDS genesis, the
 * same tradeoff `bootConnectedPair` already makes), barrier to M, and only THEN does
 * machine 0 become owner and vouch the members. Every row — genesis included — is
 * offered to a cohort that already spans the party. Members pin nothing: the owner
 * key does not exist when they start.
 */
async function bootPartyGenesisAfterCohort(
	spec: TopologySpec, partySpec: TopologyPartySpec, controlMesh: 'full' | 'star',
	pushStarted: (node: CadreNode) => void
): Promise<TopologyParty> {
	const partyId = `${spec.tag}-${partySpec.name}-${Date.now()}`;
	const name = partySpec.name;
	const machines: TopologyMachine[] = [];

	// 1. Everyone starts, ownerless. Dials below are admitted by the cold-start
	//    carve-out: no control rows exist yet, so the membership gate has no basis.
	for (let k = 0; k < partySpec.machines.length; k++) {
		const key = await generateKeyPair('Ed25519');
		const node = new CadreNode(machineConfig(partyId, spec, partySpec.machines[k]!, k, key));
		await atStage(`party ${name} machine ${k} starts`, () => node.start());
		pushStarted(node);
		machines.push({ node, key, peerId: node.peerId!.toString(), party: name, index: k });
	}

	// 2. Members dial the owner (the links enrollment would have made), then the full
	//    mesh adds member↔member — and the barrier confirms the cohort spans the party
	//    BEFORE any write exists.
	for (let k = 1; k < machines.length; k++) {
		await atStage(
			`party ${name}: control link ${k} -> owner`,
			() => connectControlNodes(machines[k]!.node, machines[0]!.node));
	}
	await meshAndBarrier(name, machines, controlMesh, (i, _j) => i === 0);

	// 3. Genesis and vouches land on the already-spanning cohort.
	const ownerKey = machines[0]!.key;
	const ownerPublicKey = await ownerGenesis(machines[0]!.node, ownerKey, `party ${name}`);
	for (let k = 1; k < machines.length; k++) {
		await atStage(
			`party ${name} machine ${k}: owner vouches member`,
			() => machines[0]!.node.authorizePeer(machines[k]!.peerId));
	}

	const ownerPrivateKeyProtobuf = privateKeyToProtobuf(ownerKey);
	return {
		name, partyId, ownerPublicKey, machines,
		ownerSign: (message) => signMessageEd25519(message, ownerPrivateKeyProtobuf),
	};
}

/**
 * Boot the whole topology. Parties are mutually independent — no cross-party control
 * wiring exists or is added (cross-party collaboration happens on STRANDS; see
 * {@link joinStrandOn}).
 *
 * Failure-path contract, at topology scale what `bootConnectedPair` promises for a
 * pair: every node is pushed onto an internal list (and `spec.started`, when given)
 * the moment it starts, and on ANY throw everything already started is stopped before
 * the error propagates. A throw hands back no handles; a return transfers shutdown to
 * the caller via {@link Topology.stop}.
 */
export async function bootTopology(spec: TopologySpec): Promise<Topology> {
	validateTopologySpec(spec);
	const genesis = spec.genesis ?? 'genesis-first';
	const controlMesh = spec.controlMesh ?? 'full';

	const started: CadreNode[] = [];
	const pushStarted = (node: CadreNode): void => {
		started.push(node);
		spec.started?.push(node);
	};

	const parties = new Map<string, TopologyParty>();
	try {
		for (const partySpec of spec.parties) {
			const party = genesis === 'genesis-first'
				? await bootPartyGenesisFirst(spec, partySpec, controlMesh, pushStarted)
				: await bootPartyGenesisAfterCohort(spec, partySpec, controlMesh, pushStarted);
			parties.set(party.name, party);
		}
	} catch (error) {
		await stopStartedNodes(started);
		throw error;
	}

	let stopped = false;
	return {
		parties,
		machine: (partyName, index = 0) => {
			const party = parties.get(partyName);
			if (!party) {
				throw new Error(
					`Topology.machine: unknown party '${partyName}' (have: ${[...parties.keys()].join(', ')})`);
			}
			const machine = party.machines[index];
			if (!machine) {
				throw new Error(
					`Topology.machine: party '${partyName}' has ${party.machines.length} machine(s); index ${index} is out of range`);
			}
			return machine;
		},
		nodes: () => [...started],
		stop: async () => {
			if (stopped) return;
			stopped = true;
			await stopStartedNodes(started);
		},
	};
}

// ═════════════════════════════════════════════════════════════════════════════
// Strand join
// ═════════════════════════════════════════════════════════════════════════════

export interface StrandJoinSpec {
	strandId: string;
	sAppConfig: SAppConfig;
	/** Strand row Type. Default 'o'. */
	type?: 'o' | 'c';
	/** The machines that run the strand, in join order. `members[0]` founds. Machines
	 *  NOT listed never see `addStrand` — the negative case is first-class. */
	members: ReadonlyArray<TopologyMachine>;
	/** Pass `founder: true` on `members[0]`'s `addStrand` (seats the closed-strand
	 *  membership bootstrap rows). Default false — open strands don't want it
	 *  (see the comment at strand-late-cadre-join's `foundStrandAlone`). */
	founder?: boolean;
	/** `publishStrand(strandId)` on `members[0]` after its `addStrand`, making the row
	 *  discoverable inside `members[0]`'s party. Requires `members[0]` to be its
	 *  party's owner (the insert is owner-signed). Default false — publication is a
	 *  separate claim and scenarios asserting discovery drive it themselves. */
	publish?: boolean;
	/** Strand libp2p wiring. 'full' (default): dial every member pair and wait until
	 *  BOTH sides report the connection (the generalization of the three-party mesh
	 *  block in strand-formation-e2e). 'none': leave wiring to the caller — required
	 *  so discovery-driven scenarios (strand-addr RPC seed, watcher joins) stay
	 *  expressible through the builder's parties. */
	mesh?: 'full' | 'none';
	/** Readiness barrier: every member's strand cohort reaches
	 *  `min(members.length, DEFAULT_STRAND_CLUSTER_SIZE)` via `waitForCohortOn` on the
	 *  strand libp2p node. Default true; forced false when mesh is 'none' (an unwired
	 *  strand can never satisfy it — the contradictory explicit combination throws). */
	barrier?: boolean;
	timeoutMs?: number;
}

/** `party[index]` — how every strand-join failure message names a machine. */
function machineLabel(machine: TopologyMachine): string {
	return `${machine.party}[${machine.index}]`;
}

/**
 * Establish a DIRECT strand connection from `dialer` to `target` and wait until BOTH
 * sides report it, scoped to this specific peer pair — `connectControlNodes`'s recipe
 * on the strand plane.
 */
async function connectStrandNodes(
	dialer: StrandLibp2p, dialerLabel: string,
	target: StrandLibp2p, targetLabel: string,
	timeoutMs: number
): Promise<void> {
	const targetAddrs = target.getMultiaddrs();
	if (targetAddrs.length === 0) {
		throw new Error(`joinStrandOn: ${targetLabel}'s strand node has no listen addresses to dial`);
	}
	const dialerPeerId = dialer.peerId.toString();
	const targetPeerId = target.peerId.toString();
	await dialer.dial(targetAddrs[0]!);
	await waitUntil(
		() => dialer.getConnections().some((c) => c.remotePeer.toString() === targetPeerId),
		{
			timeoutMs, intervalMs: 250,
			description: `${dialerLabel}'s strand node connects to ${targetLabel}'s strand node`,
		});
	await waitUntil(
		() => target.getConnections().some((c) => c.remotePeer.toString() === dialerPeerId),
		{
			timeoutMs, intervalMs: 250,
			description: `${targetLabel}'s strand node sees the inbound connection from ${dialerLabel}`,
		});
}

/** Named immediate throws for a contradictory or malformed join spec. */
function validateStrandJoinSpec(spec: StrandJoinSpec): void {
	if (spec.members.length === 0) {
		throw new Error(`joinStrandOn: strand '${spec.strandId}' has an empty members list — members[0] must found it`);
	}
	const seen = new Set<CadreNode>();
	for (const member of spec.members) {
		if (seen.has(member.node)) {
			throw new Error(
				`joinStrandOn: machine ${machineLabel(member)} is listed twice in strand '${spec.strandId}'s members`);
		}
		seen.add(member.node);
	}
	if (spec.mesh === 'none' && spec.barrier === true) {
		throw new Error(
			`joinStrandOn: strand '${spec.strandId}' asks for mesh 'none' AND barrier true — `
			+ 'an unwired strand can never satisfy a cohort barrier; drop one of the two');
	}
	if (spec.publish && spec.members[0]!.index !== 0) {
		throw new Error(
			`joinStrandOn: publish requires members[0] to be its party's owner (the Strand insert is `
			+ `owner-signed), but ${machineLabel(spec.members[0]!)} is machine ${spec.members[0]!.index} of party '${spec.members[0]!.party}'`);
	}
}

/**
 * Run one strand across a subset of a topology's machines: one shared `StrandRow`,
 * `addStrand` called EXPLICITLY on every member (deterministic, and cross-party-capable
 * — parties share no control network, so watcher discovery cannot cross parties;
 * explicit `addStrand` is how the three-party e2e already does it), optional full-mesh
 * strand wiring, and a cohort barrier at
 * `min(members.length, DEFAULT_STRAND_CLUSTER_SIZE)`.
 *
 * A FREE FUNCTION, not a `Topology` method, for composability: a scenario may call it
 * several times, on different member subsets, against one topology.
 *
 * TEARDOWN CONTRACT: a throw mid-join stops nothing itself. Every instance belongs to
 * a topology node, and {@link Topology.stop} (in the caller's `finally`) stops strand
 * instances with their nodes — there is no separate strand teardown to forget.
 *
 * @returns one `StrandInstance` per member, aligned with `spec.members`.
 */
export async function joinStrandOn(spec: StrandJoinSpec): Promise<StrandInstance[]> {
	validateStrandJoinSpec(spec);
	const mesh = spec.mesh ?? 'full';
	const barrier = mesh === 'none' ? false : (spec.barrier ?? true);
	const timeoutMs = spec.timeoutMs ?? STRAND_JOIN_TIMEOUT_MS;
	const members = spec.members;

	// One shared row: every member launches from the SAME strand identity.
	const strandRow: StrandRow = { Id: spec.strandId, MemberPrivateKey: null, Type: spec.type ?? 'o' };

	const instances: StrandInstance[] = [];
	for (let i = 0; i < members.length; i++) {
		const member = members[i]!;
		const label = machineLabel(member);
		let instance: StrandInstance;
		try {
			instance = await member.node.addStrand({
				strandRow,
				sAppConfig: spec.sAppConfig,
				...(i === 0 && spec.founder ? { founder: true } : {}),
			});
		} catch (error) {
			throw new Error(
				`joinStrandOn: addStrand('${spec.strandId}') failed on ${label}: ${String(error)}`,
				{ cause: error });
		}
		if (instance.status !== 'active') {
			throw new Error(
				`joinStrandOn: strand '${spec.strandId}' on ${label} came up '${instance.status}'`
				+ (instance.error ? ` (${instance.error})` : '') + ", expected 'active'");
		}
		instances.push(instance);
		if (i === 0 && spec.publish) {
			await members[0]!.node.publishStrand(spec.strandId, strandRow.Type);
		}
	}

	if (mesh === 'full') {
		for (let i = 0; i < members.length; i++) {
			for (let j = i + 1; j < members.length; j++) {
				await connectStrandNodes(
					instances[j]!.libp2pNode!, machineLabel(members[j]!),
					instances[i]!.libp2pNode!, machineLabel(members[i]!),
					timeoutMs);
			}
		}
	}

	if (barrier) {
		// Capped at the strand breadth: FRET offers a write to at most
		// DEFAULT_STRAND_CLUSTER_SIZE peers however many members exist, so waiting for
		// more would burn the timeout on a healthy strand.
		const want = Math.min(members.length, DEFAULT_STRAND_CLUSTER_SIZE);
		for (let i = 0; i < members.length; i++) {
			await waitForCohortOn(instances[i]!.libp2pNode!, want, {
				timeoutMs,
				label: `strand '${spec.strandId}' on ${machineLabel(members[i]!)}`,
			});
		}
	}

	return instances;
}
