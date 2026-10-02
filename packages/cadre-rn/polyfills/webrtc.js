// `@serfab/cadre-rn/polyfills/webrtc`: react-native-webrtc globals for libp2p's WebRTC
// transport, for apps that use @libp2p/webrtc. The app imports it right after
// `@serfab/cadre-rn/polyfills` and before any libp2p or app code.
//
// The app's Metro configuration resolves @libp2p/webrtc's private-to-public modules
// (WebRTC direct) to their `browser` variants (the reference app's metro.config.js says
// why), and those read the WebRTC engine off the GLOBAL surface:
// `get-rtcpeerconnection.browser.js` calls a bare `new RTCPeerConnection(…)`.
// react-native-webrtc's `registerGlobals()` installs exactly that native surface
// (RTCPeerConnection / RTCSessionDescription / RTCIceCandidate / RTCDataChannel /
// …) onto `global`. Its `webrtc/index.js`, used by the relayed-connection upgrade,
// resolves to the `react-native` variant instead, which imports the same classes from
// react-native-webrtc directly (both checked in the reference app's Android export,
// 2026-09-26). So this module and @libp2p/webrtc must resolve one copy of
// react-native-webrtc, the app's: two copies would each number their peer connections
// from zero. The app's Metro configuration resolves this kit's peer dependencies from
// the app for that reason.
//
// Load it before the app's own code (in the reference app, expo-router/entry mounts
// the React tree that pulls in cadre-phone.ts → @libp2p/webrtc), so the globals exist
// before anything can dial.
//
// Of the other polyfills it needs only hermes.js's crypto.getRandomValues (the DTLS
// handshake). It now loads after the whole `/polyfills` entry, where the reference app
// used to load it between hermes.js and the Intl.PluralRules / EventTarget patches. One
// thing differs as a result: react-native-webrtc's own copy of event-target-shim checks
// for a global Event and EventTarget when it loads and, when they exist, chains its
// classes' prototypes onto theirs. Neither React Native 0.79 nor Expo 53 installs them,
// so it used to find none; now it finds event-target-polyfill's (installed by event.js).
// That is the shim's ordinary browser behaviour.
//
// NOTE: the app must list react-native-webrtc as its own dependency (React Native
// autolinks only an app's direct dependencies), and needs a native rebuild (EAS Build /
// expo run:*) to link it; Expo Go cannot load it. Media (camera/mic) is unused — Sereus
// uses data channels only.
import { registerGlobals } from 'react-native-webrtc';
import { markPolyfilled } from './registry';

registerGlobals();
// Unconditional: registerGlobals() overwrites whatever was there, so the audit should
// never call the WebRTC surface native.
markPolyfilled('RTCPeerConnection');
