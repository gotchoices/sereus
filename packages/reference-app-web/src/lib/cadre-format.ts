/**
 * cadre-format.ts — how the Cadre page writes peer ids, key fingerprints, expiry times and
 * errors, shared by its cards.
 */

/**
 * The short form of a peer id that both apps show while one adds the other, so the owner
 * can compare them. Must match the phone app's `shortPeerId`, or the two codes never agree.
 * NOTE: two hand-kept copies of one format; if a third surface (cadre-host's UI) shows the
 * code, move it into cadre-core and import it everywhere.
 */
export function peerCode(peerId: string): string {
	return `${peerId.slice(0, 12)}…${peerId.slice(-6)}`;
}

/**
 * The fingerprint of a machine's public key (base64url): its first 8 characters, which is what
 * cadre-host shows for an owner. Must match the phone app's `ownerFingerprint` (`node-claim.ts`),
 * or an owner comparing the two apps' lists sees different keys.
 */
export function ownerFingerprint(publicKeyB64: string): string {
	return publicKeyB64.slice(0, 8);
}

/** "Valid until 14:32", with the weekday when that is not today, in the browser's own time zone. */
export function validUntilText(expiresAtMs: number | null): string {
	if (expiresAtMs === null) return 'No expiry';
	const at = new Date(expiresAtMs);
	const time = at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
	if (at.toDateString() === new Date().toDateString()) return `Valid until ${time}`;
	return `Valid until ${at.toLocaleDateString([], { weekday: 'short' })} ${time}`;
}

/** An error's own words, for a card's notice. */
export function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
