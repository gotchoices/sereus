description: Phone apps spend much of their processor time hashing data in slow pure-JavaScript code; the shared kit could use the phone's native hashing when available, which in one app freed close to half the time the app's code ran.
architecture: docs/reference-app-rn.md#polyfills
files: packages/cadre-rn/polyfills/hermes.js, packages/cadre-rn/metro/index.cjs, packages/cadre-rn/test/polyfills/
----
# Native SHA-256/512 behind `crypto.subtle.digest`

`polyfills/hermes.js` defines `crypto.subtle.digest` with `@noble/hashes`. multiformats' browser
`sha256` goes through it, and Optimystic hashes every block (`canonicalBlockHash`) with it. A Hermes
CPU profile of sereus-chat put **47% of all JS time** in that digest. The JS thread was blocked for
up to 43 s at a stretch, and two-phone messages took minutes, against about 1 s in Node.

sereus-chat now routes SHA-256/512 through react-native-quick-crypto's synchronous `createHash`. It
checks the result against the "abc" test vector first, keeps noble as the fallback, and warns when
the fallback is used. On a Galaxy S7, `reserveRelays` went from 18 s to 6.6 s. The loop's blocked
share fell from about 13% to 4–9%. Chat's version is the last block of
`apps/mobile/polyfills/hermes.js`.

## Expectation

The kit's polyfill uses quick-crypto when the app has it installed and noble otherwise.
quick-crypto is an optional peer, so the polyfill must not require it. Metro resolves `require` at
bundle time, so this needs Metro's optional-dependency support (`allowOptionalDependencies`, set by
`withCadreMetro`) or an equivalent, tested in both directions.
