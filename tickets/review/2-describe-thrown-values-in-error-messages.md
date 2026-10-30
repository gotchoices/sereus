description: Error messages built from a caught value now describe values that are not Errors (such as a phone's WebSocket failure event) instead of printing "[object Object]", through one shared helper, and a lint rule stops the old pattern from coming back.
architecture: docs/testing.md
files: packages/cadre-core/src/describe-thrown.ts, packages/cadre-core/test/describe-thrown.spec.ts, packages/cadre-core/src/index.ts, eslint.config.mjs, docs/testing.md ("Lint coverage" → "Thrown-value guard"), packages/cadre-provider/src/server/invitation-validation.ts (NOTE), plus the ~80 call-site files listed by `git diff --stat`
----
## What landed

gotchoices/sereus#54: on a phone (Hermes), `relayStatus().error` read `"[object Object]"` because a React Native WebSocket failure rejects with an event object, and every caught-value-to-text site used `err instanceof Error ? err.message : String(err)`.

- **`describeThrown(value: unknown): string`** in `packages/cadre-core/src/describe-thrown.ts`, exported from cadre-core's root entry. No imports, so it is safe in every runtime's graph.
  - An `Error` gives its `message`, unchanged and not truncated. `cause` and `AggregateError.errors` are not walked.
  - A non-null object gives its non-empty string `type`, `message` and `reason` joined with `: `, plus `code` (a string, or a number, which is what a `CloseEvent` carries) as ` (code X)`, or `code X` when it is the only field. Fields are read by property access, so the getters on a browser `Event.prototype` count.
  - Otherwise its `JSON.stringify`. A cycle or a BigInt (which throw) and `{}` fall through to `String()`.
  - Object descriptions are cut to 500 characters, ending in `…`. Primitives give their `String()` text, as before.
- **Call sites.** Every `x instanceof Error ? x.message : String(x)` in `packages/*/src` of the packages that depend on cadre-core now calls `describeThrown(x)`. That is 85 sites in `.ts`/`.tsx` (the ticket's grep finds 91; 6 are in cadre-provider, see below), 2 in `reference-app-web/src/Messages.svelte`, and 3 variants the lint rule found that keep their own Error arm and replace only the `String()` arm: `integration-tests/.../control-stream-authz.integration.ts`, `reference-app-rn/src/join-link.ts` (both `${name}: ${message}`), and `reference-app-web/src/lib/diagnostics.svelte.ts` (`stack ?? message`).
- **Local copies removed.** These were nothing but the pattern, so they are gone and their callers call `describeThrown`: `errorMessage` in cadre-host `hosted/node-status.ts` (it had 3 importers), reference-app-rn `settings-controls.tsx` (7) and reference-app-web `lib/cadre-format.ts` (5), plus file-local ones: cadre-cli `enroll-add.ts`, `owner-key-file.ts`, `owner-key.ts`; cadre-core `pending-join-runner.ts`, `push-notifier-shared.ts` (`errText`, used by the APNs and FCM notifiers), `strand-membership-reconciler.ts`, `strand-move.ts`; cadre-host `nat/nat-service.ts`; reference-app-ns `cadre-vm.ts`, `chat-vm.ts`; reference-app-web `lib/network.svelte.ts`.
- **Lint rule** `THROWN_DESCRIPTION_GUARD` in `eslint.config.mjs`. It is a `no-restricted-syntax` selector `ConditionalExpression[test.operator='instanceof'][test.right.name='Error'] > CallExpression.alternate[callee.name='String']`, at `error`. It applies to `packages/*/src/**/*.{ts,tsx,mts,cts}` (ignoring cadre-provider, config-check and quereus-plugin-sereus) and to `packages/*/src/**/*.svelte`. It is added to the LINK_DEADLINE scope and to the `control-database.ts` exemption entry too, because each entry replaces the rule's options rather than adding to them. Documented in `docs/testing.md` → "Lint coverage".

## Where the ticket's assumptions did not hold

- **cadre-provider does not depend on cadre-core.** The ticket said it does. It doesn't, by design: `config/types.ts` and `config/validate.ts` say the provider stays free of cadre-core's runtime graph. Its 6 sites keep `String()`, the lint scope ignores the package, and a `NOTE:` on `reasonOf` in `server/invitation-validation.ts` says to switch over if the provider ever takes the dependency. config-check and quereus-plugin-sereus are ignored for the same reason; neither has a site.
- **cadre-host's browser UI** (`packages/cadre-host/ui/src`) imports nothing from cadre-core, and loading cadre-core's root entry would pull libp2p into the host's UI bundle. Its one site (`components/ClaimCode.svelte:83`, a `fetch` failure) is unchanged. The `packages/*/src` glob doesn't reach that directory anyway.
- cadre-host and reference-app-ns do import cadre-core's root entry, so their copies were removed.

## Validation

- `yarn lint`: clean. Before the three variant sites were fixed it reported exactly those three and nothing else.
- I probed the scope with `npx eslint --stdin --stdin-filename …`, using a snippet that has both the pattern and `AbortSignal.timeout`. The thrown-value rule fires in cadre-core src (including `control-database.ts`), cadre-rn src and a reference-app-web `.svelte` file. It does not fire in cadre-provider, config-check, `cadre-host/ui/src` or a cadre-core test file, and those files still get the phone-runtime selector, so the `ignores` dropped nothing else.
- `yarn typecheck`: clean, all workspaces.
- `yarn build`: clean, including reference-app-web's Vite build of cadre-core's root entry.
- Tests: cadre-core (189 files, 2556 passed), cadre-cli (295), cadre-host (444), reference-app-ns (71), reference-app-rn (180), reference-app-web (11).
- integration-tests: only the unit specs under `test/` and the `control-stream-authz` scenario were run, and all 51 passed. That scenario also loads `harness/index.ts`, and so `ws-latency.ts`'s new cadre-core import. The full sequential real-network suite was not run because it is too long for an agent run. The other changed scenarios have only catch-path message changes, and typecheck and lint cover those.
- Not run: `test:bundle` for reference-app-rn and reference-app-ns. `describe-thrown.ts` imports nothing, so it adds nothing to the Metro or webpack graph.

## Tests added

- `packages/cadre-core/test/describe-thrown.spec.ts`, which covers the helper's branching:
  - An `Error` keeps its message, and its `cause` is ignored.
  - WebSocket error-event, `CloseEvent` and code-only objects read as their fields.
  - An object with no known fields falls back to JSON, including one whose `message` is not a string.
  - A cyclic object and `{}` fall back to `String()`.
  - A huge object is cut to 500 characters.
  - Primitives (`string`, number, `undefined`, `null`) give their `String()` text.

There are no tests at the call sites, because the lint rule enforces the pattern there.

## For the reviewer to weigh

- **Push notifiers.** `push-notifier-shared.ts` documented `errText` as "a short, secret-free string". It is replaced by `describeThrown`, which would JSON a thrown non-Error object into the APNs/FCM result and debug log. Every thrower on that path (node:crypto, `fetch`, node:http2, the notifiers' own `new Error`) throws an `Error` today, so the text is unchanged in practice. If you'd rather keep a path that never serializes objects next to signing keys and OAuth tokens, restore `errText` there with an `eslint-disable-next-line no-restricted-syntax -- <reason>`.
- **Output format.** The format (`type: message: reason (code X)`) is my choice; the issue suggested `[type, message, reason].join(': ')` without `code`.
- **What the rule does not catch.** It catches the idiom only: `${err}`, `'' + err` and a bare `String(err)` outside a conditional pass. Test files are outside its scope, and about 8 spec and e2e sites still use the old pattern.
- **Null-prototype objects.** An object made with `Object.create(null)` and no fields still makes `String()` throw inside `describeThrown`. That was already true of every old site; I left it alone as contrived.
- **Formatting.** The rewrite was scripted. Where a new import was merged into a multi-line `@serfab/cadre-core` import, `describeThrown` went at the end of the list rather than in sorted order, and new single-line imports were placed above the file's first relative import.
