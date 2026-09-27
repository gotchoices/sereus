description: The React Native reference app now runs its connection encryption in fast native code through the shared kit, with a Settings switch so testers can still fall back to the slow JavaScript version to reproduce old connection drops.
prereq: rn-kit-metro-helper, rn-kit-package-and-native-noise-crypto
architecture: docs/reference-app-rn.md#phone-rn-app-configuration
files: packages/reference-app-rn/package.json, packages/reference-app-rn/app.json, packages/reference-app-rn/src/noise-crypto-config.ts, packages/reference-app-rn/src/phone-node-config.ts, packages/reference-app-rn/src/cadre-phone.ts, packages/reference-app-rn/src/use-cadre.ts, packages/reference-app-rn/app/settings.tsx, packages/reference-app-rn/src/test-ids.ts, packages/reference-app-rn/test/react/use-cadre.spec.ts, packages/reference-app-rn/test/global-setup.ts, packages/reference-app-rn/maestro/_setup.yaml, packages/reference-app-rn/maestro/flows/4-solo-create-strand.yaml, docs/reference-app-rn.md, packages/cadre-rn/README.md, tickets/blocked/report-rn-kit-to-app-projects.md, yarn.lock
----
# The reference app turns native Noise crypto on

## What was built

- The app depends on `react-native-quick-crypto` `^1.1.7`, `react-native-nitro-modules` `^0.37.1` and `react-native-quick-base64` `^3.0.1`, and lists quick-crypto's Expo config plugin in `app.json` (it raises the iOS pods' deployment target to 16.4).
- `PhoneNodeOptions.noiseCryptoMode?` (`off` | `symmetric` | `full`) is a start option. `cadre-phone.ts` resolves it (falling back to `defaultNoiseCryptoMode()`), builds the implementation with the kit's `buildNoiseCrypto`, and passes it through `buildPhoneNodeConfig` as `network.noiseCrypto`. `phone-node-config.ts` imports only the mode's type, so its Node tests do not load quick-crypto.
- `src/noise-crypto-config.ts` reads the build default from `EXPO_PUBLIC_NOISE_CRYPTO`: blank or unset means the kit's `symmetric`, any other unknown value throws an error naming the three.
- Settings has a "Connection encryption" choice in the disconnected Node form, and the connected Node card has an **Encryption** row showing the mode the running node was built with (`getNoiseCryptoMode()` in `cadre-phone.ts`, held in `use-cadre.ts` state like `ownerPublicKey`).
- Maestro `_setup.yaml` and `flows/4-solo-create-strand.yaml` scroll to `btn-connect` before tapping it.
- `docs/reference-app-rn.md` describes the modes, both ways of setting them, the new dependencies and the native rebuild; the kit README points at the app as the worked example.
- `tickets/blocked/report-rn-kit-to-app-projects.md` holds the proposed message telling sereus-chat and sereus-health about the kit.

Validation at implement: lint and typecheck clean, 294 app tests pass, `yarn dep-check` clean, and an `expo export` Android bundle resolved quick-crypto and its peers once each, from the app's own `node_modules`. Nothing native has been compiled or run; that is blocked ticket `rn-native-noise-crypto-device-run`.

## Review findings

Read the implement diff (`3a4ea038`) before the handoff, then `cadre-phone.ts` (start/stop), `use-cadre.ts` (start, cold-start `ensureNode`, stop), `settings.tsx`, the kit's `noise-crypto.ts` and README, `test/global-setup.ts`, the blocked report ticket, and every doc that mentions `noiseCrypto`/`noise-crypto` (`docs/reference-app-rn.md`, `docs/architecture.md`, `docs/testing.md`).

**Fixed in this pass (minor):**
- `getNoiseCryptoMode()` returned the recorded mode after a failed start: `nodeNoiseCryptoMode` is set before `await node.start()`, and a throwing start leaves the (not running) node in place without going through `stopPhoneNode`. The field's doc claimed "Null while no node is running", which was false in that case. The getter now gates on `node?.isRunning`, the same as `getOwnerPublicKey()` beside it, and the field's doc says why. It had no visible effect today (the hook only reads it after a successful start, and the card only renders while connected), so no test was added.
- `test/global-setup.ts` said no spec loads `@serfab/cadre-rn/noise-crypto` "once src/ imports that"; `src/` now does. The comment now says why it is still not loaded (quick-crypto cannot run under Node; specs reach `cadre-phone.ts` only through a mock, checked by grep).
- `docs/reference-app-rn.md` placed the encryption choice "beside **Relay**"; it renders below the Relay field's caption. Wording corrected.

**Checked, nothing found:**
- Mode flow: Settings passes its choice to `cadre.start`; `optsRef` keeps it, so the background cold start (`ensureNode`) rebuilds with the same mode. `startPhoneNode`'s early return for a running node keeps the old mode, and the getter reports the old mode too, so the readout matches what is running.
- Resource cleanup: the mode is cleared in `stopPhoneNode` before the stop, following the existing `node` ordering; nothing native is held by the mode itself.
- Error path: a misspelt `EXPO_PUBLIC_NOISE_CRYPTO` throws from Settings' lazy `useState` initializer. That is a render error rather than the red status line, which the handoff already names; it is a build misconfiguration and the ticket asked for it to be loud, so left as is.
- `InfoRow` now puts `testID` on the value text for non-pressable rows instead of dropping it. The only other row that passes a `testID` is Owner Key, which is pressable while a key exists; before a key exists its ID now lands on the "—" text instead of vanishing, which is harmless (checked every `InfoRow` use in `settings.tsx`).
- Type safety: no `any`; `NOISE_CRYPTO_LABEL` is `Record<NoiseCryptoMode, string>`, so a new kit mode fails typecheck at the labels.
- DRY: the mode list `NOISE_CRYPTO_MODES` is app-side display order; the kit has no list to reuse. Not exhaustiveness-checked against the type, but the label record above catches a new mode at compile time in the same screen, so no change.
- Blocked report ticket: correctly in `blocked/` (the recipients are outside this repo); its install list matches the kit README.
- `docs/architecture.md` §1603 describes the kit generically and stays accurate.

**Tests:** no tests added or removed. The one changed test double (`getNoiseCryptoMode` in the `cadre-phone` mock of `use-cadre.spec.ts`) exists only because the hook imports it; it is wiring, not a behaviour test, and costs one line. The mode resolution is a three-name lookup plus one error and does not meet the bar for its own test.

**Tripwires / tickets:** none filed. The unverified parts (native compile, device behaviour per mode, the Maestro scroll step, the old-dev-client `ModuleNotFoundError`, the iOS 16.4 deployment target) are already tracked by blocked ticket `rn-native-noise-crypto-device-run` and named in the docs.

**Validation after fixes:** `yarn lint` clean; `@serfab/reference-app-rn` typecheck clean; app tests 20 files, 294 tests pass.
