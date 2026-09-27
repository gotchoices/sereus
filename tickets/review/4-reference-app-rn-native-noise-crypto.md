description: The React Native reference app now runs its connection encryption in fast native code through the shared kit, with a Settings switch so testers can still fall back to the slow JavaScript version to reproduce old connection drops.
prereq: rn-kit-metro-helper, rn-kit-package-and-native-noise-crypto
architecture: docs/reference-app-rn.md#phone-rn-app-configuration
files: packages/reference-app-rn/package.json, packages/reference-app-rn/app.json, packages/reference-app-rn/src/noise-crypto-config.ts, packages/reference-app-rn/src/phone-node-config.ts, packages/reference-app-rn/src/cadre-phone.ts, packages/reference-app-rn/src/use-cadre.ts, packages/reference-app-rn/app/settings.tsx, packages/reference-app-rn/src/test-ids.ts, packages/reference-app-rn/test/react/use-cadre.spec.ts, packages/reference-app-rn/maestro/_setup.yaml, packages/reference-app-rn/maestro/flows/4-solo-create-strand.yaml, docs/reference-app-rn.md, packages/cadre-rn/README.md, tickets/blocked/report-rn-kit-to-app-projects.md, yarn.lock
----
# The reference app turns native Noise crypto on

## What was built

- **Native modules.** The app's `dependencies` gain `react-native-quick-crypto` `^1.1.7`, `react-native-nitro-modules` `^0.37.1` and `react-native-quick-base64` `^3.0.1`. Versions were checked against React Native 0.79 / Expo 53: quick-crypto's README gives React Native 0.75 as its minimum; nitro 0.37.1's podspec and C++ carry explicit branches for React Native below 0.80 and at or above 0.78; quick-base64 3.x supports Expo 53 with the new architecture on (`app.json` already has it). quick-crypto ships an Expo config plugin, which `expo install` would add, so `"react-native-quick-crypto"` is now in `app.json` `plugins`. On Android it does nothing unless libsodium is enabled; on iOS it raises the pods' deployment target to 16.4. `expo config --type prebuild` resolves and applies it.
- **Mode resolution.** `PhoneNodeOptions.noiseCryptoMode?` (type-only import, so `phone-node-config.ts` stays free of native imports). `PhoneNodeConfigInputs.noiseCrypto?` is passed through as `network.noiseCrypto`. `cadre-phone.ts` resolves `opts.noiseCryptoMode ?? defaultNoiseCryptoMode()` with the kit's `buildNoiseCrypto`.
- **Build default.** New `src/noise-crypto-config.ts`, written in the same style as `relay-config.ts`: `EXPO_PUBLIC_NOISE_CRYPTO` (`off` | `symmetric` | `full`), blank or unset means the kit's `DEFAULT_NOISE_CRYPTO_MODE` (`symmetric`), and any other value throws an error naming the three. It also exports `NOISE_CRYPTO_MODES`, the display order used by Settings.
- **Settings.** A "Connection encryption" choice (three radio-style rows) in the disconnected Node form, after the Relay field's caption, passed to `cadre.start`. The caption says a change is Disconnect → choose → Connect. The connected Node card has an **Encryption** row.
- **Readout source.** `cadre-phone.ts` records the mode it built the node with (`getNoiseCryptoMode()`, cleared on stop), and `use-cadre.ts` holds it in context state the way it holds `ownerPublicKey`: set on `start` and on the background cold-start `ensureNode`, cleared on `stop`. It is not read back from cadre-core. It is a getter rather than being copied from the start options because the hook's React tests cannot load the kit's `noise-crypto` module (it imports quick-crypto), so the hook cannot apply the default itself; the getter also stays right when `startPhoneNode` returns an already-running node.
- **Test IDs.** `settings.noiseCryptoOption(mode)` → `option-noise-crypto-<mode>`, and `settings.noiseCryptoRow` → `row-noise-crypto`. `InfoRow` used to drop `testID` on non-pressable rows; it now puts it on the value text.
- **Maestro.** `_setup.yaml` and `flows/4-solo-create-strand.yaml` now `scrollUntilVisible` `btn-connect` before tapping it. `_setup.yaml`'s earlier NOTE asked for exactly this once the Node form grew. Both flows are shared with the NativeScript app, where the scroll is a no-op.
- **Docs.** `docs/reference-app-rn.md`: the "not wired yet" paragraph is replaced by what is wired, with two tables (the modes, and the two sources: env var and Settings). The network code sample gains `noiseCrypto`. Key Dependencies lists the three modules. The Package Structure tree adds `relay-config.ts` and `noise-crypto-config.ts`. § When Native Rebuild Is Needed names this change. The kit README says the reference app is the worked example.
- **Other app projects.** `tickets/blocked/report-rn-kit-to-app-projects.md` carries the proposed message to sereus-chat and sereus-health. `@serfab/cadre-rn` is not on npm yet (404), so the message says "the next release after 1.5.0". Its claims were checked: the kit's `crypto` shim exports only `createHash`; cadre-core's root entry reaches `fs`, `path` and `http2` only in comments; and the app bundles without aliases for them.

## Validation run

- `yarn lint`: clean. App `typecheck`: clean. App `test`: 20 files, 294 tests pass, `phone-node-config.spec.ts` included.
- `yarn dep-check`: knip exits 0 and reports nothing about the new dependencies or files. Its warning lists are pre-existing and outside this change. `check-dep-ranges` passes.
- Bundle: ran `npx expo export --platform android --source-maps --output-dir dist`, which is `test:bundle`'s export plus source maps, not the script itself. It bundled 4790 modules. The source map holds exactly one path each for `react-native-quick-crypto`, `@craftzdog/react-native-buffer`, `react-native-nitro-modules` and `react-native-quick-base64`, all under `packages/reference-app-rn/node_modules`, and includes `packages/cadre-rn/dist/noise-crypto.js`. So the Metro helper's peer rule sends the kit's import to the app's copy rather than the root dev copy. `dist` was deleted afterwards.

## Use cases to check

- Default build, Settings → Connect: the Node card shows "Encryption: Native, symmetric only".
- Choose "Pure JavaScript" → Connect: `network.noiseCrypto` is `undefined` (stock behaviour) and the card says "Pure JavaScript". Disconnect → "Native, including key exchange" → Connect rebuilds the node in `full`.
- A build with `EXPO_PUBLIC_NOISE_CRYPTO=full` prefills the choice with `full`. `EXPO_PUBLIC_NOISE_CRYPTO=fast` throws `EXPO_PUBLIC_NOISE_CRYPTO is 'fast'; expected one of symmetric, full, off`.

## Tests

No new test, as the ticket specified: resolving the mode is a lookup of three names plus one error, and the wiring is covered by the bundle and by the device run. One existing test double changed: `test/react/use-cadre.spec.ts`'s `cadre-phone` mock gains `getNoiseCryptoMode`, because the hook now imports it.

## Known gaps and judgment calls for the reviewer

- **Nothing native has been compiled or run.** `expo export` bundles JavaScript only. Compiling, linking, and whether each mode stops the connection-monitor drops are for the blocked ticket `rn-native-noise-crypto-device-run`.
- **Old dev clients break.** Nitro throws `ModuleNotFoundError` when it is first evaluated without its native module, and the app imports quick-crypto from its root. So every dev client built before this change fails at launch until it is rebuilt. This comes from reading nitro's source, not from a device; the doc says so.
- **iOS deployment target.** The config plugin raises the iOS pods to 16.4, above Expo 53's default of 15.1. Accepted as what quick-crypto's own Expo setup does. No iOS prebuild was run.
- **Where a bad env value surfaces.** A misspelt `EXPO_PUBLIC_NOISE_CRYPTO` throws inside Settings' `useState` initializer, so the Settings screen fails to render with the message. That is loud, which the ticket asked for, but it is a render error rather than the red line under the Node card. `cadre-phone.ts`'s fallback would surface it as `status: 'error'`, but only for a caller that passes no mode, and Settings always passes one.
- **`EXPO_PUBLIC_*` listing.** The doc had no general list of these variables, only the relay-specific source table. `EXPO_PUBLIC_NOISE_CRYPTO` got its own source table rather than a row in the relay one.
- **Maestro edits are unverified.** No device harness was available, same as the earlier NOTE they replace.
- Noticed, not acted on: the bundle has a second copy of the plain `buffer` package, nested under `whatwg-url-without-unicode`. It is unrelated to quick-crypto's `@craftzdog/react-native-buffer` and was probably already there.
