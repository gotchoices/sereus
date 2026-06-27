/*
 * NativeScript-safe replacement for libp2p's `user-agent.js`.
 *
 * libp2p's `libp2p.js` imports `./user-agent.js` by *relative* path, so the
 * package's react-native/browser export conditions never apply and webpack
 * bundles the node variant. That variant computes
 * `process.versions.node.replaceAll('v', '')`, but the NS V8/JSC `process`
 * polyfill has no `versions.node`, so it throws
 * "Cannot read properties of undefined (reading 'replaceAll')" inside the
 * Libp2p constructor (control-node creation → Connect fails). The react-native
 * variant is no better — it needs the RN `Platform` module, absent here.
 *
 * The platform suffix is only a cosmetic, peer-facing `agentVersion`, so emit a
 * static NativeScript tag while preserving the caller-supplied name/version
 * (libp2p calls `userAgent(nodeInfoName, nodeInfoVersion)`).
 *
 * Wired up by the `libp2p-user-agent-shim` NormalModuleReplacementPlugin in
 * webpack.config.js, which redirects every libp2p copy's `./user-agent.js`.
 */
export function userAgent(name, version) {
	return `${name ?? 'js-libp2p'}/${version ?? '0.0.0'} nativescript`;
}
