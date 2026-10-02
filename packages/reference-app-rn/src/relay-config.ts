/**
 * relay-config.ts — resolve the circuit-relay multiaddr(s) this phone reserves a
 * slot on, so it has an address other people can dial.
 *
 * A React Native app cannot open a listener, so without a relay the node has no
 * multiaddr at all: `CadreNode.getMultiaddrs()` is empty, and the app refuses to
 * mint an invitation, since the phone runs the strand it invites to and a joiner
 * must reach it (`use-cadre.ts`). Handing out an invitation therefore REQUIRES a relay.
 * Everything else (founding and reading local strands, dialling out to a drone or a
 * borrowed cadre-host node, joining someone else's invitation) works without one.
 *
 * The resolved list goes into `network.relayAddrs` (`phone-node-config.ts`), not
 * through `CadreNode.reserveRelays()`: only the config field reaches STRAND nodes,
 * and formation needs the invitee to dial the strand nodes as well as the control
 * node. cadre-core turns it into a bare `/p2p-circuit` search listener plus a
 * reservation supervisor per relay (`cadre-core/src/relay-addrs.ts`).
 *
 * React Native port of `reference-app-web/src/lib/relay-config.ts`: it resolves
 * deployment-specific infrastructure at runtime rather than baking it into the
 * bundle. Three platform touch-points differ from the web copy:
 *
 *  - Build-time env var: `EXPO_PUBLIC_RELAY_ADDR` (Expo inlines `EXPO_PUBLIC_`-prefixed
 *    vars into the Hermes bundle at build time). The Vite counterpart is `VITE_RELAY_ADDR`.
 *  - `localStorage` is absent in RN, so the web copy's per-device override branch is
 *    omitted. The per-device seam here
 *    is the Settings screen's "Relay" field, which passes its value as `explicit`.
 *  - The list a node started with is saved with the other start options
 *    (`start-options.ts`) and is what the next launch starts with and prefills. It is
 *    saved RESOLVED, so a remembered list wins over a later build's
 *    `EXPO_PUBLIC_RELAY_ADDR`: to pick up a new build default, Disconnect, clear the
 *    Relay field (empty means "build default", below) and Connect. The env var is what
 *    makes a fresh install work with no typing.
 *
 * Framework-free by design: no `@serfab/cadre-core`, no native imports, no
 * validation. A malformed entry is cadre-core's to reject — `relayCircuitAddrs`
 * throws at config resolution naming the field, which is what surfaces a typo on the
 * Settings screen — the node goes to `status: 'error'` and the message renders under
 * the Node card — rather than as a node that silently came up unreachable.
 */

/** Read the build-time relay addrs (`EXPO_PUBLIC_RELAY_ADDR`, comma-separated). */
function envRelayAddrs(): string[] {
	const raw = process.env.EXPO_PUBLIC_RELAY_ADDR;
	return typeof raw === 'string' ? splitRelayAddrs(raw) : [];
}

/**
 * Split a comma-separated list into trimmed, non-empty multiaddrs. Exported because
 * the Settings screen parses its "Relay" and "Bootstrap addr" text fields with exactly
 * this rule — one spelling of "what counts as a list", so a typed value, a saved list
 * and a build-time default cannot disagree about blanks or spacing. A multiaddr never
 * contains a comma.
 */
export function splitRelayAddrs(raw: string): string[] {
	return raw
		.split(',')
		.map((s) => s.trim())
		.filter((s) => s.length > 0);
}

/**
 * Resolve the relay multiaddr(s): explicit arg → env (`EXPO_PUBLIC_RELAY_ADDR`) →
 * none. An explicit non-empty list always wins, so a value typed into Settings
 * overrides the build-time default rather than being merged with it.
 *
 * `[]` means no relay is configured, which is a supported posture: the node starts,
 * works offline, and refuses only to mint invitations. Never throws.
 */
export function resolveRelayAddrs(explicit?: string[]): string[] {
	if (explicit && explicit.length > 0) return explicit;
	return envRelayAddrs();
}
