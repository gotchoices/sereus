/**
 * owner-keys.ts — what Settings → "Owner keys" (`owner-keys-section.tsx`, `owner-grant-views.tsx`)
 * shows from `CadreNode.listOwnerKeys`, `listOwnerGrants` and `planOwnerKeyRemoval`, how an owner
 * key is named in a prompt, the forms' checks, what an import or a grant's redemption came to, and
 * the words for each way an owner grant, an export, an import or a removal is refused. No React and
 * no native imports. The browser app copies these words (`reference-app-web`'s `owner-keys.svelte.ts`).
 *
 * An export's text is the private key, and a grant's text makes whoever holds it an owner: never
 * log either, or a passphrase.
 */

import {
	LOCKED_OWNER_KEY_EXPORT_PREFIX,
	OWNER_GRANT_PREFIX,
	OWNER_KEY_EXPORT_STEM,
	OWNER_KEY_MAX_LABEL,
	OwnerGrantIssuerUnknownError,
	OwnerGrantRejectedError,
	OwnerGrantReplyInvalidError,
	OwnerGrantUnreachableError,
	OwnerKeyAddRefusedError,
	OwnerKeyExportError,
	OwnerKeyRemovalRefusedError,
	OwnerKeySlotOccupiedError,
	parseNullableStoredDatetimeMs,
	type CadreInvitationReach,
	type CadreMachine,
	type CadreOwnerKey,
	type ImportedOwnerKey,
	type OwnerGrantRow,
	type OwnerGrantStatus,
	type OwnerKeyExportOptions,
	type OwnerKeyRemovalPlan,
	type OwnerKeyRemovalRefusal,
} from '@serfab/cadre-core';
import type { RedeemedOwnerGrant } from '@serfab/cadre-rn/phone-node';
import { machineCode, machineKind, shortPeerId } from './machines';
import { ownerFingerprint } from './node-claim';

/** The name a backup is offered under. */
export const DEFAULT_BACKUP_LABEL = 'Backup';

/** Under this device's own key: an owner key cannot sign its own removal (`self`). */
export const OWN_KEY_LINE = 'A device cannot remove its own owner key; use another owner key.';

/** Above an export, the one time it is shown. */
export const EXPORT_WARNING = 'Anyone who has this can control your cadre. Keep it somewhere safe and offline. This phone does not keep a copy.';

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

/** A key by its listed row when `keys` has one ("Backup (1a2b3c4d)"), else by its fingerprint alone. */
export function listedKeyName(keys: readonly CadreOwnerKey[], key: string): string {
	const row = keys.find((entry) => entry.key === key);
	return row ? ownerKeyName(row) : ownerFingerprint(key);
}

/** The key this phone signs with, as an approval prompt names it ({@link listedKeyName}); "—" when this phone signs with no key. */
export function signingKeyText(keys: readonly CadreOwnerKey[], signerKey: string | null): string {
	return signerKey === null ? '—' : listedKeyName(keys, signerKey);
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
export function exportOptions(form: ExportForm): OwnerKeyExportOptions {
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
 * the two apart. This app's node signs only with its owner slot's key, so the second case is the
 * kit's contract rather than a state this app reaches.
 */
export type ImportOutcome = 'owner' | 'owner-from-next-start' | 'not-an-owner';

export function importOutcome(imported: ImportedOwnerKey, listed: readonly CadreOwnerKey[]): ImportOutcome {
	if (imported.wired) return 'owner';
	return listed.some((key) => key.key === imported.publicKey) ? 'owner-from-next-start' : 'not-an-owner';
}

/** The alert after an import, naming the key as the list does when the cadre lists it. */
export function importOutcomeAlert(outcome: ImportOutcome, imported: ImportedOwnerKey, listed: readonly CadreOwnerKey[]): { title: string; message: string } {
	const name = listedKeyName(listed, imported.publicKey);
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

/** What the alert says for an owner grant made, withdrawn or redeemed, an export, an import or a removal that failed. */
export function describeOwnerKeyFailure(err: unknown): string {
	const grantLine = describeOwnerGrantFailure(err);
	if (grantLine !== null) return grantLine;
	// The export module's messages are written for the user and never carry key material.
	if (err instanceof OwnerKeyExportError) return err.message;
	if (err instanceof OwnerKeySlotOccupiedError) return SLOT_OCCUPIED_LINE;
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
	const keys = plan.dependents.owners.map((key): DependentRow => ({ kind: 'owner-key', id: key, name: listedKeyName(owners, key) }));
	return [...devices, ...keys];
}

/** What `removeOwner` re-vouches (its `revouch` option): the rows whose Keep switch is on. */
export function revouchOf(rows: readonly DependentRow[], kept: ReadonlySet<string>): { peers: string[]; owners: string[] } {
	const keptIds = (kind: DependentRow['kind']) => rows.filter((row) => row.kind === kind && kept.has(row.id)).map((row) => row.id);
	return { peers: keptIds('device'), owners: keptIds('owner-key') };
}

/** The removal prompt's lines for the live owner grants the key made (the plan's `grants`): each stops working with it. */
export function grantRemovalLines(grants: readonly OwnerGrantRow[]): string[] {
	return grants.map((grant) => {
		const backup = isBackupGrant(grant);
		if (grant.label === null) return backup ? 'A backup with no name stops working.' : 'An owner grant with no name stops working.';
		return backup ? `Backup "${grant.label}" stops working.` : `The owner grant "${grant.label}" stops working.`;
	});
}

// ── Owner grants ────────────────────────────────────────────────────────────

/** Said the first time a screen names an owner grant. */
export const OWNER_GRANT_MEANING = 'An owner grant is a code that makes the device or app that uses it an owner of this cadre.';

/** Above a backup, the one time it is shown. */
export const BACKUP_WARNING = 'Whoever holds this can become an owner of this cadre until it is used or withdrawn. Keep it like a key: somewhere safe and offline. This phone does not keep a copy.';

/** Under a backup's warning: it is redeemed at a machine of the cadre, which an exported key needs none of. */
export const BACKUP_NEEDS_A_MACHINE = 'It works only while one of this cadre\'s machines can be reached at an address it carries. To keep a copy that works with no network, use Export this device\'s key.';

/** Above an owner grant for another device or app, the one time it is shown. */
export const GRANT_WARNING = 'Whoever uses this first becomes an owner of this cadre. Show or send it only to your own device or app.';

/** Where the other device or app takes an owner grant. */
export const GRANT_WHERE_LINE = 'On the other device or app, paste or scan it under Owner keys → Redeem an owner grant. An app that is not part of this cadre yet takes it under Join my existing cadre.';

/** What a minted grant's reach means for whoever redeems it; nothing to add when it is `anywhere`. */
export function grantReachLine(reach: CadreInvitationReach, backup: boolean): { text: string; warning: boolean } | null {
	switch (reach) {
		case 'anywhere':
			return null;
		case 'local-network':
			return { text: 'Your cadre\'s other machines are reachable only on their home network: the device that uses this must be on the same Wi-Fi.', warning: false };
		case 'issuer-only':
			return {
				text: backup
					? 'No always-on machine of your cadre can answer this backup, so it works only while this phone is open and reachable, and cannot stand in for this phone if it is lost. Add an always-on node, then make a new backup.'
					: 'No always-on machine of your cadre can answer this code, so it works only while this phone is open and reachable.',
				warning: true,
			};
	}
}

/** A backup is a grant with no expiry; any other grant is short-lived. */
export function isBackupGrant(grant: Pick<OwnerGrantRow, 'expiresAt'>): boolean {
	return grant.expiresAt === null;
}

/** A listed grant's title: the name the keys it seats will carry, or "Unnamed backup" / "Unnamed grant". */
export function grantTitle(grant: Pick<OwnerGrantRow, 'label' | 'expiresAt'>): string {
	return grant.label ?? (isBackupGrant(grant) ? 'Unnamed backup' : 'Unnamed grant');
}

/** "1 use left", "3 uses left", "No limit on uses". */
export function usesLeftText(totalUses: number | null, usesRecorded: number): string {
	if (totalUses === null) return 'No limit on uses';
	const left = Math.max(totalUses - usesRecorded, 0);
	return left === 1 ? '1 use left' : `${left} uses left`;
}

/** Whether scanned or pasted text is an owner grant. */
export function isOwnerGrantText(text: string): boolean {
	return text.trim().startsWith(OWNER_GRANT_PREFIX);
}

/** The alert after a redemption, naming this device's key as the list does when the cadre lists it. */
export function redemptionAlert(redeemed: RedeemedOwnerGrant, listed: readonly CadreOwnerKey[]): { title: string; message: string } {
	const name = listedKeyName(listed, redeemed.ownerKey);
	if (redeemed.alreadyOwner) {
		return {
			title: 'Already an owner',
			message: `This device is already an owner of this cadre, with ${name}. The grant was not used: it still works for another device until it expires or is withdrawn.`,
		};
	}
	if (!redeemed.wired) {
		return {
			title: 'Owner grant accepted',
			message: `This device's key (${name}) is now an owner of this cadre. The device acts as one once your cadre's records reach it, at the latest from its next start.`,
		};
	}
	return { title: 'Now an owner', message: `This device is now an owner of this cadre, with ${name}.` };
}

const GRANT_TRY_AGAIN = 'Your cadre could not take the grant right now; try again.';

/**
 * One line per refusal a member, or this device on its own behalf, answers a redemption with.
 * Keyed by the error's own `code` type, so a code added to cadre-core fails typecheck here until
 * it has words.
 */
const GRANT_REJECTION_LINE: Record<OwnerGrantRejectedError['code'], string> = {
	'grant-spent': 'This owner grant is expired, withdrawn or used up, or the owner key that made it was removed.',
	'grant-invalid': 'This owner grant is not valid.',
	'party-mismatch': 'This owner grant is for another cadre.',
	'issuer-unknown': 'The machine asked does not know the owner who made this grant yet; try again shortly.',
	busy: GRANT_TRY_AGAIN,
	conflict: GRANT_TRY_AGAIN,
	internal: GRANT_TRY_AGAIN,
	unrecognized: GRANT_TRY_AGAIN,
};

/**
 * What to say about an owner grant's redemption that failed, under Owner keys or in a join; null
 * for an error that is not a redemption's, which the caller words. The decoder's refusal of other
 * text is written for the user and reaches the caller as a plain error.
 */
export function describeOwnerGrantFailure(err: unknown): string | null {
	if (err instanceof OwnerGrantRejectedError) return GRANT_REJECTION_LINE[err.code];
	if (err instanceof OwnerGrantUnreachableError) {
		return 'None of your cadre\'s machines named in this grant could be reached. Connect to the internet, or to your cadre\'s Wi-Fi, and try again.';
	}
	if (err instanceof OwnerGrantReplyInvalidError) return 'A machine answered, but its answer did not verify.';
	if (err instanceof OwnerGrantIssuerUnknownError) {
		return 'This device does not know the owner who made this grant: that owner key was removed, or its record has not reached this device yet. Try again shortly.';
	}
	// A redemption's local path refuses `alone` with the add's error; nothing else on these screens adds a key.
	if (err instanceof OwnerKeyAddRefusedError) {
		return 'Connect to your cadre and try again: this phone reaches none of its other machines, so they would not learn that it is an owner.';
	}
	return null;
}

/** The grants still redeemable, latest expiry first, so backups lead. A row records no creation time. */
export function liveGrants(statuses: readonly OwnerGrantStatus[]): OwnerGrantStatus[] {
	const expiry = (status: OwnerGrantStatus) => parseNullableStoredDatetimeMs(status.grant.expiresAt) ?? Number.MAX_SAFE_INTEGER;
	return statuses.filter((status) => status.live).sort((a, b) => expiry(b) - expiry(a));
}

/** A grant's title the one time it is shown: "Backup", `Backup "Paper"`, "Owner grant", `Owner grant "tablet"`. */
export function shownGrantTitle(backup: boolean, label: string | null): string {
	const kind = backup ? 'Backup' : 'Owner grant';
	return label === null || (backup && label === DEFAULT_BACKUP_LABEL) ? kind : `${kind} "${label}"`;
}
