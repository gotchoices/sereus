description: A NativeScript reference chat app (@serfab/reference-app-ns) validating the Sereus/Optimystic stack on the NativeScript runtime, with an e2e suite — counterpart to reference-app-rn and reference-app-web
prereq:
files: packages/reference-app-rn/, packages/reference-app-web/, docs/reference-app-rn.md, docs/architecture.md, schemas/chat.qsql, packages/cadre-cli/, package.json (root resolutions)
----

## Why

We have two reference apps that prove the Sereus/Optimystic stack runs end-to-end
on their respective runtimes:

- `@serfab/reference-app-rn` — React Native / Hermes (phone path).
- `@serfab/reference-app-web` — Svelte 5 + Vite / browser (browser path).

We want a third, `@serfab/reference-app-ns`, that validates the **NativeScript**
runtime path. NativeScript runs JS on V8 (Android) and JavaScriptCore (iOS)
directly against native APIs — a meaningfully different runtime from both Hermes
and the browser. Proving the cadre/db-p2p/Quereus/Optimystic stack works there
closes a real platform-coverage gap and gives us a third independent e2e target.

The dev suggested **Svelte Native** for the UI layer (it would share Svelte
mental-model with reference-app-web), but the framework choice is open — see
"Open questions for the plan stage" below.

## Goal & scope

A minimal but realistic peer-to-peer chat app, at **functional parity with the
RN reference app**, built and run as a NativeScript application:

1. **Runtime validation** — prove cadre-core, `@optimystic/db-p2p`, Quereus, and
   the Optimystic plugin work correctly under NativeScript's V8/JSC runtime.
2. **Realistic P2P scenario** — form a 2-party cadre (phone + drone) sharing a
   strand running the simplified chat sApp (Member + Message tables), exactly as
   the RN app does (see `docs/reference-app-rn.md` § Simplified Chat Schema).
3. **Automated e2e target** — a deterministic app an e2e driver can exercise in
   the same spirit as the RN app's Maestro suite and the web app's Playwright
   suite.

The drone side is unchanged: a `cadre-cli` storage-profile node listening on
WebSocket + circuit relay (reuse `packages/reference-app-rn/drone.cadre.yaml`
and the existing in-memory test fixture pattern). This ticket touches only the
new NativeScript client and its tooling.

## Functional requirements (parity with reference-app-rn)

- **Solo-first**: boot a CadreNode in solo/forming mode with no network, create a
  local chat strand, and send/echo messages locally — no drone required.
- **Connect to a drone**: enter a Party ID + bootstrap multiaddr
  (`/ip4/<ip>/tcp/4002/ws/p2p/<peerId>`), dial outbound over WebSocket + circuit
  relay, join the control network, and converge the shared strand.
- **Seed bootstrap**: apply a base64url-encoded seed (paste) to populate the peer
  cache, mirroring the RN Settings screen.
- **Chat**: insert messages into the strand's Quereus DB and display the message
  list, replicating bidirectionally with the drone (poll-based is acceptable,
  matching RN/web).
- **Stable peer identity**: persist an Ed25519 private key across app restarts so
  the PeerId is stable, used for both control and strand networks (the RN app
  stores protobuf bytes in MMKV under `sereus:peer-private-key`).
- **Screens**: a chat screen and a settings/connect screen, at minimum — match
  the RN app's `app/index.tsx` (chat) + `app/settings.tsx` (connect / add peer /
  create strand / apply seed) surface.

The simplified, permissionless chat schema (no signature verification, no invite
flow) is reused verbatim from the RN app so this ticket stays focused on the
runtime plumbing, not application crypto.

## E2E requirements

- An `yarn workspace @serfab/reference-app-ns test:e2e` target that drives the
  built app against a locally-spawned drone fixture, in the same shape as the RN
  app's `scripts/run-e2e.mjs` (spawn in-memory drone + HTTP sidecar, wait for
  `/health`, set up host-loopback forwarding, run flows, tear down).
- Coverage at parity with the RN flows: cold-launch → connect → seed → create
  strand → send (local echo); drone-side insert appears in the app; full
  round-trip (app→drone and drone→app, both visible).
- Stable, centralised test IDs on the interactive elements (the RN app keeps
  these in `src/test-ids.ts`).
- The drone fixture and its HTTP sidecar should be **reused** from the RN app's
  `test-fixture/` rather than reinvented; only the client-driving layer is new.

## Open questions for the plan stage

These are the design decisions to resolve (and document the tradeoff for) before
implementation — captured here so the plan agent doesn't rediscover them:

- **UI framework.** Svelte Native (dev's suggestion; shares Svelte with
  reference-app-web) vs. NativeScript Core (plain, no UI framework) vs.
  `nativescript-vue` vs. `react-nativescript`. Flag Svelte Native's maintenance
  status and its Svelte-version support (reference-app-web is on Svelte 5) as a
  real selection risk — if Svelte Native lags, NativeScript Core or another
  binding may be the lower-risk parity path. Pick one and justify it.
- **JS-engine polyfill surface.** V8/JSC differ from Hermes and from browsers, so
  the polyfill audit must be redone for NativeScript — do not assume the RN
  Hermes polyfill set (`docs/reference-app-rn.md` § Polyfills) transfers. Audit
  what NativeScript's `@nativescript/core` globals already provide vs. what the
  libp2p/Optimystic/Quereus stack needs (`crypto.getRandomValues`,
  `crypto.subtle.digest`, `structuredClone`, `TextEncoder`/`TextDecoder`,
  `ReadableStream`/`WritableStream`/`TransformStream`, `Promise.withResolvers`,
  `AbortSignal.throwIfAborted`, timer `.ref()`/`.unref()`, `EventTarget`/
  `CustomEvent`, `Intl.PluralRules`, and Node-builtin shims `os`/`crypto`/
  `stream`/`buffer`/`net`/`tls`).
- **Bundler / Node-builtin shimming.** NativeScript builds via
  `@nativescript/webpack`, not Metro or Vite. The Node-builtin aliasing and the
  `@libp2p/crypto` Node→browser `.browser.js` rewrite (critical on RN — see
  `docs/reference-app-rn.md` § "libp2p/crypto Node → browser rewrite") must be
  reproduced in webpack resolver config and re-verified for V8/JSC.
- **Storage backend.** There is no `@optimystic/db-p2p-storage-ns` today (RN uses
  MMKV via `db-p2p-storage-rn`; web uses IndexedDB via `db-p2p-storage-web`).
  Decide whether to reuse an existing backend, adapt one, or build a new
  NativeScript `IRawStorage` (candidates: `@nativescript/sqlite`, the file
  system, or `ApplicationSettings`). This is potentially significant scope — if
  it warrants its own ticket, split it out with a `prereq:` chain.
- **WebSocket transport availability.** Confirm libp2p's `@libp2p/websockets`
  transport can dial under NativeScript (whether a usable `WebSocket` global
  exists or a plugin/shim is needed). This is the connectivity linchpin for the
  drone path; the RN app relies on it working under Hermes.
- **E2E driver.** Maestro is black-box and app-agnostic, so it should drive a
  NativeScript-built APK/IPA the same way it drives the RN app — confirm this and
  prefer it for maximum reuse of the RN fixture and flow shape. If Maestro proves
  unworkable on NativeScript builds, fall back to Appium and document why.
- **Build/CI tooling.** Local native tooling vs. NativeScript Cloud builds, and a
  bundle-only smoke target analogous to the RN app's `yarn test:bundle`
  (catches import-resolution failures without a full device build).

## Deliverables

- A new workspace package `packages/reference-app-ns` (`@serfab/reference-app-ns`)
  picked up by the root `packages/*` workspace glob, with whatever root
  `package.json` `resolutions` link entries the chosen storage/runtime path
  requires (mirroring the existing `db-p2p-storage-rn` / `db-p2p-storage-web`
  link lines).
- The chat client at RN parity, the polyfill set for the NativeScript runtime,
  the webpack resolver config, and the e2e suite + run script.
- `docs/reference-app-ns.md` mirroring `docs/reference-app-rn.md` (architecture,
  topology, runtime-specific polyfills, startup sequence, testing strategy), plus
  a cross-reference from `docs/architecture.md` and a package `README.md`.

## Out of scope

- Changes to the drone (`cadre-cli`) or the shared chat schema.
- Secure key storage (mirrors the RN app's MMKV-not-Keychain posture; a future
  hardening step — see `tickets/backlog/3-mobile-secure-key-storage.md`).
- Cross-runtime convergence proofs against the RN/web apps beyond a manual smoke
  note.
