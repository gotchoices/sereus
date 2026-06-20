// Polyfills must run before any library code.
import './polyfills/hermes';
// WebRTC globals (react-native-webrtc registerGlobals) — after hermes (DTLS needs
// crypto.getRandomValues) and before expo-router/entry mounts cadre-phone.ts →
// @libp2p/webrtc. See polyfills/webrtc.js for why the order is load-bearing.
import './polyfills/webrtc';
import './polyfills/intl-pluralrules';
import './polyfills/event';

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
