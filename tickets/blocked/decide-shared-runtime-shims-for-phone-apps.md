description: Decide whether the React Native kit and the NativeScript reference app should share one copy of the text decoder and object-cloning stand-ins they each install, or keep separate copies that a shared test holds to the same behaviour. Today a fix to one copy has to be ported to the other by hand, and once it was not.
files: packages/cadre-rn/polyfills/hermes.js, packages/reference-app-ns/src/polyfills/hermes.ts, packages/reference-app-ns/src/polyfills/text-decoder.ts, test-harness/utf8-decoder-inputs.ts, docs/platforms/nativescript.md, docs/platforms/react-native.md
----

# One copy of the phone runtime stand-ins, or two?

**Blocked category:** the architecture is silent on whether the NativeScript app may depend on code shared with the React Native kit, and where such code would live. **Unblocks with:** the project owner choosing an option below (or editing the recommendation); option A then closes this ticket with a `NOTE:` comment, and B or C become a `plan/` ticket.

## Background

Both phone runtimes lack some web APIs that libp2p and Optimystic read, so each app installs pure-JavaScript stand-ins before any library code loads:

- `@serfab/cadre-rn/polyfills` (`packages/cadre-rn/polyfills/hermes.js`), for React Native's Hermes engine. It is published and used by real apps.
- `packages/reference-app-ns/src/polyfills/hermes.ts`, for NativeScript's V8 (Android) and JavaScriptCore (iOS). It is a private reference app whose purpose is to prove the stack boots on those engines. It started as a hand port of the cadre-rn file.

Two of the stand-ins are the same code in both places: `TextDecoder` (UTF-8 only) and `structuredClone`. When gotchoices/sereus#51 rewrote cadre-rn's decoder to follow the Encoding Standard and its clone to copy plain data directly, the NativeScript copy was not touched, and it went on decoding damaged UTF-8 into wrong characters (`bug-ns-textdecoder-misdecodes-invalid-utf8`). That ticket ports the decoder and moves cadre-rn's conformance inputs into `test-harness/utf8-decoder-inputs.ts`, so both decoders are now tested against Node's native decoder on the same inputs. The clone is not shared or tested in common: NativeScript's sends everything to `@ungap/structured-clone`, which is correct but was several times slower on Hermes; on V8 and JavaScriptCore it has not been measured.

The rest of each file differs by runtime (Hermes needs a random-number source, a `crypto.subtle` with `digest`, web streams; NativeScript already has some of these), so only these two stand-ins are candidates for sharing.

## Options

**A. Keep two copies; the shared test holds the decoders together (recommended).** Nothing new is built. Each copy carries a comment naming the other, and a fix to one is ported to the other by hand; the shared conformance inputs fail the NativeScript suite if a decoder fix is not ported.
- Cheapest, and fully reversible: B or C can be done later with nothing to undo.
- The clone stays unshared and untested in common. That matters only if the clone gains a behaviour change rather than a speed change; NativeScript's ungap path is the reference behaviour the cadre-rn copy is tested against, so it cannot be less correct.
- Revisit when a third app needs these stand-ins, when NativeScript gets a published kit of its own, or when a second fix has to be ported.

**B. A small dependency-free workspace package holds both, as `@serfab/config-check` does for config checking.** For example `@serfab/runtime-shims`, exporting `TextDecoderPolyfill` and a `structuredClone` function, installing nothing; cadre-rn's `hermes.js` and NativeScript's `hermes.ts` import and install them.
- Removes the duplication for good, and NativeScript gets the faster clone for free.
- A new published package: release configuration, a dependency every React Native app using the kit picks up, and a build that cadre-rn's `polyfills` test project (deliberately free of the stale-build guard) would then load from `dist`, unless the package is plain JavaScript like `polyfills/` itself.
- More machinery than about 250 lines used by two consumers, one of them a private reference app.

**C. A subpath of `@serfab/cadre-core` (for example `@serfab/cadre-core/runtime-shims`).** Both apps already depend on cadre-core.
- No new package.
- Puts engine stand-ins in the peer-to-peer library, whose job they are not, and ties cadre-rn's polyfill tests to cadre-core's build being fresh.

**Rejected: the NativeScript app imports from `@serfab/cadre-rn`.** The kit is React Native's; depending on it brings `react-native`, Expo and native-module peer dependencies into a NativeScript app.

## If nothing is decided

The state after `bug-ns-textdecoder-misdecodes-invalid-utf8` is option A without the decision written down: the decoders are held together by the shared test, and the next reviewer may raise the duplication again.
