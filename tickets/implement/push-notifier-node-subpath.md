----
description: The core library's push-notification code drags Node-only modules into phone/browser app bundles, breaking React Native release builds; isolate it behind a Node-only entry point that the server host injects.
files: packages/cadre-core/src/push-notifier.ts, packages/cadre-core/src/push-notifier-fcm.ts, packages/cadre-core/src/push-notifier-apns.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/types.ts, packages/cadre-core/src/index.ts, packages/cadre-core/package.json, packages/cadre-cli/src/commands/start.ts, packages/cadre-core/test/push-notifier.spec.ts, packages/cadre-core/test/cadre-node.spec.ts, docs/STATUS.md, docs/cadre-host.md
----

# Isolate push notifiers behind a Node-only `push-node` subpath; inject `PushNotifier` into `CadreNode`

## Problem (verified from external feedback report)

`@serfab/cadre-core`'s FCM/APNs push notifiers import `node:crypto` and `node:http2` at
module top level (`push-notifier-fcm.ts:24`, `push-notifier-apns.ts:26-27`). The current
defense — types-only re-export from `index.ts` plus a *guarded dynamic import* in
`CadreNode.start` (`cadre-node.ts:469`) — defers **execution**, not **resolution**.
Metro (React Native's bundler) statically resolves every module in the graph, including
dynamic-import chunks, and has no "external, just warn" mode for `node:` builtins. So any
RN app importing `@serfab/cadre-core` hard-fails its release bundle:

```
Unable to resolve module node:crypto from …/@serfab/cadre-core/dist/push-notifier-fcm.js
```

Confirmed in-repo: our own `reference-app-rn` works around exactly this by shimming
`node:crypto` and `node:http2` in `metro.config.js:41-57` ("the stub only satisfies
Metro's graph resolution"). Every RN consumer must currently repeat that shim.

## Design

Remove the push implementations from the cross-platform module graph entirely. The
cross-platform core references only the `PushNotifier` **interface**; the Node host
(cadre-cli) constructs the concrete notifier from a dedicated Node-only subpath export
and injects the instance. Same isolation pattern as the existing `./key-store-file`
subpath (`package.json` exports).

The feedback report's other suggestion — rewriting FCM signing onto global WebCrypto —
is deliberately **not** taken: it fixes only `node:crypto` in the FCM file; the APNs
notifier still needs `node:http2` (APNs mandates HTTP/2; Node's global `fetch` won't do
it), so the RN graph would still break. Injection removes both builtins (and any future
Node dependency in the push path) in one move. Once the files are Node-only by
construction, `node:crypto` there is appropriate.

### Module split

- `src/push-notifier.ts` becomes **interface-only**: keeps `PushMessage`,
  `PushSendResult`, `PushNotifier`. Zero imports of the implementation files (the
  current `FcmPushDeps`/`ApnsPushDeps` type imports move out with `PushNotifierDeps`).
- New `src/push-node.ts` (Node-only subpath entry): `createPushNotifier`,
  `PushNotifierDeps`, the `noCreds` helper, and re-exports of `createFcmPushNotifier` /
  `createApnsPushNotifier` + their deps types.
- `package.json` gains:
  ```json
  "./push-node": { "types": "./dist/push-node.d.ts", "import": "./dist/push-node.js" }
  ```
- The elaborate namespace-import workarounds in `push-notifier-fcm.ts` /
  `push-notifier-apns.ts` (namespace `import * as nodeCrypto` so Vite only warns) are
  obsolete once these files are unreachable from the cross-platform graph — switch to
  plain named imports and rewrite the stale header comments that describe the old
  "guarded dynamic import" defense.

### Config change (no backwards compat — per repo rules)

`CadreNodeConfig.push` changes from `PushCredentials` to an injected instance:

```ts
push?: {
  notifier: PushNotifier;      // constructed by the Node host from '@serfab/cadre-core/push-node'
  cooldownMs?: number;
  debounceMs?: number;
}
```

- `CadreNode.start` drops the `await import('./push-notifier.js')` and uses
  `config.push.notifier` directly. (Bonus: removes a runtime inline `import()`, which
  repo rules discourage.)
- Lifecycle unchanged: `CadreNode.stop` keeps closing the notifier via
  `PushFanoutService.close()` (`cadre-node.ts:1795-1797`) — ownership transfers to the
  node on injection; document that in the config field's doc comment.
- `PushCredentials` (with its `cooldownMs`/`debounceMs` policy fields),
  `validatePushCredentials`, and `redactPushCredentials` stay exported from the root
  entry — they are import-clean and provisioners (cadre-host, cadre-provider, cadre-cli
  loader) still use them. Only the *construction* moves behind the subpath.

### cadre-cli wiring (the only Node runtime constructing `CadreNode` with push)

`commands/start.ts:139-153`: when `config.push` credentials are present (from cadre.json
written by cadre-host, or `CADRE_PUSH` injected by cadre-provider — both provisioning
paths unchanged), build the notifier and inject:

```ts
import { createPushNotifier } from '@serfab/cadre-core/push-node';
// ...
push: config.push
  ? { notifier: createPushNotifier(config.push), cooldownMs: config.push.cooldownMs, debounceMs: config.push.debounceMs }
  : undefined,
```

Loader/validation in cadre-cli is untouched. cadre-host and cadre-provider only
provision credential JSON; no changes there.

### Docs

Grep docs for the "guarded dynamic import" story and update: `docs/STATUS.md` (push
delivery + fan-out sections, ~lines 264-290), `docs/cadre-host.md:280`, any
`docs/architecture.md` mention. Also update the `index.ts:186-192` comment block.

## Edge cases & interactions

- **Graph cleanliness is the acceptance criterion**: after the change, no import chain
  (static or dynamic, value or non-erased) from `src/index.ts` may reach
  `push-notifier-fcm.ts`, `push-notifier-apns.ts`, or `push-node.ts`. Verify by grep
  over `dist/` after build: `index.js`'s transitive imports must not include those
  files; `node:crypto`/`node:http2` specifiers must appear only in `push-node.js`,
  `push-notifier-fcm.js`, `push-notifier-apns.js`, `key-store-file.js`.
- `push-fanout.ts` already imports the `PushNotifier` type only — must stay that way.
- Type-only imports are erased at emit, so `push-notifier.ts` interface module may not
  import impl files even as types — keep it zero-import to make the invariant obvious.
- Misconfiguration surface: with the new shape, "credentials set but no notifier" is
  unrepresentable in core (notifier is a required field). cadre-cli's existing
  `validateResolvedPush` still rejects malformed credential blocks before construction.
- Notifier `close()` idempotency: `CadreNode.stop` closes an injected notifier the host
  created. Existing behavior (fan-out closes it) is preserved; confirm FCM/APNs `close()`
  tolerate double-close since a defensive host might also close on shutdown.
- `cadre-node.spec.ts` push tests (e.g. the "no `config.push` → no-op" case ~line 1007):
  injection makes these *simpler* — a fake in-memory `PushNotifier` can now be passed
  directly instead of exercising the dynamic-import path. Add/adjust a test that an
  injected fake notifier receives `send()` on push-wake fan-out.
- `push-notifier.spec.ts` imports `createPushNotifier` from `./push-notifier.js` —
  update to `./push-node.js`.
- Monorepo `workspace:^` resolution: cadre-cli imports the new subpath — ensure
  `yarn build` order (core before cli) and typecheck both packages.

## TODO

- [ ] Split `push-notifier.ts` → interface-only; create `src/push-node.ts` with `createPushNotifier` + deps types + impl re-exports
- [ ] Add `./push-node` to `packages/cadre-core/package.json` exports
- [ ] Change `CadreNodeConfig.push` to `{ notifier, cooldownMs?, debounceMs? }` (`types.ts:309-318`); update doc comment incl. ownership/close semantics
- [ ] `cadre-node.ts`: remove guarded dynamic import; use injected notifier; update comments
- [ ] Switch fcm/apns files to named `node:crypto`/`node:http2` imports; rewrite stale header comments
- [ ] Update `index.ts` push export comment block
- [ ] Wire injection in `cadre-cli/src/commands/start.ts`
- [ ] Update tests: `push-notifier.spec.ts` import path; `cadre-node.spec.ts` fake-notifier injection test
- [ ] Verify dist graph cleanliness (grep `node:crypto|node:http2` reachability from `index.js`)
- [ ] Update docs (`STATUS.md`, `cadre-host.md`, `architecture.md` mentions of guarded dynamic import)
- [ ] `yarn build`, `yarn lint`, tests green in cadre-core + cadre-cli
