// Must be the first import: every later module may read these globals at load time.
import '@serfab/cadre-rn/polyfills';
// Native Ed25519 and SHA-256/512 behind crypto.subtle; before any libp2p import, because
// @libp2p/crypto chooses WebCrypto or pure-JS Ed25519 once, when it loads.
import '@serfab/cadre-rn/polyfills/native-crypto';
// WebRTC globals for @libp2p/webrtc; before any libp2p or app code.
import '@serfab/cadre-rn/polyfills/webrtc';
// Development-build audit table and reload logger; after every polyfill, before the app.
import '@serfab/cadre-rn/boot-check';

// Hand off to Expo Router's standard entry.
import 'expo-router/entry';

// Define + register the background notification task in entry-module scope.
// expo-task-manager reloads this bundle in the background and re-evaluates the
// module to execute the task, so the task MUST be defined here (an early-required
// entry module) rather than inside a React component. Order relative to the
// expo-router import is irrelevant — the task only needs to be defined by the time
// bundle evaluation finishes, before TaskManager looks it up.
import { registerStrandWakeTask } from './src/push-wake-native';
registerStrandWakeTask();
