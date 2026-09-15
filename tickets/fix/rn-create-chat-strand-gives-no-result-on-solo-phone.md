description: On a real Android phone running the reference app alone, tapping "Create Chat Strand" produced nothing for at least two minutes — no strand, no success or error message, no log output — so either founding a strand on a phone is extremely slow or it stalls, and the app gives the user no way to tell which.
files:
  - packages/reference-app-rn/app/settings.tsx:97-105 (`handleCreateStrand` — no busy state, no timeout; only a modal on settle)
  - packages/reference-app-rn/src/use-cadre.ts:322-331 (`createStrand` → `createChatStrand`)
  - packages/reference-app-rn/src/chat-strand.ts:89-99 (`createChatStrand` → `CadreNode.foundStrand`)
  - packages/cadre-core/src/cadre-node.ts:4367-4387 (`foundStrand`: `queryStrand` → `publishStrand` → `addStrand`)
  - packages/reference-app-rn/src/cadre-phone.ts:229-274 (phone node config: transaction profile, LevelDB storage, `listenAddrs: []`)
repro: verified
----

# "Create Chat Strand" gives no result on a solo phone

## Observed (2026-09-14, physical device)

Device: Samsung Galaxy Note 9 (SM-N960U), Android 10 / API 29, arm64. Debug build of `reference-app-rn` (Expo SDK 53, RN 0.79.6, Hermes) from the tree at sereus `311fb47` + optimystic with the `block-latch.ts` static-block fix, JS served by Metro over `adb reverse`.

1. Settings → Party ID and Bootstrap addr left empty → **Connect**. Status reached `Connected` in ~12 s; peer id and owner key displayed; `Strands 0`. (Solo start works.)
2. Scrolled to **Create Chat Strand** and tapped it (tap confirmed on the button by screenshot coordinates).
3. For the next ~2 minutes of polling the UI: no modal (neither `Strand created` nor `Strand creation failed`), `Strands` stayed `0`, and logcat (`ReactNativeJS`) showed nothing after the tap — the only app warning in the session was the expected push-wake `getDevicePushTokenAsync failed` (no Firebase config in a dev build).
4. The device then dropped off USB, so it is **not known** whether the call eventually settled. Treat "at least two minutes with no outcome" as the verified fact, not "hangs forever".

## Why this matters

Founding a strand is the first thing a new user does after starting the app, and the only feedback path is a modal shown when the promise settles. A multi-minute wait with an idle-looking screen reads as a broken button, and a user will tap it again — which founds a second strand if the first eventually completes.

## Headless baseline (same night, Node 24 on the dev PC)

The phone's node shape run in Node completes normally: `CadreNode` with `profile: 'transaction'`, `listenAddrs: []`, `[webSockets(), circuitRelayTransport()]`, `strandFilter: all`, hibernation off, `requireSignedSchemas: false`, `InMemoryKeyStore` identity, owner genesis exactly as `runOwnerGenesis` does it (`getIdentityOwnerKey` → `ensureOwnerKey` → `initializeSeedBootstrap`), then `foundStrand` with the chat sApp config. Timings from process start: `start` 325 ms, genesis done 515 ms, **`foundStrand` done 870 ms (~355 ms for the founding itself)**, clean `stop`. The only differences from the phone were `MemoryRawStorage` instead of LevelDB and Node's runtime instead of Hermes.

So founding is not inherently slow and does not wait on a peer for a solo zero-connection node. The multi-minute silence on the device points at something React Native–specific: the LevelDB raw storage (`db-p2p-storage-rn` over `rn-leveldb`), the Hermes polyfills on the hot path (`crypto.subtle.digest` via `@noble/hashes`, `structuredClone` via `@ungap/structured-clone`, the timer `.ref()/.unref()` wrappers), or an unhandled rejection that never reaches the modal. The first two hypotheses below should be re-weighted accordingly.

Note also: owner genesis in `runOwnerGenesis` is fail-soft (`console.warn` only). If genesis had failed on the device, `foundStrand` throws immediately with `no owner signing key available` — that was reproduced headless with a mismatched key, and would have produced the `Strand creation failed` modal, which did not appear. So a genesis failure alone does not explain the observation.

## Hypotheses to test (in order of cheapness)

- **Slow, not stalled.** `plan/every-membership-lookup-reads-an-empty-revocation-table` measured `foundStrand` at 47 cohort consults and 12 commits for a solo node in Node with in-memory storage. On a phone with LevelDB (`rn-leveldb` via a native bridge) and Hermes, each of those may cost far more. Measure wall-clock of `foundStrand` with the node's own `debug` namespaces enabled (`optimystic:*`, `sereus:*`) — first in Node with the phone's config shape (transaction profile, `listenAddrs: []`, WebSocket-only transports, file or LevelDB-like storage), then on a device.
- **A wait on the network that never comes.** A solo transaction-profile node with zero connections: check whether any step in `publishStrand` / `addStrand` (strand node start, strand database bring-up, a cohort consult, a relay or bootstrap dial with a long timeout) waits for a peer rather than taking the solo path.
- **An error swallowed before the modal.** Confirm `createStrand` rejects to `handleCreateStrand` rather than being caught and logged somewhere below at a level logcat filtered out.

A Hermes debugger attach works for this (Metro inspector proxy `ws://localhost:8081/inspector/debug?device=…&page=…`, `Runtime.evaluate`; note Hermes' eval rejects `async` functions, and `__r(<moduleId>)` reaches `src/cadre-phone.ts` → `getPhoneNode()` for the live node).

## Expected behaviour

- `Create Chat Strand` on a solo phone completes in a bounded time a user would accept (state the measured number and the budget you set).
- While it runs, the button shows progress and cannot be re-tapped; if it fails or exceeds a timeout, the user sees the reason.
- A regression guard exists for whichever cause is found (a founding wall-clock/consult budget if it is cost; a scenario with a zero-connection transaction-profile node if it is a network wait).
