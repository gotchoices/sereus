/**
 * machines.svelte.ts — state of the Cadre page's "Devices and nodes" card: every machine of this
 * cadre (apps, always-on nodes, owner keys no machine has joined with) and the devices invited and
 * not joined yet, and on an owner tab, Remove (`CadreNode.removeMachine`; docs/architecture.md →
 * "Removing a machine"). The browser counterpart of the phone app's `machines-section.tsx` and
 * `machines.ts`, with the same list, confirmation and wording.
 *
 * A removed machine's owner key goes with it, and the devices and owners that key added stop being
 * trusted unless re-vouched first, so the confirmation lists them with a Keep switch each.
 *
 * Module state, as `add-device.svelte.ts` is: the router unmounts the page on every route change.
 * The store forgets it when the node moves to another party (`resetMachinesCard`), and a read that
 * finishes after the node changed is dropped.
 */

import {
	MachineRemovalRefusedError,
	type CadreInviteStatus,
	type CadreMachine,
	type CadreNode,
	type MachineRemovalPlan,
	type MachineRemovalRefusal,
	type RemoveMachineOptions,
} from '@serfab/cadre-core';
import { getCadreNode, isOwner } from './cadre-web.js';
import { pushError } from './diagnostics.svelte.js';
import { errorMessage, ownerFingerprint, peerCode } from './cadre-format.js';
import type { Standing } from './add-device.svelte.js';

/** Why a removal cannot go ahead: in the confirmation from the plan, and in the notice when `removeMachine` refuses. */
export const REFUSAL_LINE: Record<MachineRemovalRefusal, string> = {
	'not-an-owner': 'Only an owner can remove machines, and this tab is not one.',
	self: 'To remove this tab, use another owner device.',
	'last-owner': 'It cannot be removed: it holds the only owner key of this cadre.',
};

/** Why the last action did not do what was asked; replaced by the next action's. */
export interface MachinesNotice {
	title: string;
	message: string;
}

/**
 * One "Keep" switch in the confirmation: a machine or owner key the removed machine added. A device
 * added as an owner is one dependent with both its peer row and its owner key, so one switch keeps
 * or drops it whole.
 */
export interface Dependent {
	/** Unique within the confirmation: the peer id, else the owner key. */
	id: string;
	/** A dependent `CadrePeer` row's peer id. */
	peerId: string | null;
	/** A dependent `OwnerKey` row's key. */
	ownerKey: string | null;
	/** The listed machine it is, when one is listed. */
	machine: CadreMachine | null;
}

/** The removal the confirmation is for. */
export interface PendingRemoval {
	machine: CadreMachine;
	plan: MachineRemovalPlan;
	dependents: Dependent[];
	/** `Dependent.id`s whose Keep switch is on. */
	kept: string[];
}

interface MachinesState {
	standing: Standing;
	machines: CadreMachine[];
	/** Live invitations for one device that has not joined yet. */
	pending: CadreInviteStatus[];
	/** When the list was read, for "last seen". */
	readAtMs: number;
	listError: string | null;
	confirming: PendingRemoval | null;
	/** A plan read or a removal is running; they run one at a time. */
	busy: boolean;
	notice: MachinesNotice | null;
}

function initialState(): MachinesState {
	return { standing: 'checking', machines: [], pending: [], readAtMs: 0, listError: null, confirming: null, busy: false, notice: null };
}

const state = $state<MachinesState>(initialState());

export function machinesState(): MachinesState {
	return state;
}

/** Re-read this tab's owner standing, the cadre's machines and the devices invited, from the running node. */
export async function refreshMachines(): Promise<void> {
	const node = getCadreNode();
	if (!node) return;
	const stale = () => getCadreNode() !== node;
	try {
		const owner = await isOwner();
		if (!stale()) state.standing = owner ? 'owner' : 'member';
	} catch (err) {
		console.warn('[cadre] could not read this cadre\'s owner keys:', err);
		if (!stale()) state.standing = 'unreadable';
	}
	try {
		const machines = await node.listMachines();
		const invitations = await node.listCadreInvitations();
		if (stale()) return;
		state.machines = machines;
		state.pending = pendingDeviceInvitations(invitations, machines);
		state.readAtMs = Date.now();
		state.listError = null;
	} catch (err) {
		console.warn('[cadre] could not read this cadre\'s machines:', err);
		if (!stale()) state.listError = errorMessage(err);
	}
}

/** Read what removing `machine` would do and open the confirmation, or say why there is nothing to remove. */
export async function askToRemove(machine: CadreMachine): Promise<void> {
	await exclusive(async (node) => {
		let plan: MachineRemovalPlan;
		try {
			plan = await node.planMachineRemoval(machine.peerId);
		} catch (err) {
			console.warn(`[cadre] could not read what removing ${machine.peerId} would do:`, err);
			state.notice = { title: 'Could not prepare the removal', message: errorMessage(err) };
			return;
		}
		if (getCadreNode() !== node) return;
		if (plan.machine === null) {
			state.notice = alreadyRemoved(machine);
			void refreshMachines();
			return;
		}
		const dependents = dependentsOf(plan, state.machines);
		state.confirming = { machine: plan.machine, plan, dependents, kept: dependents.map((dependent) => dependent.id) };
	});
}

export function setKeep(id: string, keep: boolean): void {
	const removal = state.confirming;
	if (!removal) return;
	const others = removal.kept.filter((kept) => kept !== id);
	removal.kept = keep ? [...others, id] : others;
}

export function cancelRemoval(): void {
	state.confirming = null;
}

/** Remove the machine the confirmation is for, re-vouching the dependents kept first, then re-read the list. */
export async function confirmRemoval(): Promise<void> {
	const removal = state.confirming;
	state.confirming = null;
	if (!removal) return;
	await exclusive(async (node) => {
		await remove(node, removal);
		await refreshMachines();
	});
}

async function remove(node: CadreNode, { machine, dependents, kept }: PendingRemoval): Promise<void> {
	try {
		const result = await node.removeMachine(machine.peerId, { revouch: revouchFor(dependents, new Set(kept)) });
		if (!result.removedPeer && !result.removedOwnerKey) {
			state.notice = alreadyRemoved(machine);
			return;
		}
		console.info(`[cadre] removed machine ${machine.peerId} (owner key ${result.removedOwnerKey}, invitations withdrawn ${result.withdrawnInvitations.length}, kept ${result.revouched.peers.length} devices and ${result.revouched.owners.length} owner keys)`);
	} catch (err) {
		console.warn(`[cadre] removing machine ${machine.peerId} failed:`, err);
		if (err instanceof MachineRemovalRefusedError) {
			state.notice = { title: 'Could not remove it', message: REFUSAL_LINE[err.code] };
		} else {
			pushError('removeMachine', err);
			state.notice = { title: 'Could not remove it', message: errorMessage(err) };
		}
	}
}

/** Withdraw an invitation made for a device not joined yet (the caller has confirmed), then re-read the list. */
export async function withdrawDeviceInvitation(key: string): Promise<void> {
	const node = getCadreNode();
	if (!node) return;
	state.notice = null;
	try {
		if (!(await node.withdrawCadreInvitation(key))) {
			console.info(`[cadre] cadre invitation ${key} was already withdrawn`);
		}
	} catch (err) {
		console.warn(`[cadre] withdrawing cadre invitation ${key} failed:`, err);
		state.notice = { title: 'Could not withdraw the invitation', message: errorMessage(err) };
	}
	await refreshMachines();
}

/** Forget the list, the confirmation and the notice: they belong to the party the node ran. The next `running` reads them again. */
export function resetMachinesCard(): void {
	Object.assign(state, initialState());
}

/** Run `action` on the running node unless a plan read or a removal is already running. */
async function exclusive(action: (node: CadreNode) => Promise<void>): Promise<void> {
	const node = getCadreNode();
	if (state.busy || !node) return;
	state.busy = true;
	state.notice = null;
	try {
		await action(node);
	} finally {
		state.busy = false;
	}
}

function alreadyRemoved(machine: CadreMachine): MachinesNotice {
	return { title: 'Already removed', message: `${machineName(machine)} is no longer in this cadre.` };
}

// ── What the card shows ───────────────────────────────────────────────────────
// NOTE: hand-kept copies of the phone app's `machines.ts` and the words in `machines-section.tsx`,
// where `test/machines.spec.ts` covers `dependentsOf` and `revouchFor`. If a third surface (cadre-host's
// UI) lists machines, move them into cadre-core and import them everywhere.

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
 * published a record this tab can verify. A time ahead of this browser's clock (the stamp is the
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

/** The key fingerprint cadre-host shows for an owner, else the shortened peer id. */
export function machineCode(machine: CadreMachine): string {
	return machine.publicKey !== null ? ownerFingerprint(machine.publicKey) : peerCode(machine.peerId);
}

/** "The always-on node 1a2b3c4d", for a notice. */
function machineName(machine: CadreMachine): string {
	return `The ${machineKind(machine).toLowerCase()} ${machineCode(machine)}`;
}

/** "App 1a2b3c4d (owner)"; an owner key the listing has no machine for is named by its fingerprint. */
export function dependentName({ id, machine, peerId, ownerKey }: Dependent): string {
	const owner = ownerKey !== null ? ' (owner)' : '';
	if (machine) return `${machineKind(machine)} ${machineCode(machine)}${owner}`;
	if (peerId !== null) return `Machine ${peerCode(peerId)}${owner}`;
	return `Owner key ${ownerFingerprint(id)}`;
}

/** "It is removed from this cadre. Its owner key is removed too. 2 invitations it could join again with are withdrawn." */
export function removalEffects(plan: MachineRemovalPlan): string {
	const count = plan.invitations.length;
	return [
		'It is removed from this cadre.',
		plan.removesOwnerKey ? 'Its owner key is removed too.' : null,
		count === 1 ? 'The invitation it could join again with is withdrawn.' : null,
		count > 1 ? `The ${count} invitations it could join again with are withdrawn.` : null,
	].filter((line) => line !== null).join(' ');
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
function pendingDeviceInvitations(statuses: readonly CadreInviteStatus[], machines: readonly CadreMachine[]): CadreInviteStatus[] {
	const members = new Set(machines.filter((machine) => machine.isMember).map((machine) => machine.peerId));
	return statuses.filter((status) => status.live && status.invite.peerId !== null && !members.has(status.invite.peerId));
}

/** The plan's dependents as switches: each owner key joined to the dependent peer row behind it, when there is one. */
function dependentsOf(plan: MachineRemovalPlan, machines: readonly CadreMachine[]): Dependent[] {
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
function revouchFor(dependents: readonly Dependent[], kept: ReadonlySet<string>): NonNullable<RemoveMachineOptions['revouch']> {
	const chosen = dependents.filter((dependent) => kept.has(dependent.id));
	return {
		owners: chosen.flatMap((dependent) => dependent.ownerKey ?? []),
		peers: chosen.flatMap((dependent) => dependent.peerId ?? []),
	};
}
