// `@serfab/cadre-rn/polyfills`: the web APIs libp2p and the Optimystic stack read that
// Hermes and React Native do not provide.
//
// The app imports this module first, before anything else in its entry file. libp2p and
// its dependencies read these globals while their modules evaluate, so a library module
// evaluated earlier has already captured `undefined`. After it, the app imports
// `@serfab/cadre-rn/polyfills/webrtc` (only if it uses @libp2p/webrtc), then
// `@serfab/cadre-rn/boot-check`, then its own code.
//
// hermes.js comes first: its first statement sets `process.env.DEBUG` before any copy of
// `debug` loads, and it installs `crypto.getRandomValues`, which key generation and the
// WebRTC DTLS handshake need.
import './hermes';
import './intl-pluralrules';
import './event';
