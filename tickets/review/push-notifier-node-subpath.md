----
description: The push-notification code was moved out of the shared library so phone/browser app bundles no longer drag in Node-only modules; verify nothing that runs on phones still reaches it, and that servers still send push wakes correctly.
files: packages/cadre-core/src/push-notifier.ts, packages/cadre-core/src/push-node.ts, packages/cadre-core/src/push-notifier-fcm.ts, packages/cadre-core/src/push-notifier-apns.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/types.ts, packages/cadre-core/src/index.ts, packages/cadre-core/package.json, packages/cadre-cli/src/commands/start.ts, packages/cadre-core/test/push-notifier.spec.ts, packages/cadre-core/test/cadre-node.spec.ts, packages/reference-app-rn/metro.config.js, docs/STATUS.md, docs/architecture.md
----

# Review: isolate push notifiers behind Node-only `push-node` subpath; inject `PushNotifier`

## What shipped

The FCM/APNs push senders (which import `node:crypto` / `node:http2`) are no longer
reachable from `@serfab/cadre-core`'s cross-platform entry (`index.js`). They now live
behind a dedicated Node-only subpath, and the concrete notifier is **injected** into
`CadreNode` instead of constructed inside it.

Concretely:

- **`push-notifier.ts` → interface-only.** Keeps `PushMessage`, `PushSendResult`,
  `PushNotifier`; zero runtime imports (only erased type-only imports). This is the
  cross-platform contract the core references.
- **New `push-node.ts`** (subpath entry): `createPushNotifier`, `PushNotifierDeps`, the
  `noCreds` helper, plus re-exports of `createFcmPushNotifier` / `createApnsPushNotifier`
  and their dep types.
- **`package.json`** gains `"./push-node"` export (mirrors the existing `./key-store-file`
  isolation pattern).
- **`CadreNodeConfig.push`** changed shape (no back-compat, per repo rules) from
  `PushCredentials` to `{ notifier: PushNotifier; cooldownMs?; debounceMs? }`. Doc comment
  spells out that ownership transfers to the node and `stop()` closes the notifier.
- **`cadre-node.ts`**: removed the `await import('./push-notifier.js')` guarded dynamic
  import. Fan-out construction extracted to a small private `buildPushFanout(push)` that
  uses `config.push.notifier` directly.
- **fcm/apns files**: switched from the namespace-import-to-only-warn workaround to plain
  named imports (`import { sign } from 'node:crypto'`, `import { connect, ... } from 'node:http2'`);
  header comments rewritten to describe the subpath isolation instead of the old defense.
- **`cadre-cli/src/commands/start.ts`** (the Node host): imports `createPushNotifier` from
  `@serfab/cadre-core/push-node`, builds the notifier from the resolved credentials, and
  injects `{ notifier, cooldownMs, debounceMs }`.
- Docs (`STATUS.md`, `architecture.md`) and the RN `metro.config.js` comment updated.

## How to validate

Build + tests + lint were run green (see "Validation done" below). To re-verify:

- **Graph cleanliness (the acceptance criterion).** From `packages/cadre-core` after
  `yarn build`, grep `dist/` for real `import ... 'node:crypto'|'node:http2'` statements:
  they must appear **only** in `push-notifier-fcm.js`, `push-notifier-apns.js`, and
  `key-store-file.js`. (`push-node.js` imports the fcm/apns modules but pulls no builtin
  itself.) Confirm `dist/index.js` and `dist/cadre-node.js` have **no** runtime import of
  `push-node.js` / `push-notifier-fcm.js` / `push-notifier-apns.js` — only JSDoc mentions.
  This was verified this run.
- **Injection wiring.** `cadre-node.spec.ts` → "buildPushFanout wires the injected notifier
  and owns its close lifecycle" proves the exact injected instance is the one closed on
  teardown (identity via a close-counter), replacing the old dynamic-import exercise.
- **Sender behavior unchanged.** `push-notifier.spec.ts` (now importing `createPushNotifier`
  from `push-node.js`) still covers request shape, every response-code mapping, token
  caching/re-mint, GOAWAY re-establish, router dispatch, and no-secret-in-logs.
- **Fan-out send/close over a fake notifier** is covered by `push-fanout.spec.ts`
  (unchanged) — that's why the new cadre-node test asserts only wiring/identity, not a full
  send path (would require stubbing control-node dial + strand participation to force the
  platform-push fallback).
- **CLI injection.** `cadre-cli` build + typecheck + tests pass; `start.ts` constructs the
  notifier only when `config.push` credentials are present (opt-in preserved).

## Validation done (green)

- `cadre-core`: `yarn build`, `yarn typecheck`, `yarn test` → **658 passed, 1 skipped** (the
  skip is pre-existing, not introduced here).
- `cadre-cli`: `yarn build`, `yarn typecheck`, `yarn test` → **94 passed**.
- `cadre-host` + `cadre-provider`: `yarn typecheck` → clean (they provision credential JSON
  / env only; neither constructs `CadreNode` with the push field, so the shape change did
  not touch them).
- Root `yarn lint` → clean.
- Dist graph grep → node builtins confined to the three expected files; `index.js` reaches
  none of the push impls.

## Known gaps / things to scrutinize (tests are a floor)

- **Real-network / on-device push is NOT exercised** — no unit test hits FCM/APNs for real
  (same as before this ticket). The `node:http2` transport path (`createHttp2Transport`) has
  no automated coverage; it's validated out-of-band. Unchanged by this work but still true.
- **RN metro shim not removed, only re-commented.** The whole point of this ticket is that
  RN consumers no longer need to shim `node:http2` for cadre-core. The `http2` empty stub in
  `reference-app-rn/metro.config.js` *should* now be removable, but that requires a real
  Metro release build to confirm nothing else transitively pulls `node:http2` — not
  agent-runnable here. Left in place as belt-and-suspenders with a comment saying so. A
  reviewer with an RN toolchain can try dropping it and running a release bundle; that is the
  true end-to-end proof the isolation worked. **(Tripwire, parked in the metro.config.js
  comment at the `http2` shim line — not filed as a ticket.)**
- **`cadre-host.md` left unchanged.** Its push section (line ~309) describes cadre-host
  *provisioning* `PushCredentials` into the child's `cadre.json` — still accurate, since
  construction/injection moved to cadre-cli, not cadre-host. Confirm this reasoning holds.
- **Double-close tolerance.** The ticket flagged confirming FCM/APNs `close()` tolerate a
  double-close (a defensive host might also close). Current design: the node owns the notifier
  and closes it once via the fan-out; the CLI does not close it. `close()` is idempotent in
  both impls (FCM nulls its cache; APNs nulls cache + closes an already-null/closed session
  harmlessly). No caller double-closes today, so this is latent-safe rather than exercised —
  worth a glance if a future host adds its own shutdown close.

## Review findings

- Noted the removable RN `node:http2` metro shim as a **tripwire** — recorded as a comment at
  the `http2` entry in `packages/reference-app-rn/metro.config.js` (removal needs a real Metro
  release build to confirm, which is out-of-agent). Not filed as a ticket.
