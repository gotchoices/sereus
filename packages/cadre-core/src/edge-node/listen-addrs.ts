/**
 * The listen addresses an edge app offers, for `EdgeNodePlatform.listenAddrs`.
 */

import { WEBRTC_LISTEN_ADDR } from '../relay-addrs.js';

/**
 * `['/webrtc']` when the node has a relay, `[]` otherwise: the `EdgeNodePlatform.listenAddrs` of
 * any app whose transports carry WebRTC (a browser tab, a phone). A `/webrtc` listener binds no
 * socket — it registers the signalling handler and derives its address from the relay reservation,
 * so without a relay there is no signalling path and the app keeps the solo posture of accepting
 * nothing. Advertising the address is what lets another machine open a direct connection *to* this
 * one; cadre-core adds the bare `/p2p-circuit` entry for the relay itself
 * (`relay-addrs.ts` → `resolveListenAddrs`).
 *
 * NOTE: pairing this with a WebRTC transport is a CONVENTION, not a structure — an app that
 * passes `webRTC()` in `EdgeNodePlatform.transports` and forgets this one silently stays
 * relay-only, which is the defect `phone-listens-on-webrtc` fixed in the phone app. It cannot
 * be derived: transport factories are opaque, which is why `resolveTransportOptions`
 * (`relay-addrs.ts`) returns `{}` whenever an embedder supplies them. Both edge apps in this
 * repo pass both; if a third appears, or the omission is seen again, give the platform one
 * declarative WebRTC switch that sets the transport and the listen address together.
 */
export function webrtcListenAddrs(relayAddrs: readonly string[]): string[] {
	return relayAddrs.length > 0 ? [WEBRTC_LISTEN_ADDR] : [];
}
