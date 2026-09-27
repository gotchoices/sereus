// `@serfab/cadre-rn/boot-check`: development-build diagnostics that act at import time.
// Both do nothing in a release build.
//
// The app imports this after every polyfill (`@serfab/cadre-rn/polyfills`, and
// `/polyfills/webrtc` if used) and before its own entry (`expo-router/entry` in the
// reference app). That position is the point:
// - audit.js prints the native / polyfilled / gap / MISSING table. A call in the entry
//   module's own body would run only after all of its imports had evaluated, the app tree
//   included, so an import-time crash caused by a missing global would beat the table to
//   the log. Imported here, the table prints first.
// - reload-reason.js logs `[reload] <reason>` before any reload started from JavaScript.
//   Installed before the app tree evaluates, it also covers a reload triggered while that
//   happens.
import './audit';
import './reload-reason';
