description: The NativeScript reference app carries its own copy of the old text-decoding stand-in, which turns damaged or truncated UTF-8 into wrong characters instead of the replacement character a real decoder gives. The React Native kit's copy was fixed; this one was not.
architecture: docs/reference-app-ns.md
files: packages/reference-app-ns/src/polyfills/hermes.ts (TextDecoder block ~61-114, structuredClone block ~116-123), packages/cadre-rn/polyfills/hermes.js (the fixed decoder and clone, for reference), packages/cadre-rn/test/polyfills/hermes-polyfills.spec.ts (`decoderInputs`, the conformance vectors)
repro: static
severity: wrong-result
likelihood: unusual
tradeoffs: Well-formed storage and peers never produce invalid UTF-8, and NativeScript's V8 builds strings one character at a time quickly, so only damaged input is affected; a maintainer may prefer to wait until the NativeScript app is in active use.
----
`packages/reference-app-ns/src/polyfills/hermes.ts` is a hand port of `packages/cadre-rn/polyfills/hermes.js`. Its `TextDecoder` is the decoder cadre-rn shipped before gotchoices/sereus#51: it reads continuation bytes without checking them. A truncated `F0 9F 98` decodes as a whole emoji, `E2 41` swallows the `A`, `C0 80` becomes NUL, and a lone `FF` becomes two surrogates. The WHATWG decoder returns U+FFFD in each case.

Evidence: the code is the same, line for line, as the old cadre-rn decoder, and that decoder fails the conformance test added in `hermes-polyfills.spec.ts` (`decodes UTF-8 without a TextDecoder, as Node's native one does`). Running the NativeScript copy against the same inputs would confirm it.

## Expected behaviour

- The NativeScript `TextDecoder` stand-in matches the WHATWG UTF-8 decoder with replacement, as cadre-rn's now does.
- Whether its `structuredClone` stand-in also gets cadre-rn's direct-copy path is a second, optional arm. It matters only if a profile on NativeScript (V8 on Android, JavaScriptCore on iOS) shows `@ungap/structured-clone` taking real time.

The root cause is that the two apps keep separate hand-maintained copies of the same pure-JavaScript stand-ins, so a fix to one is not a fix to the other. Sharing the code (for example, the NativeScript app importing the decoder and clone from one module) would stop the next fix from needing a second port; whether the NativeScript app may depend on that module is the planning question.
