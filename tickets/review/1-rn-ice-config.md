----
description: Review the RN ICE-config helper — a pure-TypeScript port of the web helper that fetches STUN/TURN server lists at startup for the upcoming WebRTC transport ticket.
files: packages/reference-app-rn/src/ice-config.ts, packages/reference-app-rn/test/ice-config.spec.ts
----

## What was built

`packages/reference-app-rn/src/ice-config.ts` — a React Native port of
`packages/reference-app-web/src/lib/ice-config.ts`, adapted for:

- **Env var**: `EXPO_PUBLIC_ICE_CONFIG_URL` (Expo build-time inline) instead of `import.meta.env.VITE_ICE_CONFIG_URL`
- **No `localStorage`**: the per-device override seam is dropped; explicit arg → env var → none
- **Local `IceServer` type**: avoids depending on the `dom` lib (not in `expo/tsconfig.base`)
- **`fetch` as global**: no import; `AbortController` + `setTimeout` pattern (not `AbortSignal.timeout`)

All logic is identical to the web file: `resolveIceConfigUrl`, `parseIceServers`, `loadIceConfig`, `exampleIceConfigManifest`, 5 s abort deadline, strict-but-lenient parse, never-throws contract.

## Test coverage

`packages/reference-app-rn/test/ice-config.spec.ts` — 20 new tests added (all `node` project, no native modules):

- `resolveIceConfigUrl`: explicit arg beats env, env used when no arg, empty string treated as not-configured
- `parseIceServers`: fixture roundtrip, non-object / non-array body, malformed entry dropped, valid entries kept, username/credential carried through, non-string optional fields dropped, string and string[] urls
- `loadIceConfig`: no URL → no fetch → `[]`; happy path; explicit beats env; env used; non-OK HTTP → `[]`; network throw → `[]`; non-object body → `[]`; non-array iceServers → `[]`; partial parse (malformed + valid mixed); timeout with fake timers (AbortController fires, resolves to `[]`); credentials not logged in warn paths

`yarn workspace @serfab/reference-app-rn typecheck` — clean (0 errors).
`yarn workspace @serfab/reference-app-rn test` — 7 files, 123 tests, all green.

## Known gaps / reviewer notes

- No `localStorage`-style runtime override is provided. If a debug/per-device override seam is wanted in future, it should be filed separately (the ticket explicitly calls it out of scope).
- The `IceServer` type is a structural W3C subset; `rn-webrtc-transport` will map it onto `react-native-webrtc`'s config type at the call site.
- No `ICE_CONFIG_URL_STORAGE_KEY` export (the web file's `localStorage` key constant) — intentionally omitted since there is no storage to key.

## Review findings

<!-- to be filled in by the reviewer -->
