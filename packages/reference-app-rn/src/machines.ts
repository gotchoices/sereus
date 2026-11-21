/**
 * machines.ts — what Settings → "Devices and nodes" (`machines-section.tsx`) shows from
 * `CadreNode.listMachines`, `listCadreInvitations`, `listPendingPartyKeyRotations` and the app's
 * rental records, and how a machine is named in a prompt or an alert. No React and no native imports.
 */

import type { CadreInviteStatus, CadreMachine, PendingPartyKeyRotation } from '@serfab/cadre-core';
import type { Rental } from '@serfab/cadre-rn/provider';
import { ownerFingerprint } from './node-claim';

/** The block of waiting key replacements, which the removal prompt also points to by this name. */
export const WAITING_ROTATIONS_TITLE = 'Key replacements waiting';

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
	return `The ${machineNoun(machine)}`;
}

/** "always-on node 1a2b3c4d": {@link machineName} for the middle of a sentence. */
function machineNoun(machine: CadreMachine): string {
	return `${machineKind(machine).toLowerCase()} ${machineCode(machine)}`;
}

/**
 * "Rented from Acme Cadre Nodes" for a machine whose peer id one of this app's rental records
 * names, else null. The record is this phone's own, so the fact shows only on the phone that rented the node.
 */
export function rentedFromText(machine: CadreMachine, rentals: readonly Rental[]): string | null {
	const rental = rentals.find((entry) => entry.peerId === machine.peerId);
	return rental ? `Rented from ${rental.providerName}` : null;
}

/** What a listed machine is, from whether it published that it is always on; `Machine` until it publishes a record. */
export function machineKind(machine: CadreMachine): string {
	if (machine.alwaysOn === null) return 'Machine';
	return machine.alwaysOn ? 'Always-on node' : 'App';
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

/**
 * One workspace's line under {@link WAITING_ROTATIONS_TITLE}. A line that offers the key
 * ({@link waitingRotationOffersKey}) stops at "admit key" because the section puts the key after
 * it, where it can be copied. Only an owner device the new key is sealed to (`sealedTo`) can join
 * for the party or finish the replacement, so the line names those devices from `machines` when
 * this device is not the one; a recipient missing from `machines` is not named.
 */
export function waitingRotationLine(rotation: PendingPartyKeyRotation, owner: boolean, machines: readonly CadreMachine[]): string {
	const { strandId, waitingOn } = rotation;
	if (waitingOn === 'sealed') {
		return `${strandId}: this workspace is sealed, so nobody can admit a new key; the removed device stays a member until the workspace is re-created.`;
	}
	if (rotation.sealedTo.length === 0) {
		// The driver has to open the new key to finish, so a seat admitted by hand would not finish either.
		return `${strandId}: none of the devices this key was sealed to is in this cadre any more, so none can finish it; removing a device from this cadre writes a fresh replacement sealed to the devices here.`;
	}
	const recipients = rotationRecipients(rotation, machines);
	switch (waitingOn) {
		case 'another-party':
			return `${strandId}: ask this workspace's host for a fresh invitation and join with it from ${joinFrom(recipients, owner)}; or have the host admit key`;
		case 'owner-machine': {
			const names = finisherNames(recipients, owner);
			return `${strandId}: finishes on an owner device that runs it${names.length === 0 ? '' : `, among ${names.join(', ')}`}.`;
		}
	}
}

/** Whether the line for `rotation` ends with its key for the host to admit: some device can still finish it from that seat. */
export function waitingRotationOffersKey(rotation: PendingPartyKeyRotation): boolean {
	return rotation.waitingOn === 'another-party' && rotation.sealedTo.length > 0;
}

/** The machines of `machines` a rotation's key is sealed to: whether this device is one (null when the list has no row for it), and the others by name. */
interface RotationRecipients {
	self: boolean | null;
	others: string[];
}

function rotationRecipients({ sealedTo }: PendingPartyKeyRotation, machines: readonly CadreMachine[]): RotationRecipients {
	const sealed = new Set(sealedTo);
	const self = machines.find((machine) => machine.isSelf);
	return {
		self: self === undefined ? null : sealed.has(self.peerId),
		others: machines.filter((machine) => !machine.isSelf && sealed.has(machine.peerId)).map((machine) => `the ${machineNoun(machine)}`),
	};
}

/** Where the `another-party` line sends the host's invitation. Only an owner can join for the party, so a non-owner device is never the answer and is not told why. */
function joinFrom({ self, others }: RotationRecipients, owner: boolean): string {
	if (owner && self === true) {
		return 'this device';
	}
	const among = others.length === 0 ? '' : ` among ${others.join(', ')}`;
	return `an owner device${among}${owner && self === false ? ' (this device cannot: it joined after the removal)' : ''}`;
}

/** The `owner-machine` line's names: none when this device is the only recipient, and this device among them when it is an owner recipient. */
function finisherNames({ self, others }: RotationRecipients, owner: boolean): string[] {
	if (others.length === 0) {
		return [];
	}
	return owner && self === true ? ['this device', ...others] : others;
}
