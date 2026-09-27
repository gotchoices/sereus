description: The phone apps built on Sereus (sereus-chat and sereus-health) still carry their own copies of code this repo now ships as a shared React Native package; someone needs to tell their maintainers the package exists and what it replaces, because those repositories are not ours to change.
architecture: packages/cadre-rn/README.md
files: packages/cadre-rn/README.md, packages/cadre-rn/package.json, packages/reference-app-rn/index.js, packages/reference-app-rn/metro.config.js, docs/reference-app-rn.md
difficulty: easy
----
# Tell the other app projects about `@serfab/cadre-rn`

**Blocked on:** a dependency outside this repo. sereus-chat and sereus-health are separate repositories with their own maintainers, and both are read-only from here. It is unblocked when a maintainer of this repo sends the message below to those two projects (as an issue or a direct message) and records here where it was sent.

## Before sending

- The package has not been published yet: `npm view @serfab/cadre-rn` returns 404, and the root `package.json` is at 1.5.0. The message says "the next release after 1.5.0" in two places (the opening paragraph and the cadre-core version sereus-chat must adopt the kit on); replace both with the real version once `yarn release` has published it (it publishes `@serfab/cadre-rn` last, after the other five packages, all at one version).
- The native crypto has not been run on a phone yet (blocked ticket `rn-native-noise-crypto-device-run`). If that run has happened, add its result to the message; if it found problems, hold the message's noise-crypto part until they are fixed.

## Proposed message

> **Subject: `@serfab/cadre-rn` replaces your copied polyfills, shims, Metro setup and Noise crypto adapter**
>
> Sereus now ships the React Native pieces your app copied from its reference app as a package, `@serfab/cadre-rn`, first published in the next release after 1.5.0. Every entry point is a subpath (there is no root import), so an app installs only the native modules for the parts it uses. The package README has the details: https://github.com/gotchoices/sereus/tree/master/packages/cadre-rn
>
> **Entry file.** Replace your polyfill imports at the top of `index.js` with these, in this order, before anything else:
>
> ```js
> import '@serfab/cadre-rn/polyfills';          // first
> import '@serfab/cadre-rn/polyfills/webrtc';   // only if the app uses @libp2p/webrtc
> import '@serfab/cadre-rn/boot-check';         // after every polyfill, before the app
> ```
>
> Your own `./src/debug-bootstrap` import can stay first; it sets `process.env.DEBUG` and does not touch the globals the polyfills patch.
>
> **Metro.** Your `metro.config.js` becomes one call around the config React Native produced:
>
> ```js
> const { getDefaultConfig } = require('@react-native/metro-config');
> const { withCadreMetro } = require('@serfab/cadre-rn/metro');
>
> module.exports = withCadreMetro(getDefaultConfig(__dirname), { projectRoot: __dirname });
> ```
>
> Pass `linkedRoots` only for local checkouts linked into the app (your local-stack mode); omit it when everything comes from npm. It keeps anything your config already sets.
>
> **What each subpath replaces.**
>
> | Subpath | sereus-chat (`apps/mobile`) | sereus-health (`apps/mobile`) |
> |---|---|---|
> | `/polyfills` | `polyfills/hermes.js`, `polyfills/intl-pluralrules.js`, `polyfills/event.js`, `polyfills/registry.js` | `polyfills/hermes.js`, `polyfills/intl-pluralrules.js`, `polyfills/event.js` |
> | `/boot-check` | `polyfills/audit.js` (the kit's also logs a `[reload] <reason>` line before any reload started from JavaScript) | nothing yet; new for you |
> | `/metro` | `shims/node-os.js`, `shims/node-crypto.js`, `shims/empty.js`, and the Node built-in aliases and `resolveRequest` in `metro.config.js` | `polyfills/node-os.js`, `polyfills/node-crypto.js`, `polyfills/empty.js`, and the same parts of `metro.config.js` |
> | `/noise-crypto` | `src/cadre/noise-crypto.ts` | nothing yet; new for you |
>
> **sereus-chat specifically.** Your `noise-crypto.ts` now ships as `@serfab/cadre-rn/noise-crypto`, with the same `buildNoiseCrypto(mode)`, `NoiseCryptoMode` and `DEFAULT_NOISE_CRYPTO_MODE` (`symmetric`). Your `http2`, `path` and `fs` stubs are no longer needed: current cadre-core keeps its Node-only push notifiers behind `@serfab/cadre-core/push-node` and its file helpers behind a subpath React Native never imports. Your `crypto.sign()` stub is no longer needed for the same reason; the kit's `crypto` shim has `createHash` only.
>
> **Upgrade cadre-core with the kit.** Your `sign()` stub dates from cadre-core 0.8.x, when the FCM notifier was in cadre-core's root import graph. Push moved behind `@serfab/cadre-core/push-node` in 0.9.0, so the 1.4.0 your app now uses no longer reaches it, and the kit's shim drops the stub. Adopt the kit together with `@serfab/cadre-core` at the kit's own version or later: the next release after 1.5.0 (every Sereus package ships at one version, and that is the cadre-core the kit is built and tested with).
>
> **Your resolver settings stay.** Keep package exports on, your condition lists with `import` ahead of `require`, the `.qsql` extensions and your transformer, and pass the merged config to `withCadreMetro`. The `@babel/runtime` branch of your `resolveRequest` can go: the kit does that redirect. The kit's tests run Metro's own resolver with your condition lists and check that the `@babel/runtime` redirect and the `@libp2p/crypto` browser rewrite still apply under them.
>
> **sereus-health specifically.** This is the shared module your completed ticket `6-full-polyfill-alignment-with-sereus-reference-app` asked for. The kit uses the packages that ticket listed (`react-native-get-random-values`, `@ungap/structured-clone`, `web-streams-polyfill`, `@noble/hashes`) and the `event-target-polyfill` package for `EventTarget`, which settles its convergence question.
>
> **Native modules your app must list.** React Native links native code only for an app's direct dependencies: `react-native-get-random-values` for `/polyfills`; `react-native-webrtc` for `/polyfills/webrtc`; and `react-native-quick-crypto` (`^1.1.7`), `react-native-nitro-modules` (`>=0.31.2`) and `react-native-quick-base64` (`>=3.0.0`) for `/noise-crypto`, which also needs React Native's new architecture. All are optional peer dependencies of the kit, so skip the ones for subpaths you do not import.
>
> Sereus's own reference app (`packages/reference-app-rn`) is the worked example of all four subpaths, including a Settings switch between the three Noise crypto modes.

Offering the Noise crypto adapter to optimystic itself (as `@optimystic/db-p2p/rn`, which sereus-chat's `design/specs/mobile/STATUS.md` proposes) is a separate, later step, not part of this message.
