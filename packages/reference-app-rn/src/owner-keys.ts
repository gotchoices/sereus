/**
 * owner-keys.ts — what Settings → "Owner keys" (`owner-keys-section.tsx`) shows from
 * `CadreNode.listOwnerKeys` and `planOwnerKeyRemoval`, how an owner key is named in a prompt, the
 * export form's check, what an import came to, and the words for each way a backup, an export, an
 * import or a removal is refused. No React and no native imports.
 *
 * An export's text is the private key: never log it, or a passphrase.
 */

import {
	LOCKED_OWNER_KEY_EXPORT_PREFIX,
	OWNER_KEY_EXPORT_STEM,
	OWNER_KEY_MAX_LABEL,
	OwnerKeyAddRefusedError,
	OwnerKeyExportError,
	OwnerKeyRemovalRefusedError,
	OwnerKeySlotOccupiedError,
	type CadreMachine,
	type CadreOwnerKey,
	type ImportedOwnerKey,
	type OwnerKeyAddRefusal,
	type OwnerKeyExportOptions,
	type OwnerKeyRemovalPlan,
	type OwnerKeyRemovalRefusal,
} from '@serfab/cadre-core';
import { machineCode, machineKind, shortPeerId } from './machines';
import { ownerFingerprint } from './node-claim';

/** The name a backup key is offered under. */
export const DEFAULT_BACKUP_LABEL = 'Backup';

/** Under this device's own key: an owner key cannot sign its own removal (`self`). */
export const OWN_KEY_LINE = 'A device cannot remove its own owner key; use another owner key.';

/** Above an export, the one time it is shown. */
export const EXPORT_WARNING = 'Anyone who has this can control your cadre. Keep it somewhere safe and offline. This phone does not keep a copy.';

const ALONE_LINE = 'Connect to your cadre first; a new owner key made now would not reach your other machines.';

const ADD_REFUSAL_LINE: Record<OwnerKeyAddRefusal, string> = {
	alone: ALONE_LINE,
};

/** Why a removal cannot go ahead: in the prompt from the plan, and in the alert when `removeOwner` refuses. */
export const REMOVAL_REFUSAL_LINE: Record<OwnerKeyRemovalRefusal, string> = {
	'not-an-owner': 'Only an owner can remove owner keys, and this device is not one.',
	unknown: 'This key is no longer an owner of this cadre.',
	'last-owner': 'It cannot be removed: it is the only owner key of this cadre.',
	self: OWN_KEY_LINE,
	alone: 'Connect to your cadre first; the owner keys you keep would not reach your other machines.',
};

const SLOT_OCCUPIED_LINE = 'This phone already holds a different owner key, and a phone holds one. This key was not imported.';

/** A scanner's line for an owner key's export in view where an invitation or a join request is asked for. */
export const OWNER_KEY_SCANNED_LINE = 'That is an owner key, which is private. Import it only under Owner keys.';

/** Whether scanned or pasted text is an owner key's export, plain or locked, of any version. */
export function isOwnerKeyText(text: string): boolean {
	return text.trim().startsWith(OWNER_KEY_EXPORT_STEM);
}

/** Whether owner-key text is a locked export, which asks for its passphrase. */
export function isLockedOwnerKeyText(text: string): boolean {
	return text.trim().startsWith(LOCKED_OWNER_KEY_EXPORT_PREFIX);
}

/** A listed key's title: the name it was added under, or "Unnamed key". */
export function ownerKeyTitle(key: Pick<CadreOwnerKey, 'label'>): string {
	return key.label ?? 'Unnamed key';
}

/** "Backup (1a2b3c4d)", for a prompt or an alert. */
export function ownerKeyName(key: Pick<CadreOwnerKey, 'key' | 'label'>): string {
	return `${ownerKeyTitle(key)} (${ownerFingerprint(key.key)})`;
}

/** The line under a listed key's title: its fingerprint, and "This device" on the key this phone signs with. */
export function ownerKeyFacts(key: CadreOwnerKey): string {
	return key.heldHere ? `${ownerFingerprint(key.key)} · This device` : ownerFingerprint(key.key);
}

/**
 * The key this phone signs with, as an approval prompt names it: by its listed row when there is
 * one, else by its fingerprint alone. "—" when this phone signs with no key.
 */
export function signingKeyText(keys: readonly CadreOwnerKey[], signerKey: string | null): string {
	if (signerKey === null) return '—';
	const row = keys.find((key) => key.key === signerKey);
	return row ? ownerKeyName(row) : ownerFingerprint(signerKey);
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
export function exportOptions(form: ExportForm): OwnerKeyExportOptions {
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
export type ImportOutcome = 'owner' | 'owner-from-next-start' | 'not-an-owner';

export function importOutcome(imported: ImportedOwnerKey, listed: readonly CadreOwnerKey[]): ImportOutcome {
	if (imported.wired) return 'owner';
	return listed.some((key) => key.key === imported.publicKey) ? 'owner-from-next-start' : 'not-an-owner';
}

/** The alert after an import, naming the key as the list does when the cadre lists it. */
export function importOutcomeAlert(outcome: ImportOutcome, imported: ImportedOwnerKey, listed: readonly CadreOwnerKey[]): { title: string; message: string } {
	const row = listed.find((key) => key.key === imported.publicKey);
	const name = row ? ownerKeyName(row) : ownerFingerprint(imported.publicKey);
	switch (outcome) {
		case 'owner':
			return { title: 'Owner key imported', message: `This device is now an owner of this cadre, with ${name}.` };
		case 'owner-from-next-start':
			return {
				title: 'Owner key imported',
				message: `${name} is an owner of this cadre. This device already signs with another owner key, so it uses ${name} from the next time it starts.`,
			};
		case 'not-an-owner':
			return {
				title: 'Not an owner of this cadre',
				message: `This key is not an owner of this cadre. An owner can add it. This phone keeps it (${name}), and signs with it from the next time it starts after an owner has added it.`,
			};
	}
}

/** What the alert says for a backup, an export, an import or a removal that failed. */
export function describeOwnerKeyFailure(err: unknown): string {
	// The export module's messages are written for the user and never carry key material.
	if (err instanceof OwnerKeyExportError) return err.message;
	if (err instanceof OwnerKeySlotOccupiedError) return SLOT_OCCUPIED_LINE;
	if (err instanceof OwnerKeyAddRefusedError) return ADD_REFUSAL_LINE[err.code];
	if (err instanceof OwnerKeyRemovalRefusedError) return REMOVAL_REFUSAL_LINE[err.code];
	return err instanceof Error ? err.message : String(err);
}

/** One Keep switch in the removal prompt: a device or an owner key the removed key added. */
export interface DependentRow {
	kind: 'device' | 'owner-key';
	/** A device's peer id, an owner key's key: what `removeOwner`'s `revouch` names. */
	id: string;
	name: string;
}

/**
 * The plan's dependents as Keep switches, devices first: a device named as Devices and nodes names
 * it (else by its peer id), an owner key by its name and fingerprint (else the fingerprint alone).
 */
export function dependentRows(plan: OwnerKeyRemovalPlan, owners: readonly CadreOwnerKey[], machines: readonly CadreMachine[]): DependentRow[] {
	const devices = plan.dependents.peers.map((peerId): DependentRow => {
		const machine = machines.find((entry) => entry.peerId === peerId);
		return { kind: 'device', id: peerId, name: machine ? `${machineKind(machine)} ${machineCode(machine)}` : shortPeerId(peerId) };
	});
	const keys = plan.dependents.owners.map((key): DependentRow => {
		const row = owners.find((entry) => entry.key === key);
		return { kind: 'owner-key', id: key, name: row ? ownerKeyName(row) : ownerFingerprint(key) };
	});
	return [...devices, ...keys];
}

/** What `removeOwner` re-vouches (its `revouch` option): the rows whose Keep switch is on. */
export function revouchOf(rows: readonly DependentRow[], kept: ReadonlySet<string>): { peers: string[]; owners: string[] } {
	const keptIds = (kind: DependentRow['kind']) => rows.filter((row) => row.kind === kind && kept.has(row.id)).map((row) => row.id);
	return { peers: keptIds('device'), owners: keptIds('owner-key') };
}
