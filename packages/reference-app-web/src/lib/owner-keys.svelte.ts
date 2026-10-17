/**
 * owner-keys.svelte.ts — state of the Cadre page's "Owner keys" card: this cadre's owner keys
 * (`CadreNode.listOwnerKeys`) and, on an owner tab, Add an owner key and Make a backup (owner
 * grants, `createOwnerGrant`), the outstanding grants with Withdraw, Export this tab's key and
 * Remove (`planOwnerKeyRemoval`, `removeOwner`), with Redeem an owner grant and Import on any tab
 * (docs/architecture.md → "Owner Keys", "Owner grants"). The browser counterpart of the phone
 * app's `owner-keys-section.tsx`, `owner-grant-views.tsx` and `owner-keys.ts`, with the same
 * list, forms, prompt and wording, "this tab" for "this device", and Download for Share. A tab
 * has no camera scanner, so Redeem and Import take pasted text only. The owner-grant words are
 * `owner-grants.ts`'s.
 *
 * Module state, as `machines.svelte.ts` is: the router unmounts the page on every route change,
 * and an export or a grant exists nowhere else, so it has to survive a visit to Home. The store
 * cannot reset this card, since the import and the redemption go through the store, so a read on
 * a node other than the one the card was read on forgets the card first: a join, its rollback
 * and a restart each replace the node.
 *
 * An export's text is the private key, and so is the text pasted into Import; a grant's text
 * makes whoever holds it an owner: log none of them, nor a passphrase. Log a key's fingerprint, a
 * grant's key.
 */

import {
	LOCKED_OWNER_KEY_EXPORT_PREFIX,
	OWNER_KEY_MAX_LABEL,
	OwnerKeyExportError,
	OwnerKeyRemovalRefusedError,
	OwnerKeySlotOccupiedError,
	parseNullableStoredDatetimeMs,
	type CadreInvitationReach,
	type CadreMachine,
	type CadreNode,
	type CadreOwnerKey,
	type ImportedOwnerKey,
	type OwnerGrantStatus,
	type OwnerKeyExportOptions,
	type OwnerKeyRemovalPlan,
	type OwnerKeyRemovalRefusal,
} from '@serfab/cadre-core';
import type { RedeemedOwnerGrant } from '@serfab/cadre-core/edge-node';
import {
	createOwnerGrant,
	exportOwnerKey,
	getCadreNode,
	isOwner,
	listOwnerGrants,
	listOwnerKeys,
	planOwnerKeyRemoval,
	removeOwner,
	withdrawOwnerGrant,
} from './cadre-web.js';
import { importOwnerKey, redeemOwnerGrant } from './store.svelte.js';
import { pushError } from './diagnostics.svelte.js';
import { errorMessage, ownerFingerprint, peerCode } from './cadre-format.js';
import { machineCode, machineKind, refreshMachines } from './machines.svelte.js';
import { describeOwnerGrantFailure, grantFileName, liveGrants, shownGrantTitle } from './owner-grants.js';
import type { Standing } from './add-device.svelte.js';

/** The card's element id, which machine removal's "Go to Owner keys" scrolls to. */
export const OWNER_KEYS_CARD_ID = 'owner-keys';

/** Which part of the card a notice shows under: the list (a removal), the open form, the outstanding grants, Redeem or Import. */
export type NoticeArea = 'list' | 'form' | 'grants' | 'redeem' | 'import';

/** What the last action came to; replaced by the next action's. */
export interface OwnerKeysNotice {
	area: NoticeArea;
	title: string;
	message: string;
	/** A refusal or a failure, rather than an outcome to read. */
	failed: boolean;
}

/** An owner grant just made, the one time its text is shown. */
export interface ShownGrant {
	backup: boolean;
	title: string;
	text: string;
	expiresAtMs: number | null;
	reach: CadreInvitationReach;
	/** What Download saves a backup as. */
	fileName: string;
}

/** What the card shows in place of its buttons: a form, or an export or a grant shown once. */
export type Panel =
	/** `backup`: Make a backup; otherwise Add an owner key. */
	| { kind: 'grant-form'; backup: boolean }
	| { kind: 'grant'; grant: ShownGrant }
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
	/** The live owner grants, latest expiry first ({@link liveGrants}). */
	grants: OwnerGrantStatus[];
	grantsError: string | null;
	panel: Panel | null;
	confirming: PendingRemoval | null;
	/** A grant made or withdrawn, a redemption, an export, an import, a plan read or a removal is running; they run one at a time. */
	busy: boolean;
	notice: OwnerKeysNotice | null;
}

function initialState(): OwnerKeysState {
	return { standing: 'checking', keys: [], listError: null, grants: [], grantsError: null, panel: null, confirming: null, busy: false, notice: null };
}

const state = $state<OwnerKeysState>(initialState());
/** The node the card was last read on. */
let readOn: CadreNode | null = null;

export function ownerKeysState(): OwnerKeysState {
	return state;
}

/**
 * Re-read this tab's owner standing, the cadre's owner keys and its live owner grants from the
 * running node. The keys read, or null when the read failed or the node was replaced meanwhile.
 */
export async function refreshOwnerKeys(): Promise<CadreOwnerKey[] | null> {
	const node = getCadreNode();
	if (!node) return null;
	forgetIfReplaced(node);
	const stale = () => getCadreNode() !== node;
	await readStanding(stale);
	const keys = await readKeys(stale);
	await readGrants(stale);
	return keys;
}

async function readStanding(stale: () => boolean): Promise<void> {
	try {
		const owner = await isOwner();
		if (!stale()) state.standing = owner ? 'owner' : 'member';
	} catch (err) {
		console.warn('[cadre] could not read whether this tab is an owner:', err);
		if (!stale()) state.standing = 'unreadable';
	}
}

async function readKeys(stale: () => boolean): Promise<CadreOwnerKey[] | null> {
	try {
		const keys = await listOwnerKeys();
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

// Read on a member tab too, where the list is hidden: one cheap read, rather than one gated on a standing still being read.
async function readGrants(stale: () => boolean): Promise<void> {
	try {
		const grants = await listOwnerGrants();
		if (stale()) return;
		state.grants = liveGrants(grants);
		state.grantsError = null;
	} catch (err) {
		console.warn('[cadre] could not read this cadre\'s owner grants:', err);
		if (!stale()) state.grantsError = errorMessage(err);
	}
}

/** Re-read the live owner grants alone, after one is made or withdrawn here. */
async function refreshGrants(): Promise<void> {
	const node = getCadreNode();
	if (node) await readGrants(() => getCadreNode() !== node);
}

/** The card's list, forms, export, grant and confirmation belong to the node they were read on; an action still running keeps the card busy. */
function forgetIfReplaced(node: CadreNode): void {
	if (node === readOn) return;
	readOn = node;
	Object.assign(state, initialState(), { busy: state.busy });
}

/** The form for Add an owner key, or for Make a backup. */
export function showGrantForm(backup: boolean): void {
	state.notice = null;
	state.panel = { kind: 'grant-form', backup };
}

/** The export form, its name defaulting to that of the key this tab signs with. */
export function showExportForm(ownKey: CadreOwnerKey): void {
	state.notice = null;
	state.panel = { kind: 'export-form', defaultLabel: ownKey.label ?? '' };
}

/** Close the form, or take the export or the grant off the card: it is not shown again. */
export function closePanel(): void {
	state.panel = null;
	state.notice = null;
}

/**
 * Mint an owner grant under the form's name and show it, the only time its text is shown: a
 * backup is a grant with no expiry, and Add an owner key takes the 15-minute, one-use default.
 */
export async function makeGrant(backup: boolean, label: string): Promise<void> {
	await exclusive(async () => {
		const trimmed = label.trim();
		try {
			const { grant, encoded, reach } = await createOwnerGrant({
				...(trimmed !== '' && { label: trimmed }),
				...(backup && { expiresInMs: null }),
			});
			const row = grant.grant;
			console.info(`[cadre] made ${backup ? 'backup ' : ''}owner grant ${row.key} (reach ${reach})`);
			state.panel = {
				kind: 'grant',
				grant: {
					backup,
					title: shownGrantTitle(backup, row.label),
					text: encoded,
					expiresAtMs: parseNullableStoredDatetimeMs(row.expiresAt),
					reach,
					fileName: grantFileName(row),
				},
			};
		} catch (err) {
			console.warn('[cadre] making an owner grant failed:', err);
			state.notice = failure('form', backup ? 'Could not make a backup' : 'Could not make an owner grant', err);
		}
		await refreshGrants();
	});
}

/** Withdraw an outstanding owner grant (the caller has confirmed), then re-read the grants. */
export async function withdrawGrant(key: string): Promise<void> {
	await exclusive(async () => {
		try {
			const withdrawn = await withdrawOwnerGrant(key);
			console.info(withdrawn ? `[cadre] withdrew owner grant ${key}` : `[cadre] owner grant ${key} was already withdrawn`);
		} catch (err) {
			console.warn(`[cadre] withdrawing owner grant ${key} failed:`, err);
			state.notice = failure('grants', 'Could not withdraw the owner grant', err);
		}
		await refreshGrants();
	});
}

/**
 * Redeem pasted owner-grant text for the key in this tab's owner slot, created when the slot is
 * empty, and say what it came to. True once the redemption went through, so the form clears.
 */
export async function redeemPasted(text: string): Promise<boolean> {
	const redeemed = await exclusive(async () => {
		let result: RedeemedOwnerGrant;
		try {
			result = await redeemOwnerGrant(text);
		} catch (err) {
			// The refusals never carry the grant's text.
			console.warn('[cadre] redeeming an owner grant failed:', err);
			state.notice = failure('redeem', 'Could not redeem the owner grant', err);
			return false;
		}
		console.info(`[cadre] redeemed an owner grant for ${ownerFingerprint(result.ownerKey)} (already an owner ${result.alreadyOwner}, wired ${result.wired})`);
		void refreshMachines();
		// This tab may be an owner now, which decides what the card offers.
		const listed = await refreshOwnerKeys();
		state.notice = { area: 'redeem', failed: false, ...redemptionNotice(result, listed ?? []) };
		return true;
	});
	return redeemed === true;
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
			plan = await planOwnerKeyRemoval(ownerKey.key);
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
	await exclusive(async () => {
		await remove(removal);
		changed();
	});
}

async function remove({ ownerKey, rows, kept }: PendingRemoval): Promise<void> {
	const revouch = revouchOf(rows, new Set(kept));
	const fingerprint = ownerFingerprint(ownerKey.key);
	try {
		const result = await removeOwner(ownerKey.key, { revouch });
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

/** After a key is removed here: the list, the removed key's grants, and which machines Devices and nodes trusts, change. */
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

/** Under this tab's own key: an owner key cannot sign its own removal (`self`). */
export const OWN_KEY_LINE = 'A tab cannot remove its own owner key; use another owner key.';

/** Above an export, the one time it is shown. */
export const EXPORT_WARNING = 'Anyone who has this can control your cadre. Keep it somewhere safe and offline. This tab does not keep a copy.';

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

/** What the export form holds. */
export interface ExportForm {
	label: string;
	/** Protect with a passphrase. */
	locked: boolean;
	passphrase: string;
	/** The passphrase typed again. */
	repeat: string;
}

/** Why a name cannot be used, for the line under its form; null when it can. A blank name is none. */
export function labelProblem(label: string): string | null {
	return label.trim().length > OWNER_KEY_MAX_LABEL ? `A name has at most ${OWNER_KEY_MAX_LABEL} characters.` : null;
}

/** Why the form cannot be sent yet, for the line under it; null when it can. */
export function exportFormProblem(form: ExportForm): string | null {
	const label = labelProblem(form.label);
	if (label) return label;
	if (!form.locked) return null;
	if (form.passphrase === '') return 'Enter a passphrase, or turn off Protect with a passphrase.';
	if (form.passphrase !== form.repeat) return 'The two passphrases do not match.';
	return null;
}

/** The form as `exportOwnerKey` takes it: a blank name is none, and an unlocked export has no passphrase. */
function exportOptions(form: ExportForm): OwnerKeyExportOptions {
	const label = form.label.trim();
	return {
		...(label !== '' && { label }),
		...(form.locked && { passphrase: form.passphrase }),
	};
}

/**
 * What an import came to. `importOwnerKey` answers `wired: false` both for a key that is no owner
 * of this cadre and for one that is, on a node already signing with another key, which takes the
 * imported key at its next start; `listed`, the cadre's owner keys read after the import, tells
 * the two apart.
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

/** The notice after a redemption, naming this tab's key as the list does when the cadre lists it. */
function redemptionNotice(redeemed: RedeemedOwnerGrant, listed: readonly CadreOwnerKey[]): { title: string; message: string } {
	const name = listedKeyName(listed, redeemed.ownerKey);
	if (redeemed.alreadyOwner) {
		return {
			title: 'Already an owner',
			message: `This tab is already an owner of this cadre, with ${name}. The grant was not used: it still works for another device until it expires or is withdrawn.`,
		};
	}
	if (!redeemed.wired) {
		return {
			title: 'Owner grant accepted',
			message: `This tab's key (${name}) is now an owner of this cadre. The tab acts as one once your cadre's records reach it, at the latest from its next start.`,
		};
	}
	return { title: 'Now an owner', message: `This tab is now an owner of this cadre, with ${name}.` };
}

/** What the notice says for an owner grant made, withdrawn or redeemed, an export, an import or a removal that failed. */
function describeOwnerKeyFailure(err: unknown): string {
	const grantLine = describeOwnerGrantFailure(err);
	if (grantLine !== null) return grantLine;
	// The export module's messages are written for the user and never carry key material.
	if (err instanceof OwnerKeyExportError) return err.message;
	if (err instanceof OwnerKeySlotOccupiedError) return SLOT_OCCUPIED_LINE;
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
