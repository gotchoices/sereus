/**
 * The listen addresses an edge app offers, for `EdgeNodePlatform.listenAddrs`.
 */

/**
 * `['/webrtc']` when the node has a relay, `[]` otherwise: the `EdgeNodePlatform.listenAddrs` of
 * any app whose transports carry WebRTC (a browser tab, a phone). A `/webrtc` listener binds no
 * socket — it registers the signalling handler and derives its address from the relay reservation,
 * so without a relay there is no signalling path and the app keeps the solo posture of accepting
 * nothing. Advertising the address is what lets another machine open a direct connection *to* this
 * one; cadre-core adds the bare `/p2p-circuit` entry for the relay itself
 * (`relay-addrs.ts` → `resolveListenAddrs`).
 */
export function webrtcListenAddrs(relayAddrs: readonly string[]): string[] {
	return relayAddrs.length > 0 ? ['/webrtc'] : [];
}
