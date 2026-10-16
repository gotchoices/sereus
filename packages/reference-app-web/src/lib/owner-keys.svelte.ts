/**
 * owner-keys.svelte.ts — state of the Cadre page's "Owner keys" card: this cadre's owner keys
 * (`CadreNode.listOwnerKeys`) and, on an owner tab, Make a backup key, Export this tab's key and
 * Remove (`planOwnerKeyRemoval`, `removeOwner`), with Import on any tab (docs/architecture.md →
 * "Owner Keys"). The browser counterpart of the phone app's `owner-keys-section.tsx` and
 * `owner-keys.ts`, with the same list, forms, prompt and wording, "this tab" for "this device",
 * and Download for Share. A tab has no camera scanner, so Import takes pasted text only.
 *
 * Module state, as `machines.svelte.ts` is: the router unmounts the page on every route change,
 * and a backup key's export exists nowhere else, so it has to survive a visit to Home. The store
 * cannot reset this card, since the import goes through the store, so a read on a node other than
 * the one the card was read on forgets the card first: a join, its rollback and a restart each
 * replace the node.
 *
 * An export's text is the private key, and so is the text pasted into Import: log neither, nor a
 * passphrase. Log a key's fingerprint.
 */

import {
	LOCKED_OWNER_KEY_EXPORT_PREFIX,
	OWNER_KEY_MAX_LABEL,
	OwnerKeyAddRefusedError,
	OwnerKeyExportError,
	OwnerKeyRemovalRefusedError,
	OwnerKeySlotOccupiedError,
	type CadreMachine,
	type CadreNode,
	type CadreOwnerKey,
	type ImportedOwnerKey,
	type OwnerKeyAddRefusal,
	type OwnerKeyExportOptions,
	type OwnerKeyRemovalPlan,
	type OwnerKeyRemovalRefusal,
} from '@serfab/cadre-core';
import { addBackupOwnerKey, exportOwnerKey, getCadreNode, isOwner } from './cadre-web.js';
import { importOwnerKey } from './store.svelte.js';
import { pushError } from './diagnostics.svelte.js';
import { errorMessage, ownerFingerprint, peerCode } from './cadre-format.js';
import { machineCode, machineKind, refreshMachines } from './machines.svelte.js';
import type { Standing } from './add-device.svelte.js';

/** The card's element id, which machine removal's "Go to Owner keys" scrolls to. */
export const OWNER_KEYS_CARD_ID = 'owner-keys';

/** Which part of the card a notice shows under: the list (a removal), the open form, or Import. */
export type NoticeArea = 'list' | 'form' | 'import';

/** What the last action came to; replaced by the next action's. */
export interface OwnerKeysNotice {
	area: NoticeArea;
	title: string;
	message: string;
	/** A refusal or a failure, rather than an outcome to read. */
	failed: boolean;
}

/** What the card shows in place of its buttons: a form, or an export shown once. */
export type Panel =
	| { kind: 'backup-form' }
	| { kind: 'export-form'; defaultLabel: string }
	| { kind: 'export'; title: string; publicKey: string; text: string };

/** The removal the confirmation is for. */
export interface PendingRemoval {
	ownerKey: CadreOwnerKey;
	plan: OwnerKeyRemovalPlan;
	rows: DependentRow[];
	/** The ids of the rows whose Keep box is checked; every row until unchecked. */
	kept: string[];
}

interface OwnerKeysState {
	standing: Standing;
	keys: CadreOwnerKey[];
	listError: string | null;
	panel: Panel | null;
	confirming: PendingRemoval | null;
	/** A backup, an export, an import, a plan read or a removal is running; they run one at a time. */
	busy: boolean;
	notice: OwnerKeysNotice | null;
}

function initialState(): OwnerKeysState {
	return { standing: 'checking', keys: [], listError: null, panel: null, confirming: null, busy: false, notice: null };
}

const state = $state<OwnerKeysState>(initialState());
/** The node the card was last read on. */
let readOn: CadreNode | null = null;

export function ownerKeysState(): OwnerKeysState {
	return state;
}

/**
 * Re-read this tab's owner standing and the cadre's owner keys from the running node. The keys
 * read, or null when the read failed or the node was replaced meanwhile.
 */
export async function refreshOwnerKeys(): Promise<CadreOwnerKey[] | null> {
	const node = getCadreNode();
	if (!node) return null;
	forgetIfReplaced(node);
	const stale = () => getCadreNode() !== node;
	try {
		const owner = await isOwner();
		if (!stale()) state.standing = owner ? 'owner' : 'member';
	} catch (err) {
		console.warn('[cadre] could not read whether this tab is an owner:', err);
		if (!stale()) state.standing = 'unreadable';
	}
	try {
		const keys = await node.listOwnerKeys();
		if (stale()) return null;
		state.keys = keys;
		state.listError = null;
		return keys;
	} catch (err) {
		console.warn('[cadre] could not read this cadre\'s owner keys:', err);
		if (!stale()) state.listError = errorMessage(err);
		return null;
	}
}

/** The card's list, forms, export and confirmation belong to the node they were read on; an action still running keeps the card busy. */
function forgetIfReplaced(node: CadreNode): void {
	if (node === readOn) return;
	readOn = node;
	Object.assign(state, initialState(), { busy: state.busy });
}

export function showBackupForm(): void {
	state.notice = null;
	state.panel = { kind: 'backup-form' };
}

/** The export form, its name defaulting to that of the key this tab signs with. */
export function showExportForm(ownKey: CadreOwnerKey): void {
	state.notice = null;
	state.panel = { kind: 'export-form', defaultLabel: ownKey.label ?? '' };
}

/** Close the form, or take the export off the card: it is not shown again. */
export function closePanel(): void {
	state.panel = null;
	state.notice = null;
}

/** Seat a new owner key under the form's name and show its export, the only copy. */
export async function makeBackup(form: ExportForm): Promise<void> {
	await exclusive(async () => {
		try {
			const { publicKey, exportText } = await addBackupOwnerKey(exportOptions(form));
			console.info(`[cadre] added backup owner key ${ownerFingerprint(publicKey)}`);
			const name = ownerKeyName({ key: publicKey, label: form.label.trim() || null });
			state.panel = { kind: 'export', title: `New owner key ${name}`, publicKey, text: exportText };
			changed();
		} catch (err) {
			console.warn('[cadre] making a backup owner key failed:', err);
			state.notice = failure('form', 'Could not make a backup key', err);
		}
	});
}

/** Export the key in this tab's owner slot, titled with the key the export holds. */
export async function exportOwnKey(form: ExportForm): Promise<void> {
	await exclusive(async () => {
		try {
			const { publicKey, exportText } = await exportOwnerKey(exportOptions(form));
			console.info(`[cadre] exported this tab's owner key ${ownerFingerprint(publicKey)}`);
			state.panel = { kind: 'export', title: `Owner key ${listedKeyName(state.keys, publicKey)}`, publicKey, text: exportText };
		} catch (err) {
			console.warn('[cadre] exporting this tab\'s owner key failed:', err);
			state.notice = failure('form', 'Could not export this tab\'s key', err);
		}
	});
}

/**
 * Import pasted owner-key text and say what it came to, reading the owner keys again to tell the
 * outcomes apart ({@link importOutcome}). True once the tab keeps the key, so the form clears.
 */
export async function importPasted(text: string, passphrase: string | undefined): Promise<boolean> {
	const stored = await exclusive(async () => {
		let imported: ImportedOwnerKey;
		try {
			imported = await importOwnerKey(text, passphrase);
		} catch (err) {
			// The refusals never carry key material.
			console.warn('[cadre] importing an owner key failed:', err);
			state.notice = failure('import', 'Could not import the key', err);
			return false;
		}
		console.info(`[cadre] imported owner key ${ownerFingerprint(imported.publicKey)} (wired ${imported.wired})`);
		void refreshMachines();
		const listed = await refreshOwnerKeys();
		state.notice = { area: 'import', failed: false, ...importNotice(imported, listed) };
		return true;
	});
	return stored === true;
}

/** Read what removing `ownerKey` would do and open the confirmation, or say why there is nothing to remove. */
export async function askToRemove(ownerKey: CadreOwnerKey): Promise<void> {
	await exclusive(async (node) => {
		let plan: OwnerKeyRemovalPlan;
		try {
			plan = await node.planOwnerKeyRemoval(ownerKey.key);
		} catch (err) {
			console.warn(`[cadre] could not read what removing owner key ${ownerFingerprint(ownerKey.key)} would do:`, err);
			state.notice = { area: 'list', title: 'Could not prepare the removal', message: errorMessage(err), failed: true };
			return;
		}
		const machines = plan.dependents.peers.length > 0 ? await readMachinesQuietly(node) : [];
		if (getCadreNode() !== node) return;
		if (plan.ownerKey === null) {
			state.notice = alreadyRemoved(ownerKey);
			void refreshOwnerKeys();
			return;
		}
		const rows = dependentRows(plan, state.keys, machines);
		state.confirming = { ownerKey: plan.ownerKey, plan, rows, kept: rows.map((row) => row.id) };
	});
}

/** Check or uncheck one Keep box of the confirmation. */
export function setKept(id: string, keep: boolean): void {
	const removal = state.confirming;
	if (!removal) return;
	const others = removal.kept.filter((kept) => kept !== id);
	removal.kept = keep ? [...others, id] : others;
}

export function cancelRemoval(): void {
	state.confirming = null;
}

/** Remove the key the confirmation is for, re-vouching the rows kept, then re-read. */
export async function confirmRemoval(): Promise<void> {
	const removal = state.confirming;
	// Kept open while another action runs: `exclusive` would drop the removal unsaid.
	if (!removal || state.busy) return;
	state.confirming = null;
	await exclusive(async (node) => {
		await remove(node, removal);
		changed();
	});
}

async function remove(node: CadreNode, { ownerKey, rows, kept }: PendingRemoval): Promise<void> {
	const revouch = revouchOf(rows, new Set(kept));
	const fingerprint = ownerFingerprint(ownerKey.key);
	try {
		const result = await node.removeOwner(ownerKey.key, { revouch });
		if (!result.removed) {
			state.notice = alreadyRemoved(ownerKey);
			return;
		}
		console.info(`[cadre] removed owner key ${fingerprint} (kept ${revouch.peers.length} devices, ${revouch.owners.length} keys)`);
	} catch (err) {
		console.warn(`[cadre] removing owner key ${fingerprint} failed:`, err);
		if (!(err instanceof OwnerKeyRemovalRefusedError)) pushError('removeOwner', err);
		const gone = err instanceof OwnerKeyRemovalRefusedError && err.code === 'unknown';
		state.notice = failure('list', gone ? 'Already removed' : 'Could not remove it', err);
	}
}

/** Run `action` on the running node unless another owner-key action is already running. */
async function exclusive<T>(action: (node: CadreNode) => Promise<T>): Promise<T | undefined> {
	const node = getCadreNode();
	if (state.busy || !node) return undefined;
	state.busy = true;
	state.notice = null;
	try {
		return await action(node);
	} finally {
		state.busy = false;
	}
}

/** After a key is added or removed here: the list, and which machines Devices and nodes trusts, change. */
function changed(): void {
	void refreshMachines();
	void refreshOwnerKeys();
}

/** The machines, for naming a removal's dependents, or none, logged: names fall back to peer ids rather than the removal failing. */
async function readMachinesQuietly(node: CadreNode): Promise<CadreMachine[]> {
	try {
		return await node.listMachines();
	} catch (err) {
		console.warn('[cadre] could not read this cadre\'s machines to name them:', err);
		return [];
	}
}

function failure(area: NoticeArea, title: string, err: unknown): OwnerKeysNotice {
	return { area, title, message: describeOwnerKeyFailure(err), failed: true };
}

function alreadyRemoved(ownerKey: CadreOwnerKey): OwnerKeysNotice {
	return { area: 'list', title: 'Already removed', message: `${ownerKeyName(ownerKey)} is no longer an owner key of this cadre.`, failed: true };
}

/** The notice after an import; `listed` null when the owner keys could not be read after it. */
function importNotice(imported: ImportedOwnerKey, listed: readonly CadreOwnerKey[] | null): { title: string; message: string } {
	if (listed === null && !imported.wired) {
		return {
			title: 'Owner key imported',
			message: `This tab keeps the key (${ownerFingerprint(imported.publicKey)}). Could not read this cadre's owner keys to say whether it is one of them; see the list once it reads again.`,
		};
	}
	return importOutcomeText(importOutcome(imported, listed ?? []), imported, listed ?? []);
}

// ── What the card shows ───────────────────────────────────────────────────────
// NOTE: hand-kept copies of the phone app's `owner-keys.ts` and the words in
// `owner-keys-section.tsx`, with "tab" for "device" and "phone". If a third surface (cadre-host's
// UI) manages owner keys, move them into cadre-core and import them everywhere.

/** The name a backup key is offered under. */
export const DEFAULT_BACKUP_LABEL = 'Backup';

/** Under this tab's own key: an owner key cannot sign its own removal (`self`). */
export const OWN_KEY_LINE = 'A tab cannot remove its own owner key; use another owner key.';

/** Above an export, the one time it is shown. */
export const EXPORT_WARNING = 'Anyone who has this can control your cadre. Keep it somewhere safe and offline. This tab does not keep a copy.';

const ALONE_LINE = 'Connect to your cadre first; a new owner key made now would not reach your other machines.';

const ADD_REFUSAL_LINE: Record<OwnerKeyAddRefusal, string> = {
	alone: ALONE_LINE,
};

/** Why a removal cannot go ahead: in the confirmation from the plan, and in the notice when `removeOwner` refuses. */
export const REMOVAL_REFUSAL_LINE: Record<OwnerKeyRemovalRefusal, string> = {
	'not-an-owner': 'Only an owner can remove owner keys, and this tab is not one.',
	unknown: 'This key is no longer an owner of this cadre.',
	'last-owner': 'It cannot be removed: it is the only owner key of this cadre.',
	self: OWN_KEY_LINE,
	alone: 'Connect to your cadre first; the owner keys you keep would not reach your other machines.',
};

const SLOT_OCCUPIED_LINE = 'This tab already holds a different owner key, and a tab holds one. This key was not imported.';

/** Whether owner-key text is a locked export, which asks for its passphrase. */
export function isLockedOwnerKeyText(text: string): boolean {
	return text.trim().startsWith(LOCKED_OWNER_KEY_EXPORT_PREFIX);
}

/** A listed key's title: the name it was added under, or "Unnamed key". */
export function ownerKeyTitle(key: Pick<CadreOwnerKey, 'label'>): string {
	return key.label ?? 'Unnamed key';
}

/** "Backup (1a2b3c4d)", for a prompt or a notice. */
export function ownerKeyName(key: Pick<CadreOwnerKey, 'key' | 'label'>): string {
	return `${ownerKeyTitle(key)} (${ownerFingerprint(key.key)})`;
}

/** The line under a listed key's title: its fingerprint, and "This tab" on the key this tab signs with. */
export function ownerKeyFacts(key: CadreOwnerKey): string {
	return key.heldHere ? `${ownerFingerprint(key.key)} · This tab` : ownerFingerprint(key.key);
}

/** A key by its listed row when `keys` has one ("Backup (1a2b3c4d)"), else by its fingerprint alone. */
function listedKeyName(keys: readonly CadreOwnerKey[], key: string): string {
	const row = keys.find((entry) => entry.key === key);
	return row ? ownerKeyName(row) : ownerFingerprint(key);
}

/** What the backup and export form holds. */
export interface ExportForm {
	label: string;
	/** Protect with a passphrase. */
	locked: boolean;
	passphrase: string;
	/** The passphrase typed again. */
	repeat: string;
}

/** Why the form cannot be sent yet, for the line under it; null when it can. */
export function exportFormProblem(form: ExportForm): string | null {
	if (form.label.trim().length > OWNER_KEY_MAX_LABEL) return `A name has at most ${OWNER_KEY_MAX_LABEL} characters.`;
	if (!form.locked) return null;
	if (form.passphrase === '') return 'Enter a passphrase, or turn off Protect with a passphrase.';
	if (form.passphrase !== form.repeat) return 'The two passphrases do not match.';
	return null;
}

/** The form as `addBackupOwnerKey` and `exportOwnerKey` take it: a blank name is none, and an unlocked export has no passphrase. */
function exportOptions(form: ExportForm): OwnerKeyExportOptions {
	const label = form.label.trim();
	return {
		...(label !== '' && { label }),
		...(form.locked && { passphrase: form.passphrase }),
	};
}

/**
 * What an import came to. `importOwnerKey` answers `wired: false` both for a key that is no owner
 * of this cadre and for one that is, on a node already signing with another key (the identity key
 * an owner-granting invitation seated), which takes the imported key at its next start; `listed`,
 * the cadre's owner keys read after the import, tells the two apart.
 */
type ImportOutcome = 'owner' | 'owner-from-next-start' | 'not-an-owner';

function importOutcome(imported: ImportedOwnerKey, listed: readonly CadreOwnerKey[]): ImportOutcome {
	if (imported.wired) return 'owner';
	return listed.some((key) => key.key === imported.publicKey) ? 'owner-from-next-start' : 'not-an-owner';
}

/** The notice after an import, naming the key as the list does when the cadre lists it. */
function importOutcomeText(outcome: ImportOutcome, imported: ImportedOwnerKey, listed: readonly CadreOwnerKey[]): { title: string; message: string } {
	const name = listedKeyName(listed, imported.publicKey);
	switch (outcome) {
		case 'owner':
			return { title: 'Owner key imported', message: `This tab is now an owner of this cadre, with ${name}.` };
		case 'owner-from-next-start':
			return {
				title: 'Owner key imported',
				message: `${name} is an owner of this cadre. This tab already signs with another owner key, so it uses ${name} from the next time it starts.`,
			};
		case 'not-an-owner':
			return {
				title: 'Not an owner of this cadre',
				message: `This key is not an owner of this cadre. An owner can add it. This tab keeps it (${name}), and signs with it from the next time it starts after an owner has added it.`,
			};
	}
}

/** What the notice says for a backup, an export, an import or a removal that failed. */
function describeOwnerKeyFailure(err: unknown): string {
	// The export module's messages are written for the user and never carry key material.
	if (err instanceof OwnerKeyExportError) return err.message;
	if (err instanceof OwnerKeySlotOccupiedError) return SLOT_OCCUPIED_LINE;
	if (err instanceof OwnerKeyAddRefusedError) return ADD_REFUSAL_LINE[err.code];
	if (err instanceof OwnerKeyRemovalRefusedError) return REMOVAL_REFUSAL_LINE[err.code];
	return errorMessage(err);
}

/** One Keep box in the removal confirmation: a device or an owner key the removed key added. */
export interface DependentRow {
	kind: 'device' | 'owner-key';
	/** A device's peer id, an owner key's key: what `removeOwner`'s `revouch` names. */
	id: string;
	name: string;
}

/**
 * The plan's dependents as Keep boxes, devices first: a device named as Devices and nodes names
 * it (else by its short peer id), an owner key by its name and fingerprint (else the fingerprint alone).
 */
function dependentRows(plan: OwnerKeyRemovalPlan, owners: readonly CadreOwnerKey[], machines: readonly CadreMachine[]): DependentRow[] {
	const devices = plan.dependents.peers.map((peerId): DependentRow => {
		const machine = machines.find((entry) => entry.peerId === peerId);
		return { kind: 'device', id: peerId, name: machine ? `${machineKind(machine)} ${machineCode(machine)}` : peerCode(peerId) };
	});
	const keys = plan.dependents.owners.map((key): DependentRow => ({ kind: 'owner-key', id: key, name: listedKeyName(owners, key) }));
	return [...devices, ...keys];
}

/** What `removeOwner` re-vouches (its `revouch` option): the rows whose Keep box is checked. */
function revouchOf(rows: readonly DependentRow[], kept: ReadonlySet<string>): { peers: string[]; owners: string[] } {
	const keptIds = (kind: DependentRow['kind']) => rows.filter((row) => row.kind === kind && kept.has(row.id)).map((row) => row.id);
	return { peers: keptIds('device'), owners: keptIds('owner-key') };
}
