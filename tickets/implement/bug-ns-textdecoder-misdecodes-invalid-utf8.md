description: The NativeScript reference app's stand-in text decoder turns damaged or truncated UTF-8 into wrong characters instead of the replacement character a real decoder gives. Port the corrected decoder the React Native kit already ships, and test both copies against the same inputs so they cannot drift apart again.
architecture: docs/reference-app-ns.md
files: packages/reference-app-ns/src/polyfills/hermes.ts (TextDecoder block ~61-114, structuredClone block ~116-123), packages/reference-app-ns/src/polyfills/text-decoder.ts (new), packages/reference-app-ns/test/polyfills.spec.ts, packages/cadre-rn/polyfills/hermes.js (fixed decoder, lines ~79-215, the source to port), packages/cadre-rn/test/polyfills/hermes-polyfills.spec.ts (decoder input helpers ~375-448, conformance test ~678-686), test-harness/utf8-decoder-inputs.ts (new), docs/reference-app-ns.md (polyfill table, `TextDecoder` row ~212)
repro: verified
----
## The defect

`packages/reference-app-ns/src/polyfills/hermes.ts` installs a `TextDecoder` when the NativeScript runtime has none (V8 on Android, JavaScriptCore on iOS). Its decoder reads continuation bytes without checking them, which is the decoder `@serfab/cadre-rn` shipped before gotchoices/sereus#51. cadre-rn's copy was rewritten then; this one was not.

Reproduced by bundling `hermes.ts` with esbuild, deleting Node's `TextDecoder`, loading the bundle and comparing the installed decoder with Node's native one (code points in hex):

| input bytes | NativeScript stand-in | Node (WHATWG) |
|---|---|---|
| `f0 9f 98` (truncated emoji) | `1f600` (a whole emoji) | `fffd` |
| `e2 41` | `2040` (the `A` swallowed) | `fffd 41` |
| `c0 80` (overlong NUL) | `0` | `fffd fffd` |
| `ff` | `dec0 dc00` (two lone surrogates) | `fffd` |
| `ed a0 80` (encoded surrogate) | `d800` | `fffd fffd fffd` |
| `f0 9f 98 41` | `1f601` | `fffd 41` |
| `61 e2 82` | `61 2080` | `61 fffd` |

Well-formed UTF-8 decodes correctly; only damaged or truncated input is affected. The stand-in also builds its result one character at a time (`str += …`), which cadre-rn replaced with chunked `String.fromCharCode` for speed; port that too, since it comes with the same code.

## The fix

Port cadre-rn's decoder (`packages/cadre-rn/polyfills/hermes.js`, the `TextDecoder` block: `pushString`, `pushAsciiRun`, `pushDecoded`, `decodeUtf8`, `TextDecoderPolyfill`) to TypeScript in a module of its own, `packages/reference-app-ns/src/polyfills/text-decoder.ts`. The module exports the class and installs nothing; `hermes.ts` keeps the `typeof globalThis.TextDecoder === 'undefined'` guard and the `markPolyfilled('TextDecoder')` call and installs the imported class. A separate module lets the test construct the decoder directly, without deleting Node's global and re-evaluating `hermes.ts`.

Keep the behaviour identical to cadre-rn's: UTF-8 only (`RangeError` for any other label), a leading byte-order mark stripped unless `ignoreBOM`, the Encoding Standard's decoder with replacement (one U+FFFD per maximal invalid subpart, and one for a sequence the input ends inside), output built in chunks of 4096 code units. In TypeScript `String.fromCharCode.apply(null, codeUnits)` needs the typed array cast to `number[]`; that is the only expected difference from the JavaScript.

## Testing both copies with the same inputs

The two apps keep separate copies of this decoder (whether they should share one is `decide-shared-runtime-shims-for-phone-apps` in `blocked/`). What stops the copies drifting is that both are checked against Node's native decoder on the same inputs:

- Move cadre-rn's decoder inputs out of `hermes-polyfills.spec.ts` into `test-harness/utf8-decoder-inputs.ts`: `UTF8_BOUNDARY_BYTES`, `seededRandom`, `randomUtf8EdgeBytes`, `decoderInputs` and `describeBytes`. Export `decoderInputs` and `describeBytes`. `test-harness/` is the repo's shared test code, imported by relative path and never built (see `test-harness/package.json`).
- cadre-rn's test `decodes UTF-8 without a TextDecoder, as Node's native one does` imports them from there and is otherwise unchanged. It runs in the `polyfills` Vitest project, which has no stale-build guard; importing a plain TypeScript file from `test-harness/` keeps that true.
- Add the same test to `packages/reference-app-ns/test/polyfills.spec.ts`: construct `TextDecoderPolyfill` from `../src/polyfills/text-decoder`, decode every input with it and with `new TextDecoder()` (Node's), and expect the list of mismatches, described by `describeBytes`, to be empty. This is the reproduction; it fails on the current NativeScript decoder. Update that file's header comment, which says it guards two polyfills.

## structuredClone

cadre-rn's `structuredClone` stand-in copies plain data directly and hands everything else to `@ungap/structured-clone`; NativeScript's hands everything to `@ungap/structured-clone`. That is correct, only slower, and on V8 and JavaScriptCore the cost has not been measured. Do not port the direct-copy path. Record it as a tripwire at the NativeScript `structuredClone` block in `hermes.ts`, e.g. `// NOTE: every clone goes through @ungap/structured-clone; cadre-rn's polyfills/hermes.js copies plain data directly because ungap was several times slower on Hermes (gotchoices/sereus#51). If a NativeScript profile shows ungap taking real time, port that path.`

## Docs

`docs/reference-app-ns.md`, the "Polyfilled on NativeScript" table: the `TextDecoder` row says "hand-rolled UTF-8-only … kept tiny on purpose". Replace it with what the decoder now is, in the words `docs/reference-app-rn.md` uses for its row: UTF-8 only, `RangeError` for any other encoding, invalid input decoded as the Encoding Standard says, one U+FFFD per invalid sequence; the same decoder as cadre-rn's `polyfills/hermes.js`.

## Validation

- `yarn workspace @serfab/reference-app-ns test`. Its global setup runs the stale-build guard over `@serfab/cadre-core`, which reported a stale `dist` when this ticket was researched. cadre-core is in this repo, so `yarn workspace @serfab/cadre-core build` is allowed; if the guard names a sibling repository (`../optimystic`, `../quereus`, `../Fret`) instead, do not build it, and record the block in the review ticket.
- `yarn workspace @serfab/cadre-rn vitest run --project polyfills`.
- `yarn workspace @serfab/reference-app-ns typecheck`, `yarn workspace @serfab/cadre-rn typecheck`, `yarn lint`.

## TODO

- Create `packages/reference-app-ns/src/polyfills/text-decoder.ts` as a TypeScript port of cadre-rn's decoder, exporting `TextDecoderPolyfill`.
- In `hermes.ts`, replace the inline decoder with an install of the imported class under the existing guard; drop the now-unused uses of `toBytes` only if nothing else needs it (the digest shim does).
- Add the `structuredClone` tripwire `NOTE:` in `hermes.ts`.
- Move the decoder input helpers to `test-harness/utf8-decoder-inputs.ts`; import them in cadre-rn's spec.
- Add the conformance test to `packages/reference-app-ns/test/polyfills.spec.ts`; it passes after the port (the old decoder fails it on the inputs in the table above); update the file's header comment.
- Add one line to the cadre-rn `TextDecoder` block in `polyfills/hermes.js` naming the NativeScript copy (`packages/reference-app-ns/src/polyfills/text-decoder.ts`) and the shared test inputs, so a fix to either copy finds the other.
- Update the `TextDecoder` row in `docs/reference-app-ns.md`.
- Run the validation commands above.
