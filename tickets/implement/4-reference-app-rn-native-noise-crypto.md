description: Turn on fast native encryption in the React Native reference app, using the shared kit's adapter, with a Settings switch so testers can still fall back to the slow JavaScript version to reproduce old connection drops.
prereq: rn-kit-metro-helper, rn-kit-package-and-native-noise-crypto
architecture: docs/reference-app-rn.md#phone-rn-app-configuration
files: packages/reference-app-rn/package.json, packages/reference-app-rn/app.json, packages/reference-app-rn/src/cadre-phone.ts, packages/reference-app-rn/src/phone-node-config.ts, packages/reference-app-rn/src/use-cadre.ts, packages/reference-app-rn/src/cadre-context.tsx, packages/reference-app-rn/src/relay-config.ts (pattern), packages/reference-app-rn/app/settings.tsx, packages/reference-app-rn/src/test-ids.ts, docs/reference-app-rn.md, ../sereus-chat/apps/mobile/src/cadre/CadreService.ts (read-only, lines ~400-430 and ~519-550)
----
# The reference app turns native Noise crypto on

Design context: `rn-kit-package-and-native-noise-crypto` (the adapter and its modes). This ticket closes the "Native crypto for Noise (not wired yet)" paragraph in `docs/reference-app-rn.md` § Phone (RN app) Configuration.

## Native modules

Add to the app's `dependencies`: `react-native-quick-crypto` (`^1.1.7`), `react-native-nitro-modules` and `react-native-quick-base64`, which are quick-crypto's own native peers and must be the app's direct dependencies for autolinking. Pick versions whose declared support covers React Native 0.79 and Expo 53: check each package's README or changelog for a minimum React Native version (sereus-chat uses nitro `^0.37.1` on RN 0.82; that does not prove 0.79). quick-crypto 1.x needs the new architecture, and `app.json` already has `"newArchEnabled": true`. Check quick-crypto's Expo instructions for an `app.json` config plugin entry and add it if they call for one. This is a native change, so the app needs a native rebuild; add it to § When Native Rebuild Is Needed.

## Choosing the mode

The mode is read when the node is built, as `relayAddrs` is, so it travels with the start options:

- `PhoneNodeOptions` (`src/phone-node-config.ts`) gains `noiseCryptoMode?: NoiseCryptoMode`. Import it with `import type` so that file stays free of native imports (its Node tests build the same config).
- `PhoneNodeConfigInputs` gains the resolved `noiseCrypto?: NoiseCryptoInterface`, and `buildPhoneNodeConfig` passes it as `network.noiseCrypto`. Resolving the mode to an implementation happens in `cadre-phone.ts`, the file that already does the native wiring: `buildNoiseCrypto(options.noiseCryptoMode ?? defaultNoiseCryptoMode())`.
- The default comes from a build-time `EXPO_PUBLIC_NOISE_CRYPTO` (`off` | `symmetric` | `full`), else the kit's `DEFAULT_NOISE_CRYPTO_MODE` (`symmetric`). Put the reader beside `relay-config.ts` in the same style. An unrecognised value throws an error naming the three allowed values: it is a build misconfiguration, and silently running a different mode would corrupt the measurement the switch exists for.
- **Settings**: a three-way choice in the disconnected Node form, beside the Relay field ("Connection encryption"): native, symmetric only (the default); native, including key exchange (`full`); pure JavaScript (`off`, to reproduce the connection-monitor timeouts of gotchoices/sereus#13). It is passed to `cadre.start` with the other options. The form is shown only while disconnected, so switching modes is Disconnect → choose → Connect, which rebuilds the node; the caption says so. Add test IDs in `src/test-ids.ts`.
- Show the mode the running node was built with on the connected Node card (for example "Encryption: native (symmetric)"), so a device run can confirm what it measured. Keep it in the cadre context state alongside the other start options; do not read it back out of cadre-core.

Carry the start-option field through `use-cadre.ts` / `cadre-context.tsx` exactly as `relayAddrs` is carried. The background wake path has no stored start options today (`backlog/feat-rn-persist-node-start-options`), so there is nothing to add there.

## Tests

No new unit test. The mode resolution is a lookup of three names plus one error, and the wiring is covered by the bundle and by the device run. `phone-node-config.spec.ts` must still pass. Its Node build must not import `@serfab/cadre-rn/noise-crypto` at runtime; type-only imports are fine.

## Edge cases & interactions

- **Mode `off`** passes `undefined`, which is exactly stock behaviour. Verified by inspection of `buildNoiseCrypto`.
- **One copy of quick-crypto in the bundle.** The app now has its own copy and the kit's types-only dev copy sits at the repo root. The Metro helper's peer rule (from `rn-kit-metro-helper`) must make the kit's `dist/noise-crypto.js` resolve the app's copy. Check the exported bundle's source map for a single `react-native-quick-crypto` path (and a single `@craftzdog/react-native-buffer`).
- **The phone talks to nodes without native crypto.** Only local primitives change; the wire protocol does not. No action; it is what makes the default safe to ship.
- **Changing mode while a strand is founding or a host-node request is running.** The choice exists only in the disconnected form (`settings.tsx` renders the Party ID / Relay / Connect form only when not connected), so there is no mid-operation rebuild. Verified by inspection.
- **Native build.** `expo export` bundles JavaScript only and cannot prove the native modules compile or link. That, and whether each mode actually stops the connection-monitor drops, is the blocked device-run ticket `rn-native-noise-crypto-device-run`.

## Docs

- `docs/reference-app-rn.md`: replace the "not wired yet" paragraph with what is wired: the adapter from `@serfab/cadre-rn/noise-crypto`, the three modes and what each replaces, the default, `EXPO_PUBLIC_NOISE_CRYPTO`, the Settings switch, and the Node-card readout. Add the three native modules to § Key Dependencies, and `EXPO_PUBLIC_NOISE_CRYPTO` wherever the doc lists the other `EXPO_PUBLIC_*` variables.
- Kit README: note that the reference app is the worked example.

## Telling the other app projects

sereus-chat and sereus-health keep their own copies until their maintainers switch; changing their code is theirs to do, and both repos are read-only here. Write `tickets/blocked/report-rn-kit-to-app-projects.md`: the category is "dependency outside this repo"; it is unblocked when the maintainer sends the message. The body is the proposed message text:

- `@serfab/cadre-rn` exists, and from which release;
- the three `index.js` imports and the `withCadreMetro` call;
- which of their copied files each subpath replaces;
- for sereus-chat, that its `noise-crypto.ts` now ships as `@serfab/cadre-rn/noise-crypto`, and that its `http2`/`path`/`fs` stubs and `sign()` stub are no longer needed;
- for sereus-health, that this is what its completed ticket `6-full-polyfill-alignment-with-sereus-reference-app` asked for.

Add one line saying that offering the adapter to optimystic (`@optimystic/db-p2p/rn`, as sereus-chat's `STATUS.md` proposes) is a separate later step. Take the release number from the root `package.json` at the time of writing, and write "next release after <version>" if the kit has not shipped yet.

## TODO

- Add the three native modules (and any config plugin); `yarn install`.
- Add `noiseCryptoMode` to the start options, the env reader, the `cadre-phone.ts` resolution, and the `buildPhoneNodeConfig` pass-through.
- Settings switch and Node-card readout, with test IDs.
- Update docs and the kit README.
- Write `tickets/blocked/report-rn-kit-to-app-projects.md`.
- Run `yarn lint`, the app's `typecheck` and `test`, `yarn dep-check`, and `test:bundle`; check the source map for single copies as above, then delete the export output.
