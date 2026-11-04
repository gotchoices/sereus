/**
 * machines.svelte.ts — state of the Cadre page's "Devices and nodes" card: every machine of this
 * cadre (apps and always-on nodes), the devices invited and not joined yet, the key replacements a
 * removal left waiting, and on an owner tab, Remove (`CadreNode.removeMachine`; docs/architecture.md
 * → "Removing a machine"). The browser counterpart of the phone app's `machines-section.tsx` and
 * `machines.ts`, with the same list, confirmation and wording. Owner keys are not machines and stay
 * when one is removed; removing one is a separate step under Owner keys (`owner-keys.svelte.ts`),
 * which the confirmation offers for a lost or stolen phone.
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
	type PendingPartyKeyRotation,
	describeThrown,
} from '@serfab/cadre-core';
import { getCadreNode, isOwner } from './cadre-web.js';
import { pushError } from './diagnostics.svelte.js';
import { ownerFingerprint, peerCode } from './cadre-format.js';
import type { Standing } from './add-device.svelte.js';

/** Why a removal cannot go ahead: in the confirmation from the plan, and in the notice when `removeMachine` refuses. */
export const REFUSAL_LINE: Record<MachineRemovalRefusal, string> = {
	'not-an-owner': 'Only an owner can remove machines, and this tab is not one.',
	// Leaving a cadre stops the node and deletes its data, which is the tab's own flow.
	self: 'A tab does not remove itself from its cadre: to remove this tab, use another owner device.',
};

/** Removing a machine leaves its owner key live; only removing the key locks a lost phone out. */
export const LOST_DEVICE_LINE = 'If this was a lost or stolen phone that held an owner key, remove that key too in Owner keys; otherwise whoever has the phone can still act as an owner.';

/** The block of waiting key replacements, which the removal confirmation also points to by this name. */
export const WAITING_ROTATIONS_TITLE = 'Key replacements waiting';

/** Why the last action did not do what was asked; replaced by the next action's. */
export interface MachinesNotice {
	title: string;
	message: string;
}

/** The removal the confirmation is for. */
export interface PendingRemoval {
	machine: CadreMachine;
	plan: MachineRemovalPlan;
}

interface MachinesState {
	standing: Standing;
	machines: CadreMachine[];
	/** Live invitations for one device that has not joined yet. */
	pending: CadreInviteStatus[];
	/** The party key replacements still waiting; the last read that worked. */
	waitingRotations: PendingPartyKeyRotation[];
	/** When the list was read, for "last seen". */
	readAtMs: number;
	listError: string | null;
	confirming: PendingRemoval | null;
	/** A plan read or a removal is running; they run one at a time. */
	busy: boolean;
	notice: MachinesNotice | null;
}

function initialState(): MachinesState {
	return { standing: 'checking', machines: [], pending: [], waitingRotations: [], readAtMs: 0, listError: null, confirming: null, busy: false, notice: null };
}

const state = $state<MachinesState>(initialState());

export function machinesState(): MachinesState {
	return state;
}

/** Re-read this tab's owner standing, the cadre's machines, the devices invited and the key replacements waiting, from the running node. */
export async function refreshMachines(): Promise<void> {
	const node = getCadreNode();
	if (!node) return;
	void refreshWaitingRotations();
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
		if (!stale()) state.listError = describeThrown(err);
	}
}

/** The last read of the waiting list begun: the node's events can start one while another runs, and an earlier read can finish last. */
let latestRotationRead = 0;

/**
 * Re-read the party key replacements still waiting, as `refreshMachines` does and again when the node
 * reports one blocked or finished. No event announces a row replicated from another machine, so a
 * second device sees it on its next read. A read that fails keeps the last list, so a failure never
 * reads as nothing waiting.
 *
 * NOTE: no event announces a key seated while its swap is deferred (this machine is alone), so the
 * line keeps asking for an invitation until the next read; if owners trip on that, re-read after a join.
 */
export async function refreshWaitingRotations(): Promise<void> {
	const node = getCadreNode();
	if (!node) return;
	const read = ++latestRotationRead;
	try {
		const rotations = await node.listPendingPartyKeyRotations();
		if (read === latestRotationRead && getCadreNode() === node) state.waitingRotations = rotations;
	} catch (err) {
		console.warn('[cadre] could not read the key replacements waiting:', err);
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
			state.notice = { title: 'Could not prepare the removal', message: describeThrown(err) };
			return;
		}
		if (getCadreNode() !== node) return;
		if (plan.machine === null) {
			state.notice = alreadyRemoved(machine);
			void refreshMachines();
			return;
		}
		state.confirming = { machine: plan.machine, plan };
	});
}

export function cancelRemoval(): void {
	state.confirming = null;
}

/** Remove the machine the confirmation is for, then re-read the list. */
export async function confirmRemoval(): Promise<void> {
	const removal = state.confirming;
	state.confirming = null;
	if (!removal) return;
	await exclusive(async (node) => {
		await remove(node, removal);
		await refreshMachines();
	});
}

async function remove(node: CadreNode, { machine }: PendingRemoval): Promise<void> {
	try {
		const result = await node.removeMachine(machine.peerId);
		if (!result.removedPeer) {
			state.notice = alreadyRemoved(machine);
			return;
		}
		console.info(`[cadre] removed machine ${machine.peerId} (invitations withdrawn ${result.withdrawnInvitations.length})`);
	} catch (err) {
		console.warn(`[cadre] removing machine ${machine.peerId} failed:`, err);
		if (err instanceof MachineRemovalRefusedError) {
			state.notice = { title: 'Could not remove it', message: REFUSAL_LINE[err.code] };
		} else {
			pushError('removeMachine', err);
			state.notice = { title: 'Could not remove it', message: describeThrown(err) };
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
		state.notice = { title: 'Could not withdraw the invitation', message: describeThrown(err) };
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
// NOTE: hand-kept copies of the phone app's `machines.ts` and the words in `machines-section.tsx`
// and `machine-removal.tsx`. If a third surface (cadre-host's UI) lists machines, move them into
// cadre-core and import them everywhere.

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

/** The fingerprint of the machine's identity key, in cadre-host's form, else the shortened peer id. */
export function machineCode(machine: CadreMachine): string {
	return machine.publicKey !== null ? ownerFingerprint(machine.publicKey) : peerCode(machine.peerId);
}

/** "The always-on node 1a2b3c4d", for a notice. */
function machineName(machine: CadreMachine): string {
	return `The ${machineKind(machine).toLowerCase()} ${machineCode(machine)}`;
}

/**
 * One line per private workspace whose key replacement this removal does not finish from this tab.
 *
 * NOTE: the plan cannot tell a sealed workspace from one another party can still finish, so a sealed
 * one gets the `another-party` line here; the waiting list's own line for it is the accurate one.
 */
export function unfinishedWorkspaces(plan: MachineRemovalPlan): string[] {
	return plan.strands.flatMap(({ strandId, rotation }) => {
		switch (rotation) {
			case 'another-party':
				return [`${strandId}: needs the other party's manager: ask the host for a fresh invitation, or have them admit the key shown under ${WAITING_ROTATIONS_TITLE}`];
			case 'later':
				return [`${strandId}: finishes on an owner device that runs it`];
			case 'here':
				return [];
		}
	});
}

/**
 * One workspace's line under {@link WAITING_ROTATIONS_TITLE}. The `another-party` line stops at
 * "admit key" because the card puts the key after it, where it can be copied. Only an owner device
 * can join for the party, so a non-owner's line names one rather than this tab.
 */
export function waitingRotationLine({ strandId, waitingOn }: PendingPartyKeyRotation, owner: boolean): string {
	switch (waitingOn) {
		case 'another-party':
			return `${strandId}: ask this workspace's host for a fresh invitation and join with it from ${owner ? 'this tab' : 'an owner device'}; or have the host admit key`;
		case 'owner-machine':
			return `${strandId}: finishes on an owner device that runs it.`;
		case 'sealed':
			return `${strandId}: this workspace is sealed, so nobody can admit a new key; the removed device stays a member until the workspace is re-created.`;
	}
}

/** "It is removed from this cadre. The 2 invitations it could join again with are withdrawn." */
export function removalEffects(plan: MachineRemovalPlan): string {
	const count = plan.invitations.length;
	return [
		'It is removed from this cadre.',
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
	const members = new Set(machines.map((machine) => machine.peerId));
	return statuses.filter((status) => status.live && status.invite.peerId !== null && !members.has(status.invite.peerId));
}
