# @serfab/reference-app-web

Svelte 5 + Vite SPA that runs a real **Sereus cadre node in the browser**. It is
the browser counterpart to `@serfab/reference-app-rn` (which targets phones via
React Native), and the validation surface for "the Sereus cadre/strand stack
actually works in a browser."

The app boots a `CadreNode` from `@serfab/cadre-core`:

```
CadreNode → control network (CadreControl) → signed open chat strand (chat sApp)
```

- **Control network** — an Optimystic network named `control-<partyId>` carrying
  the `CadreControl` schema (authority keys, cadre peers, strands).
- **Authority self-genesis** — a solo node seeds itself as its own authority,
  mirroring `cadre-cli start --authority` (bridge the libp2p identity into a
  base64url authority key, idempotent genesis `AuthorityKey` insert, then
  `initializeSeedBootstrap`).
- **Signed chat strand** — an open strand whose chat sApp schema is **signed**;
  `StrandInstanceManager` verifies the signature on start
  (`assertSchemaSignature`), so the browser exercises the schema-signature gate
  the RN reference currently skips.
- **Strand database** — the chat `Member`/`Message` tables backed by Quereus over
  Optimystic. On a solo node the strand runs in `bootstrap` mode, so DML lands on
  the strand's IndexedDB-backed local transactor with no peers needed.

Identity (Ed25519 peer key) and the party id persist in IndexedDB across reloads.

> **Phase 1 vs Phase 2.** This is Phase 1: a **solo single-node cadre**. The
> consent/invitation strand-formation flow, closed-strand membership, RBAC
> demonstration, and cross-node/cross-party convergence are Phase 2
> (`reference-app-web-strand-formation-consent-rbac`). The Home "Cadre" panel's
> seed input and the Tier-2 distributed e2e suite are inert until then.

## Run

```bash
yarn workspace @serfab/reference-app-web dev      # dev server on :5173
yarn workspace @serfab/reference-app-web build    # static SPA bundle in dist/
yarn workspace @serfab/reference-app-web preview  # serve the built bundle
```

On first page load the app generates a fresh Ed25519 keypair and a party id,
stores both in IndexedDB (in the `sereus-strand-control` database's `kv` store),
and starts the cadre node. Reload preserves the peer ID and party ID. Each
control/strand network gets its own IndexedDB database:

- `sereus-strand-control` — control network blocks + identity + party id.
- `sereus-strand-sereus-web-chat` — the chat strand's blocks (members/messages).

Delete those databases from DevTools → Application → Storage to reset identity
and stored messages.

## Routes

- `#/` — **Home** — node status, party id, peer id, control-network connection,
  chat-strand status, authority state, Restart, and a (disabled) Phase-2 cadre
  seed panel.
- `#/messages` — compose / list chat messages backed by the strand's
  `App.Member` / `App.Message` tables (Quereus SQL). The chat sApp is
  append-only — there is no edit/delete (that belonged to the old demo app).
- `#/log` — **Activity** — a CadreNode lifecycle event log
  (`control:*`, `strand:*`, `seed:*`, authority genesis), newest first.
- `#/diag` — diagnostics surface (see below).

## Storage bridge (`lib/strand-storage.ts`)

`CadreNodeConfig.storage.provider` is a **synchronous** factory
`(key) => IRawStorage`, and cadre-core partitions data by key (`'control'` for
the control network, the strand id for each strand). `IndexedDBRawStorage`
wraps an **already-open** handle (the opener is async) with no per-key
namespacing. The bridge pre-opens one IndexedDB database per key
(`sereus-strand-<key>`) **before** the synchronous provider is hit — the app
drives control bring-up and `addStrand` explicitly, so every key is known ahead
of time — and the provider returns a cached `IndexedDBRawStorage` per key.

## Solo cadre (Phase 1)

No control bootstrap, no listen addresses. The node self-seeds as its own
authority and hosts a single signed chat strand in `bootstrap` mode. Send →
list round-trips and the data survives reload (DML persists to the strand's
IndexedDB database). This is the single-node analogue of the RN reference's
current coverage, plus the schema-signature gate.

Authority genesis is **fail-soft**: the chat round-trip runs in bootstrap mode
and does not depend on authority, so a genesis failure is surfaced on Home /
Diagnostics rather than aborting startup.

## Phase 2 (forthcoming)

Consent-driven strand formation, closed-strand membership + RBAC, joining
another party's cadre via a signed control-network seed, and cross-node /
cross-party convergence. The Home seed input and the distributed e2e tier are
placeholders for this work.

## Diagnostics (`#/diag`)

Polls every two seconds while the tab is visible. Surfaces:

- **Cadre** — party id, control-network connection + control peer id, CadrePeer
  membership count, authority self-genesis outcome, and the chat strand's status
  / connected peers / latency hint / sApp id / error.
- **Identity** — peer ID, persistence badge, first-seen timestamp and age.
- **Connectivity** — control-node status, listen multiaddrs (empty in a browser
  peer), per-connection peer ID / remote multiaddr / direction / open protocols,
  and the relayed-vs-direct path summary.
- **Transports** — names of registered libp2p transports. The healthy browser
  bundle is **four** entries: WebSockets, circuit-relay, and the two WebRTC
  transports. **No TCP transport should appear** — cadre-core imports
  `@optimystic/db-p2p`'s main entry (which statically imports `@libp2p/tcp`),
  but the explicit transports array means `tcp()` is never instantiated, so it
  must not leak into the runtime list. Its presence indicates a Node-only
  transport leaked into the browser bundle.
- **FRET** — known peer count, network size estimate, churn, partition,
  Arachnode ring membership (on the control node).
- **Storage** — `IndexedDBRawStorage` (the control network's), quota / usage,
  raw approximate bytes, per-object-store row counts for the control database.
- **Crypto sanity** — host-API checks the libp2p stack relies on.
- **Recent errors** — a ten-deep ring buffer fed by the start/stop catch blocks,
  per-connection `close` events, and global `error` / `unhandledrejection`
  events.

## Vite config notes

Browsers natively provide `crypto.subtle`, `EventTarget`, `ReadableStream`,
`structuredClone`, `Promise.withResolvers`, `AbortSignal.throwIfAborted`, and
`TextEncoder`/`Decoder`, so the polyfill surface is much smaller than RN.

`vite.config.ts` aliases only the Node built-ins that transitive libp2p deps
reach for — `os`, `net`, `tls` → empty shim; `stream` → `readable-stream`;
`buffer` → npm `buffer`. cadre-core pulls in `@optimystic/db-p2p`'s main entry,
which statically imports `@libp2p/tcp`; the existing `net`/`os`/`tls` aliases
already cover its Node built-ins, and `tcp()` is never called (the app supplies
an explicit transports array), so nothing TCP-related runs. **`node:crypto` /
`crypto` are deliberately not aliased**: anything reaching for them in a browser
bundle is a real bug we want surfaced.

`src/polyfills.ts` handles the two residual gaps even modern browsers don't
cover:

- `globalThis.Buffer` — wired to the npm `buffer` package.
- `setTimeout` / `setInterval` return values with no-op `.ref()` / `.unref()`.

If you discover another missing API, add it to `polyfills.ts` with a comment
explaining which package needs it — do not introduce a `crypto` shim.

## Browser support

- **Chromium / Chrome**: primary development target.
- **Firefox**: should work — relies only on standard APIs (WebSocket, IndexedDB,
  WebCrypto, `crypto.subtle`). Smoke-check before relying on it.
- **Safari**: untested. `@optimystic/db-p2p-storage-web` targets Safari 14+.
  Smoke-check before relying on it.

If anything fails in Firefox / Safari, capture the console error and file a fix
ticket rather than papering it over with a shim — the same applies as for
`crypto`.

## Architecture

```
src/
  App.svelte             # nav + hash route switcher (Home, Messages, Activity, Diagnostics)
  Home.svelte            # node status + party/peer/control/strand state + Phase-2 cadre panel
  Messages.svelte        # /messages — chat strand send / list
  Activity.svelte        # /log — CadreNode lifecycle event log
  Diagnostics.svelte     # /diag — cadre + libp2p diagnostic surface
  main.ts                # mount + polyfill bootstrap
  polyfills.ts           # Buffer global + timer .ref/.unref shim
  main.css               # global styles
  lib/
    cadre-web.ts             # CadreNode lifecycle (control net, authority genesis, chat strand)
    strand-storage.ts        # per-strand IndexedDB IRawStorage provider (pre-open bridge)
    chat-strand.ts           # chat sApp schema + signed SAppConfig + strand id
    store.svelte.ts          # Svelte 5 runes store: node state + CadreNode event log
    network.svelte.ts        # Phase-2 control-network seed input (placeholder)
    messages.svelte.ts       # chat strand DB wrapper — reactive message list + polling
    router.svelte.ts         # tiny hash-based router (#/, #/messages, #/log, #/diag)
    diagnostics.svelte.ts    # tick-driven snapshot store powering /diag
    connection-path.ts       # relayed-vs-direct classification (cadre-core duplicate)
    ice-config.ts            # ICE servers from a runtime manifest
    Copyable.svelte          # copy-to-clipboard chip used in /diag
  shims/
    empty.ts             # vite alias target for node:os / node:net / node:tls
```

## Automated end-to-end tests

A Playwright suite lives in `e2e/`. Chromium-only for now; Firefox / Safari are
explicit non-goals at this layer.

```bash
# One-time browser install (downloads Chromium if not already cached).
yarn workspace @serfab/reference-app-web test:e2e:install

# Run the suite (builds and previews the SPA automatically).
yarn workspace @serfab/reference-app-web test:e2e
```

- **Tier 1 — solo** (`e2e/solo/`) — always runs. Covers boot + identity/party
  persistence, hash routing, the chat strand send/list round-trip, reload
  persistence of strand DML, the schema-signature gate (a pure-Node assertion
  that the valid signed config verifies and a tampered one throws
  `SchemaVerificationError`), the connection-path classifier parity table, and
  the diagnostics-surface invariants — notably the **four-transport** Transports
  list, the canary that no TCP transport leaked into the browser bundle.
- **Tier 2 — distributed** (`e2e/distributed/`) — **deferred to Phase 2.** These
  specs assert membership-free Optimystic convergence on a shared network, which
  no longer holds now that chat data lives inside a cadre **strand** cohort.
  `e2e/global-setup.ts` writes the fixture as unavailable
  (`TIER2_DEFERRED_TO_PHASE2`), so every distributed spec skips with a Phase-2
  reason. Re-establishing cross-node / cross-party convergence requires
  control-network membership or strand formation (Phase 2).

Wiring this suite into CI is out of scope for the current ticket — it stops at
"runs cleanly locally."

## Out of scope (for follow-up)

- Real-time push (gossip / sync subscription wiring) — convergence is poll-based.
- Phase 2: consent strand formation, closed-strand RBAC, cross-party convergence.
