/**
 * cadre-format.ts — how the Cadre page writes peer ids and expiry times, shared by its cards.
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

/** "Valid until 14:32", with the weekday when that is not today, in the browser's own time zone. */
export function validUntilText(expiresAtMs: number | null): string {
	if (expiresAtMs === null) return 'No expiry';
	const at = new Date(expiresAtMs);
	const time = at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
	if (at.toDateString() === new Date().toDateString()) return `Valid until ${time}`;
	return `Valid until ${at.toLocaleDateString([], { weekday: 'short' })} ${time}`;
}
