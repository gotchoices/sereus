// react-native-webrtc globals for libp2p's WebRTC transport.
// Must be imported before any libp2p / app code (same discipline as
// polyfills/hermes.js).
//
// Metro resolves @libp2p/webrtc to its `browser` variant (see metro.config.js),
// and that variant reads the WebRTC engine off the GLOBAL surface —
// `webrtc/index.browser.js` does `export const RTCPeerConnection =
// globalThis.RTCPeerConnection` (likewise RTCSessionDescription / RTCIceCandidate),
// and the dialer creates its data channel via `peerConnection.createDataChannel`.
// react-native-webrtc's `registerGlobals()` installs exactly that native surface
// (RTCPeerConnection / RTCSessionDescription / RTCIceCandidate / RTCDataChannel /
// …) onto `global`.
//
// Ordering is load-bearing: if @libp2p/webrtc's module graph evaluates before
// these globals exist, the transport factory captures `undefined` for
// RTCPeerConnection and either throws at construction or silently never upgrades
// a relayed connection to direct. index.js therefore imports this polyfill after
// ./polyfills/hermes (which installs crypto.getRandomValues, needed by the DTLS
// handshake) and before expo-router/entry (which mounts the React tree that pulls
// in cadre-phone.ts → @libp2p/webrtc).
//
// NOTE: requires a native rebuild (EAS Build / expo run:*) to link the
// react-native-webrtc native module — this app is already prebuild-only
// (expo-dev-client), so it does not regress Expo Go support (never had it).
// Media (camera/mic) is unused — Sereus uses data channels only.
import { registerGlobals } from 'react-native-webrtc';

registerGlobals();
