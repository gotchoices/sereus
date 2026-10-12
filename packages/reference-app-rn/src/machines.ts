/**
 * machines.ts — what Settings → "Devices and nodes" (`machines-section.tsx`) shows from
 * `CadreNode.listMachines`, `listCadreInvitations` and `planMachineRemoval`. No React and no
 * native imports, so `test/machines.spec.ts` runs these in Node.
 */

import type { CadreInviteStatus, CadreMachine, MachineRemovalPlan, RemoveMachineOptions } from '@serfab/cadre-core';

/** What a listed machine is, from the node profile it published; `Machine` until it publishes one. */
export function machineKind(machine: CadreMachine): string {
	switch (machine.profile) {
		case 'transaction':
			return 'App';
		case 'storage':
			return 'Always-on node';
		default:
			return 'Machine';
	}
}

/**
 * "just now", "3 minutes ago", "2 hours ago", "4 days ago"; "never" when the machine has not
 * published a record this node can verify. A time ahead of this phone's clock (the stamp is the
 * other machine's clock) reads as just now.
 */
export function lastSeenText(atMs: number | null, nowMs: number): string {
	if (atMs === null) return 'never';
	const minutes = Math.floor((nowMs - atMs) / 60_000);
	if (minutes < 1) return 'just now';
	if (minutes < 60) return plural(minutes, 'minute');
	const hours = Math.floor(minutes / 60);
	if (hours < 48) return plural(hours, 'hour');
	return plural(Math.floor(hours / 24), 'day');
}

function plural(count: number, unit: string): string {
	return `${count} ${unit}${count === 1 ? '' : 's'} ago`;
}

/**
 * Invitations targeted at a device that has not joined yet, listed as "Invited, not joined yet":
 * live, naming a peer id, and that peer not already a member. Open invitations are listed under
 * Add a device or app instead.
 *
 * NOTE: a live invitation targeted at a machine already in the cadre (a multi-use one, or one made
 * before the machine joined another way) is listed nowhere; removing that machine withdraws it. If
 * such invitations turn up, list them on the machine's row.
 */
export function pendingDeviceInvitations(statuses: readonly CadreInviteStatus[], machines: readonly CadreMachine[]): CadreInviteStatus[] {
	const members = new Set(machines.filter((machine) => machine.isMember).map((machine) => machine.peerId));
	return statuses.filter((status) => status.live && status.invite.peerId !== null && !members.has(status.invite.peerId));
}

/**
 * One "Keep" switch in the removal prompt: a machine or owner key the removed machine added. A
 * device added as an owner is one dependent with both its peer row and its owner key, so one
 * switch keeps or drops it whole.
 */
export interface Dependent {
	/** Unique within the prompt: the peer id, else the owner key. */
	id: string;
	/** A dependent `CadrePeer` row's peer id. */
	peerId: string | null;
	/** A dependent `OwnerKey` row's key. */
	ownerKey: string | null;
	/** The listed machine it is, when one is listed. */
	machine: CadreMachine | null;
}

/** The plan's dependents as switches: each owner key joined to the dependent peer row behind it, when there is one. */
export function dependentsOf(plan: MachineRemovalPlan, machines: readonly CadreMachine[]): Dependent[] {
	const byPeerId = new Map(machines.map((machine) => [machine.peerId, machine]));
	const byKey = new Map(machines.filter((machine) => machine.publicKey !== null).map((machine) => [machine.publicKey, machine]));
	const dependents = plan.dependents.peers.map((peerId): Dependent => ({ id: peerId, peerId, ownerKey: null, machine: byPeerId.get(peerId) ?? null }));
	for (const ownerKey of plan.dependents.owners) {
		const machine = byKey.get(ownerKey) ?? null;
		const sameMachine = machine && dependents.find((dependent) => dependent.peerId === machine.peerId);
		if (sameMachine) sameMachine.ownerKey = ownerKey;
		else dependents.push({ id: ownerKey, peerId: null, ownerKey, machine });
	}
	return dependents;
}

/** The re-vouch `removeMachine` takes for the dependents whose switch is on. */
export function revouchFor(dependents: readonly Dependent[], kept: ReadonlySet<string>): NonNullable<RemoveMachineOptions['revouch']> {
	const chosen = dependents.filter((dependent) => kept.has(dependent.id));
	return {
		owners: chosen.flatMap((dependent) => dependent.ownerKey ?? []),
		peers: chosen.flatMap((dependent) => dependent.peerId ?? []),
	};
}
