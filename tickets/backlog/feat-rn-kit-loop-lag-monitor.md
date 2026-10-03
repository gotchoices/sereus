description: A development-only monitor that reports how often a phone app's main thread was blocked, which found sereus-chat's worst performance problem, could ship in the shared kit for every phone app.
files: packages/cadre-rn/polyfills/boot-check.js, packages/cadre-rn/
----
# A development-build loop-lag monitor

sereus-chat's `apps/mobile/src/diagnostics/loop-lag.ts` reports, every 30 s, the worst timer
lateness and the share of time the JS loop was blocked. It found chat's 47%-of-JS-time digest cost
(`feat-rn-kit-native-digest`), and costs nothing in release builds.

## Expectation

A development-build-only subpath beside `/boot-check`, off in release builds, logging in the same
style as the polyfill audit.
