description: The push-notification senders were moved out of the shared library behind a Node-only import path so phone/browser bundles no longer pull in Node-only modules; reviewed that nothing running on phones still reaches them and servers still send push wakes correctly.
files: packages/cadre-core/src/push-notifier.ts, packages/cadre-core/src/push-node.ts, packages/cadre-core/src/push-notifier-fcm.ts, packages/cadre-core/src/push-notifier-apns.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/types.ts, packages/cadre-core/src/index.ts, packages/cadre-core/package.json, packages/cadre-cli/src/commands/start.ts, packages/cadre-core/test/push-notifier.spec.ts, packages/cadre-core/test/cadre-node.spec.ts, packages/reference-app-rn/metro.config.js, docs/STATUS.md, docs/architecture.md
----

# Complete: isolate push notifiers behind Node-only `push-node` subpath; inject `PushNotifier`

FCM/APNs senders (import `node:crypto`/`node:http2`) moved behind Node-only subpath
`@serfab/cadre-core/push-node`; concrete notifier now **injected** into `CadreNode` via
`CadreNodeConfig.push.notifier` instead of built in-core. Cross-platform entry references only the
`PushNotifier` *interface*. See the implement commit + review handoff for the full shipped shape.

## Review findings

Adversarial pass over implement commit `6a56187`. Ran full build/test/lint; verified the graph
acceptance criterion; scrutinized blast radius, injection/lifecycle, type safety, and docs.

### Checked — clean

- **Graph acceptance (the criterion).** Built `cadre-core`; grepped `dist/` for real
  `node:crypto`/`node:http2` imports → confined to exactly **`key-store-file.js`,
  `push-notifier-fcm.js`, `push-notifier-apns.js`**. `dist/index.js` and `dist/cadre-node.js`
  have **no** runtime import of `push-node`/`push-notifier-fcm`/`push-notifier-apns` — the
  type-only `PushNotifier` re-export is erased at emit; cadre-node imports only import-clean
  `push-fanout.js`. Isolation holds.
- **Shape-change blast radius.** `CadreNodeConfig.push` went from `PushCredentials` to
  `{ notifier; cooldownMs?; debounceMs? }` (no back-compat, per repo rules). Only construction
  site that sets `push` on a `CadreNode` is `cadre-cli/start.ts`, which now builds the notifier
  from the subpath and injects it. Grepped every `new CadreNode` / `push:` site: `cadre-provider`
  (`server.ts`) and `cadre-host` (`host-process-orchestrator.ts`, `bin/host.ts`) `config.push` is
  a **different** type (provisioning credentials into `ContainerService` / child `cadre.json` /
  `CADRE_PUSH`), untouched by this change. Integration `push-wake-e2e` exercises the
  control-network `pushWake` protocol, not the platform notifier — sets no `config.push`. No
  hidden break.
- **Injection / lifecycle.** `buildPushFanout` is a trivial passthrough of
  `notifier`/`cooldownMs`/`debounceMs`; node owns the injected notifier and closes it once via the
  fan-out; CLI does not double-close. New `cadre-node.spec` test proves the exact injected
  instance is the one closed (close-counter identity). `send`/`close` routing over a fake notifier
  covered by `push-fanout.spec` (unchanged). `PushNotifierDeps` relocated to `push-node.ts` — never
  root-exported, so no consumer break.
- **fcm/apns.** Namespace-import-to-only-warn workaround correctly dropped for plain named imports
  now that the modules are unreachable from a browser build by construction; header comments
  rewritten to match. `close()` idempotent in both impls.
- **Validation (all green).** `cadre-core`: build + typecheck + `yarn test` → **658 passed, 1
  skipped** (pre-existing skip). `cadre-cli`: typecheck + `yarn test` → **94 passed** (subpath
  resolves end-to-end). `cadre-host` + `cadre-provider`: typecheck clean. Root `yarn lint` clean.

### Found + fixed inline (minor — doc drift)

- **`docs/architecture.md` mechanism 5** had two stale/contradictory clauses the implement pass
  missed:
  1. "Credentials ride `CadreNodeConfig.push` (`PushCredentials`) … `cadre-cli` carries it into
     `CadreNodeConfig.push`" — wrong post-change (the field is now `{ notifier, … }`, and cadre-cli
     *constructs* the notifier, not carries credentials). Rewrote to: host/provider provision raw
     `PushCredentials`; cadre-cli reads them and injects a `PushNotifier` into
     `config.push.notifier`.
  2. "the platform-push sender: `PushNotifier` (`push-notifier.ts`), a credential- and
     transport-injected router" — conflated the interface (now `push-notifier.ts`) with the router
     (`createPushNotifier`, now `push-node.ts`). Tightened to name both correctly.
  `docs/STATUS.md` and `docs/cadre-host.md` re-read against the new reality and confirmed accurate
  (cadre-host still writes raw `PushCredentials` into the child's `cadre.json`; construction moved
  to cadre-cli, so its push section stands). No code/test surface — doc-only edits, no re-run
  needed beyond the already-green lint.

### Major / new tickets

None. Blast radius contained, tests green, isolation verified.

### Tripwires (parked, not ticketed)

- **RN `node:http2` metro shim removal.** The empty `http2` stub in
  `packages/reference-app-rn/metro.config.js` *should* now be droppable (cadre-core no longer
  reaches `node:http2` from the cross-platform entry), but proving it needs a real Metro release
  build — out-of-agent. Parked as a comment at the `http2` shim line by the implement pass; left
  in place as belt-and-suspenders. Index-only mention here.
- **Double-close tolerance.** No caller double-closes today (node closes once; CLI never closes).
  Both impls' `close()` are idempotent, so this is latent-safe. Worth a glance only if a future
  host adds its own shutdown close. Knowledge, not queued work — no code site change made.

### Not exercised (unchanged by this work, still true)

- Real-network / on-device FCM/APNs push and the `node:http2` transport (`createHttp2Transport`)
  have no automated coverage — validated out-of-band, same as before this ticket.

## End
