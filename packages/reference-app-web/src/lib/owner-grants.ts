/**
 * owner-grants.ts — what the Owner keys card says about owner grants (`OwnerKeys.svelte`,
 * `OwnerGrantForm.svelte`, `owner-keys.svelte.ts`): a grant made, listed, redeemed or refused, and
 * the removal prompt's lines for the grants a removed key made (docs/architecture.md → "Owner
 * grants"). No Svelte, so the join card's words (`join-flow.ts`) use the refusals too.
 *
 * A grant's text makes whoever holds it an owner: log the grant's key, never the text.
 */

import {
	OWNER_GRANT_PREFIX,
	OwnerGrantIssuerUnknownError,
	OwnerGrantRejectedError,
	OwnerGrantReplyInvalidError,
	OwnerGrantUnreachableError,
	OwnerKeyAddRefusedError,
	parseNullableStoredDatetimeMs,
	type CadreInvitationReach,
	type OwnerGrantRow,
	type OwnerGrantStatus,
} from '@serfab/cadre-core';
import { ownerFingerprint } from './cadre-format.js';

// NOTE: hand-kept copies of the owner-grant words in the phone app's `owner-keys.ts` and
// `owner-grant-views.tsx`, with "tab" for "device" and "phone", as `owner-keys.svelte.ts`'s are.
// If a third surface (cadre-host's UI) hands out owner grants, move them into cadre-core.

/** The name a backup is offered under. */
export const DEFAULT_BACKUP_LABEL = 'Backup';

/** Said the first time the card names an owner grant. */
export const OWNER_GRANT_MEANING = 'An owner grant is a code that makes the device or app that uses it an owner of this cadre.';

/** Above a backup, the one time it is shown. */
export const BACKUP_WARNING = 'Whoever holds this can become an owner of this cadre until it is used or withdrawn. Keep it like a key: somewhere safe and offline. This tab does not keep a copy.';

/** Under a backup's warning: it is redeemed at a machine of the cadre, which an exported key needs none of. */
export const BACKUP_NEEDS_A_MACHINE = 'It works only while one of this cadre\'s machines can be reached at an address it carries. To keep a copy that works with no network, use Export this tab\'s key.';

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
					? 'No always-on machine of your cadre can answer this backup, so it works only while this tab is open and reachable, and cannot stand in for this tab if its site data is lost. Add an always-on node, then make a new backup.'
					: 'No always-on machine of your cadre can answer this code, so it works only while this tab is open and reachable.',
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

/** Whether pasted text is an owner grant. */
export function isOwnerGrantText(text: string): boolean {
	return text.trim().startsWith(OWNER_GRANT_PREFIX);
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

/**
 * The file a backup is downloaded as: `sereus-owner-grant-‹name›.txt`, its name kept to letters,
 * digits, `-` and `_` so every browser saves it under that name, else the grant's key fingerprint.
 * The grant's key is public; only the text makes its holder an owner.
 */
export function grantFileName(grant: Pick<OwnerGrantRow, 'key' | 'label'>): string {
	const name = (grant.label ?? '').replace(/[^\p{L}\p{N}_-]+/gu, '-').replace(/^-+|-+$/g, '');
	return `sereus-owner-grant-${name || ownerFingerprint(grant.key)}.txt`;
}

/** The removal prompt's lines for the live owner grants the key made (the plan's `grants`): each stops working with it. */
export function grantRemovalLines(grants: readonly OwnerGrantRow[]): string[] {
	return grants.map((grant) => {
		const backup = isBackupGrant(grant);
		if (grant.label === null) return backup ? 'A backup with no name stops working.' : 'An owner grant with no name stops working.';
		return backup ? `Backup "${grant.label}" stops working.` : `The owner grant "${grant.label}" stops working.`;
	});
}

const GRANT_TRY_AGAIN = 'Your cadre could not take the grant right now; try again.';

/**
 * One line per refusal a member, or this tab on its own behalf, answers a redemption with.
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
		return 'This tab does not know the owner who made this grant: that owner key was removed, or its record has not reached this tab yet. Try again shortly.';
	}
	// A redemption's local path refuses `alone` with the add's error; nothing else on the card adds a key.
	if (err instanceof OwnerKeyAddRefusedError) {
		return 'Connect to your cadre and try again: this tab reaches none of its other machines, so they would not learn that it is an owner.';
	}
	return null;
}
