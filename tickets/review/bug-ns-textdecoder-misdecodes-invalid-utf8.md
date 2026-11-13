description: The NativeScript reference app's stand-in text decoder turned damaged or truncated UTF-8 into wrong characters instead of the replacement character a real decoder gives. It now uses a port of the corrected decoder the React Native kit ships, and both copies are tested against Node's decoder on the same inputs.
architecture: docs/reference-app-ns.md
files: packages/reference-app-ns/src/polyfills/text-decoder.ts (new), packages/reference-app-ns/src/polyfills/hermes.ts, packages/reference-app-ns/test/polyfills.spec.ts, test-harness/utf8-decoder-inputs.ts (new), packages/cadre-rn/test/polyfills/hermes-polyfills.spec.ts, packages/cadre-rn/polyfills/hermes.js, docs/reference-app-ns.md
repro: verified
----
## What changed

- `packages/reference-app-ns/src/polyfills/text-decoder.ts` (new): a TypeScript port of the `TextDecoder` block in `packages/cadre-rn/polyfills/hermes.js` — `pushString`, `pushAsciiRun`, `pushDecoded`, `decodeUtf8`, and the exported `TextDecoderPolyfill` class. It installs nothing. Behaviour is meant to be identical to cadre-rn's: UTF-8 only (`RangeError` for any other label), leading byte-order mark stripped (`ignoreBOM` is fixed `false`, as in cadre-rn), the Encoding Standard's decoder with replacement, output flushed in chunks of 4096 code units through one shared `Uint16Array`.
- `hermes.ts`: the inline decoder is gone; the `typeof globalThis.TextDecoder === 'undefined'` guard now installs the imported class and calls `markPolyfilled('TextDecoder')` as before. `toBytes` stays, because the digest shim uses it.
- `hermes.ts`, `structuredClone` block: a `NOTE:` tripwire saying every clone goes through `@ungap/structured-clone`, unlike cadre-rn's direct-copy path, and to port that path if a NativeScript profile shows ungap taking real time. The direct-copy path was not ported.
- `test-harness/utf8-decoder-inputs.ts` (new): cadre-rn's decoder inputs moved out of `hermes-polyfills.spec.ts` unchanged (`UTF8_BOUNDARY_BYTES`, `seededRandom`, `randomUtf8EdgeBytes`, `decoderInputs`, `describeBytes`), exporting `decoderInputs` and `describeBytes`. One change: `describeBytes` builds its hex string with `Array.from(…).join('')` instead of `Buffer.from(…).toString('hex')`, so the module uses no Node globals and imports nothing.
- `hermes-polyfills.spec.ts` (cadre-rn) imports the two helpers from there; its test is otherwise unchanged.
- `cadre-rn/polyfills/hermes.js`: a comment in the `TextDecoder` block naming the NativeScript copy and the shared inputs.
- `docs/reference-app-ns.md`: the `TextDecoder` row in "Polyfilled on NativeScript" now describes the decoder in the same terms as the cadre-rn row in `docs/reference-app-rn.md`.

## Tests

- Added `TextDecoder polyfill › decodes UTF-8 as Node's native TextDecoder does` in `packages/reference-app-ns/test/polyfills.spec.ts`: decodes every input from `decoderInputs()` with `TextDecoderPolyfill` and with Node's `TextDecoder`, and expects the list of mismatches to be empty. This is the reproduction. Checked against the old decoder (taken from `HEAD` and bundled with esbuild in a scratch directory, since deleted): 3,691 mismatches, the first being `efbb`, `c080`, `c1bf`, `e08080`, `e09fbf`. The port: 0.
- cadre-rn's existing conformance test now reads the same inputs from `test-harness/`.

## Validation run

- `yarn workspace @serfab/reference-app-ns typecheck` — pass.
- `yarn workspace @serfab/cadre-rn typecheck` — pass.
- `yarn workspace @serfab/cadre-rn vitest run --project polyfills` — 3 files, 33 tests pass.
- `yarn workspace @serfab/reference-app-ns test` — the stale-build guard first reported `@serfab/cadre-core` stale; after `yarn workspace @serfab/cadre-core build`, 7 files, 72 tests pass.
- `yarn lint` — exit 0.

## Points for the reviewer

- `decode` takes `AllowSharedBufferSource | null` (not `BufferSource`, as the old class did) because TypeScript 5.9 types `BufferSource` as views over `ArrayBuffer` only, so a plain `Uint8Array` from the test inputs did not type-check; `AllowSharedBufferSource` is what the DOM lib's own `TextDecoder.decode` accepts.
- `String.fromCharCode.apply(null, codeUnits as unknown as number[])` is the one TypeScript-forced difference from the JavaScript, as the ticket expected; lint does not flag it.
- The byte conversion in `decode` is an inline ternary copied from cadre-rn, which overlaps with `toBytes` in `hermes.ts`. I kept them separate so `text-decoder.ts` has no dependency on the module that installs globals.
- Not run: `test:bundle` (webpack bundle check) and on-device runs. The change adds one ordinary relative import to `hermes.ts`, so I expect the bundle to be unaffected, but that is not verified.
