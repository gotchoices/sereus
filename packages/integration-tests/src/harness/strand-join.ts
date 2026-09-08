/**
 * Run one strand across a subset of a topology's machines ({@link joinStrandOn}) —
 * the strand-plane half of the topology builder, whose control plane is
 * `topology.ts`. Split off so each file owns one plane: `bootTopology` never
 * touches strands, and nothing here starts or stops a `CadreNode`.
 *
 * TIME BUDGET: every strand member runs a SECOND libp2p node, so count each one as
 * another machine against `topology.ts`'s ~10-15 s per machine rule of thumb.
 */

import { DEFAULT_STRAND_CLUSTER_SIZE } from '@serfab/cadre-core';
import type { CadreNode, SAppConfig, StrandInstance, StrandRow } from '@serfab/cadre-core';
import type { TopologyMachine } from './topology.js';
import { waitForCohortOn } from './control-cohort.js';
import { waitUntil } from './wait-utils.js';

/** The strand libp2p node type, as `StrandInstance` declares it. Exported because it
 *  appears in {@link connectStrandNodes}'s exported signature (declaration emit needs
 *  the name), not as an invitation to build strand nodes outside `addStrand`. */
export type StrandLibp2p = NonNullable<StrandInstance['libp2pNode']>;

/** Default budget for {@link joinStrandOn}'s mesh dials and strand cohort barrier. */
const STRAND_JOIN_TIMEOUT_MS = 30_000;

export interface StrandJoinSpec {
	strandId: string;
	sAppConfig: SAppConfig;
	/** Strand row Type. Default 'o'. A closed strand ('c') also needs
	 *  {@link memberPrivateKey} — the row carries the party's membership secret, and
	 *  the founder derives its Member/Manager keypair from it. */
	type?: 'o' | 'c';
	/** The shared `StrandRow.MemberPrivateKey` (mint one with
	 *  `generateStrandMemberKey`). REQUIRED for `type: 'c'` and rejected for open
	 *  strands, which carry `null` — a closed row without it founds a strand nobody,
	 *  the founder included, can ever hold membership in. Also forwarded to
	 *  `publishStrand` under {@link publish}, so a discovering same-party machine reads
	 *  the same key off the published row. */
	memberPrivateKey?: string;
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
 * The member's strand libp2p node, or a named throw. `StrandInstance.libp2pNode` is
 * optional (absent unless the instance is active/idle), and a bare `!` here would
 * surface a launch regression as `Cannot read properties of undefined` from inside a
 * dial loop instead of naming the machine.
 */
function strandNodeOf(instance: StrandInstance, strandId: string, label: string): StrandLibp2p {
	if (!instance.libp2pNode) {
		throw new Error(
			`joinStrandOn: strand '${strandId}' on ${label} reports status '${instance.status}' `
			+ 'but exposes no libp2p node — nothing can be wired to it');
	}
	return instance.libp2pNode;
}

/**
 * Publish `members[0]`'s owner-signed `Strand` row, carrying the closed-strand
 * membership key when there is one, so a same-party machine that discovers the row can
 * launch the SAME strand identity rather than a keyless copy of it.
 */
async function publishFounderRow(founder: TopologyMachine, row: StrandRow): Promise<void> {
	try {
		await founder.node.publishStrand(row.Id, row.Type, row.MemberPrivateKey ?? undefined);
	} catch (error) {
		throw new Error(
			`joinStrandOn: publishStrand('${row.Id}') failed on ${machineLabel(founder)}: ${String(error)}`,
			{ cause: error });
	}
}

/**
 * Establish a DIRECT strand connection from `dialer` to `target` and wait until BOTH
 * sides report it, scoped to this specific peer pair — `connectControlNodes`'s recipe
 * on the strand plane. Exported so a scenario that brings a machine BACK (a restarted
 * `CadreNode` outside any `joinStrandOn` call) can re-dial the live members with the
 * same both-sides-settled contract the mesh step uses.
 */
export async function connectStrandNodes(
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
	// NOTE: duplicates are detected by NODE identity, not by (party, index), so two
	// distinct TopologyMachine objects wrapping the same node would slip past. Nothing
	// reachable does that today — `bootTopology` hands out one object per machine — but
	// key on `${party}[${index}]` if a scenario ever synthesizes machine handles.
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
	const type = spec.type ?? 'o';
	if (type === 'c' && !spec.memberPrivateKey) {
		throw new Error(
			`joinStrandOn: closed strand '${spec.strandId}' (type 'c') needs a memberPrivateKey — `
			+ 'mint one with generateStrandMemberKey and share it across the members; without it '
			+ 'the founder can derive no membership key and no member can ever be admitted');
	}
	if (type === 'o' && spec.memberPrivateKey) {
		throw new Error(
			`joinStrandOn: strand '${spec.strandId}' passes a memberPrivateKey with type 'o' — `
			+ "membership keys belong to closed strands; pass type: 'c' or drop the key");
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
 * a topology node, and `Topology.stop` (in the caller's `finally`) stops strand
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
	const strandRow: StrandRow = {
		Id: spec.strandId,
		MemberPrivateKey: spec.memberPrivateKey ?? null,
		Type: spec.type ?? 'o',
	};

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
			await publishFounderRow(members[0]!, strandRow);
		}
	}

	if (mesh === 'full') {
		for (let i = 0; i < members.length; i++) {
			for (let j = i + 1; j < members.length; j++) {
				const dialerLabel = machineLabel(members[j]!);
				const targetLabel = machineLabel(members[i]!);
				await connectStrandNodes(
					strandNodeOf(instances[j]!, spec.strandId, dialerLabel), dialerLabel,
					strandNodeOf(instances[i]!, spec.strandId, targetLabel), targetLabel,
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
			const label = machineLabel(members[i]!);
			await waitForCohortOn(strandNodeOf(instances[i]!, spec.strandId, label), want, {
				timeoutMs,
				label: `strand '${spec.strandId}' on ${label}`,
			});
		}
	}

	return instances;
}
