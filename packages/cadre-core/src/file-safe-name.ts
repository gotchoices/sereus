/**
 * The filename-safe encoding of an id, shared by every Node-only file store that keys a file on
 * a party or key id (`<name>.<encoded id>.json`). A pure string function, so it lives outside
 * `fs-atomic.ts` and is exported from the cross-platform entry: an embedder that keeps its own
 * per-party file beside cadre-core's (cadre-cli's removal marker) names it the same way.
 */

/**
 * Percent-encode a string into a filesystem-safe filename component. Beyond
 * `encodeURIComponent` (which already escapes `/`, spaces, and unicode), this
 * also escapes the unreserved characters `encodeURIComponent` leaves intact but
 * that are unsafe in filenames on some platforms (notably `*` on Windows) — and
 * `.`, so a file suffix appended by the caller is the only literal dot, making
 * suffix-stripping unambiguous — and every uppercase letter, because Windows
 * (NTFS) and macOS (APFS/HFS+ by default) ignore case in file names. Reversed by
 * `decodeURIComponent`.
 *
 * The result contains only `a-z0-9-_` and `%XX` escapes (uppercase hex). Since a
 * literal `%` is itself escaped, every `%` starts an escape, so ignoring case
 * can change only escape hex digits — which decode case-insensitively — and two
 * different inputs never yield names equal ignoring case. The escapes keep
 * `encodeURIComponent`'s uppercase hex so a name built from an id with no
 * capital letters (the identity slot `cadre%2Fidentity.key`, a lowercase party
 * id) is the same as before uppercase letters were escaped.
 */
export function encodeFileSafeComponent(component: string): string {
	// NOTE: a file left from before uppercase letters were escaped (`trusted-owners.Alice.json`) has, ignoring case, the new name of the all-lowercase id (`alice`), so on Windows/macOS a lookup for that id opens it; the per-party records' envelope party-id check rejects it (cold start), and `FileKeyStore` needs two parties in one key directory whose ids fold to the same lowercase string. The release note says to delete old files; if a store ever reads another id's old file in practice, rename or remove old-format files when the store opens.
	return encodeURIComponent(component).replace(
		/(%[0-9A-F]{2})|[!'()*~.A-Z]/g,
		(c, escape: string | undefined) => escape ?? `%${c.charCodeAt(0).toString(16).toUpperCase()}`
	);
}
