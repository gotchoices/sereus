/**
 * machines.ts — what Settings → "Devices and nodes" (`machines-section.tsx`) shows from
 * `CadreNode.listMachines`, `listCadreInvitations` and the app's rental records, and how a machine
 * is named in a prompt or an alert. No React and no native imports.
 */

import type { CadreInviteStatus, CadreMachine } from '@serfab/cadre-core';
import type { Rental } from '@serfab/cadre-rn/provider';
import { ownerFingerprint } from './node-claim';

/** A peer id short enough for one line: its first 12 and last 6 characters. */
export function shortPeerId(peerId: string): string {
	return `${peerId.slice(0, 12)}…${peerId.slice(-6)}`;
}

/** The fingerprint of the machine's identity key, in cadre-host's form, else the shortened peer id. */
export function machineCode(machine: CadreMachine): string {
	return machine.publicKey !== null ? ownerFingerprint(machine.publicKey) : shortPeerId(machine.peerId);
}

/** "The always-on node 1a2b3c4d", for an alert. */
export function machineName(machine: CadreMachine): string {
	return `The ${machineKind(machine).toLowerCase()} ${machineCode(machine)}`;
}

/**
 * "Rented from Acme Cadre Nodes" for a machine whose peer id one of this app's rental records
 * names, else null. The record is this phone's own, so the fact shows only on the phone that rented the node.
 */
export function rentedFromText(machine: CadreMachine, rentals: readonly Rental[]): string | null {
	const rental = rentals.find((entry) => entry.peerId === machine.peerId);
	return rental ? `Rented from ${rental.providerName}` : null;
}

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
	const members = new Set(machines.map((machine) => machine.peerId));
	return statuses.filter((status) => status.live && status.invite.peerId !== null && !members.has(status.invite.peerId));
}
