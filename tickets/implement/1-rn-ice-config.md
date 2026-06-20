----
description: Give the phone app a tiny helper that fetches the list of STUN/TURN servers at startup, so the WebRTC work in the next ticket has ICE settings to hand to the connection. A direct port of the web app's proven helper, adapted to React Native (no browser localStorage / build-time globals).
prereq:
files: packages/reference-app-rn/src/ice-config.ts, packages/reference-app-rn/test/ice-config.spec.ts, packages/reference-app-web/src/lib/ice-config.ts, packages/reference-app-rn/package.json
difficulty: easy
----

## Goal

Port the proven web ICE-config helper (`packages/reference-app-web/src/lib/ice-config.ts`,
shipped + reviewed under completed ticket `webrtc-stun-turn-infrastructure`) to React
Native as `packages/reference-app-rn/src/ice-config.ts`. This is the **signaling-config
input** the next ticket (`rn-webrtc-transport`) feeds into the WebRTC transport's
`rtcConfiguration.iceServers`. Splitting it out here keeps it landable and unit-tested
**without** any native module — it is pure TypeScript over `fetch`.

## Why a separate file (not import the web one)

`reference-app-web/src/lib/ice-config.ts` is deliberately framework-free but still binds two
**browser-only** touch-points the RN runtime does not have:

- `import.meta.env.VITE_ICE_CONFIG_URL` — Vite build-time env. RN/Expo has no `import.meta.env`;
  the analog is `process.env.EXPO_PUBLIC_*` (Expo inlines `EXPO_PUBLIC_`-prefixed vars into the
  Hermes bundle at build time).
- `localStorage` — absent in RN.
- The `RTCIceServer` DOM type — the RN tsconfig (`expo/tsconfig.base`) does **not** include the
  `dom` lib, so `RTCIceServer` is not in scope. Define a local structural `IceServer` type instead
  (matches the W3C shape: `urls`, optional `username`, `credential`). The next ticket maps it onto
  react-native-webrtc's config type at the transport call site.

These differences are small but real, so a sibling file (mirroring how `connection-path.ts` is
duplicated between web and cadre-core, see `packages/cadre-core/src/diagnostics/connection-path.ts`)
is the right call. Keep the function names, validation logic, never-throws contract, and the 5 s
fetch timeout **identical** to the web file so the two stay diff-able.

## Interface (mirror the web file, RN-adapted)

```ts
/** Local structural ICE-server shape (no `dom` lib in RN). W3C RTCIceServer subset. */
export interface IceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

export interface IceConfigManifest {
  iceServers: IceServer[];
  turnPolicy?: 'off' | 'gated' | 'on';
  generatedAt?: string;
}

export const exampleIceConfigManifest: IceConfigManifest; // mirror the web fixture

/** explicit arg → process.env.EXPO_PUBLIC_ICE_CONFIG_URL → undefined */
export function resolveIceConfigUrl(explicit?: string): string | undefined;
export function parseIceServers(data: unknown): IceServer[];
/** Never throws; returns [] on any failure. 5 s AbortController deadline. */
export function loadIceConfig(url?: string): Promise<IceServer[]>;
```

Behavioural contract carried over verbatim from the web file:

- **Never throws.** Any failure (no URL, network error, non-OK HTTP, malformed/non-object
  body, timeout) logs a warning and returns `[]` (STUN-less but safe; peers fall back to the
  libp2p relay). No third-party STUN fallback — privacy-preserving default.
- **Strict-but-lenient parse.** Top level must carry an `iceServers` array; individual
  malformed entries are dropped (warn) rather than failing the whole load. Only the known
  optional string fields (`username`, `credential`) are carried over — no `any` passthrough.
- **5 s fetch deadline** via `AbortController` + `clearTimeout` in `finally`. `loadIceConfig`
  is awaited on the node-start path in the next ticket, so an unbounded fetch against a hung
  manifest host must not stall boot.

### Source resolution in RN

`fetch` is a global in RN — no import. The build-time URL comes from
`process.env.EXPO_PUBLIC_ICE_CONFIG_URL` (read it as `string | undefined`, guard for empty).
Do **not** reach for `localStorage` (absent) or `expo-constants` here — keep the file
dependency-free. A runtime per-device override seam (e.g. SecureStore/AsyncStorage) is **out of
scope**; if a debug override is wanted later, file it separately. Document the single env var in a
file header comment the way the web file documents `VITE_ICE_CONFIG_URL`.

## Tests (vitest — agent-runnable, this is the validation floor)

`reference-app-rn` already runs vitest (`yarn workspace @serfab/reference-app-rn test`). Add
`packages/reference-app-rn/test/ice-config.spec.ts` mirroring the web coverage. Stub `globalThis.fetch`
per-case. Key cases and expected outputs:

- no URL configured (env unset, no arg) → `[]`, no fetch attempted.
- happy path: fetch returns `exampleIceConfigManifest` JSON → returns its `iceServers`.
- explicit-arg URL beats env; env used when no arg.
- non-OK HTTP (e.g. 500) → `[]`.
- `fetch` rejects (network throw) → `[]` (does not throw).
- body is a non-object / `iceServers` not an array → `[]`.
- one malformed entry among valid ones (e.g. `{ urls: 123 }`) → dropped, valid ones kept.
- entry with `username`/`credential` strings → carried through; non-string optional fields dropped.
- timeout: a `fetch` that never resolves (or honours the abort `signal`) → resolves to `[]`
  within the deadline. Drive deterministically with vitest fake timers (`vi.useFakeTimers()`),
  asserting the AbortController fired — do **not** wall-clock-wait 5 s.

`parseIceServers` and `resolveIceConfigUrl` are exported, so unit-test them directly too (no
fetch needed). Restore `globalThis.fetch` / real timers in `afterEach`.

## Edge cases & interactions

- **No `dom` lib.** Confirm `yarn workspace @serfab/reference-app-rn typecheck` passes — the
  local `IceServer` type (not `RTCIceServer`) is what makes this compile. Do not add `dom` to the
  RN tsconfig `lib` (it would mask RN/Hermes-vs-browser API drift elsewhere).
- **`process.env` under Hermes.** Only `EXPO_PUBLIC_`-prefixed vars are inlined; a bare
  `process.env.ICE_CONFIG_URL` reads `undefined` in a release bundle. Use the `EXPO_PUBLIC_` name.
- **`AbortController` availability.** Present in Hermes/RN 0.79; no polyfill needed (libp2p
  already relies on it — see `polyfills/hermes.js` patching `AbortSignal.prototype.throwIfAborted`).
  Do not assume `AbortSignal.timeout` exists; use the explicit `AbortController` + `setTimeout`
  pattern from the web file.
- **Empty vs whitespace URL.** `resolveIceConfigUrl` must treat `''` (and an env var set to empty)
  as "not configured", same as the web `length > 0` guards.
- **JSON content-type leniency.** Mirror the web file: send `accept: application/json` but parse
  `res.json()` regardless; a server returning `text/plain` JSON still parses.
- **No secrets logged.** TURN `credential`s may appear in a manifest; the warn-paths log the URL
  and error, never the parsed server entries' credentials.

## TODO

- Create `packages/reference-app-rn/src/ice-config.ts` porting the web helper: local `IceServer`
  type, `EXPO_PUBLIC_ICE_CONFIG_URL` resolution, `resolveIceConfigUrl` / `parseIceServers` /
  `loadIceConfig`, 5 s abort deadline, never-throws contract, header doc comment.
- Add `packages/reference-app-rn/test/ice-config.spec.ts` covering the cases above with stubbed
  `fetch` and fake timers.
- Run `yarn workspace @serfab/reference-app-rn typecheck` and
  `yarn workspace @serfab/reference-app-rn test` — both green.
- Hand off to `rn-webrtc-transport` (it consumes `loadIceConfig`).
