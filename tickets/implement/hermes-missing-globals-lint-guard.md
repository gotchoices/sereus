description: The phone apps carry a note saying a database library still leaks cancellation hooks on every successful request; that stopped being true when the library was fixed a week later, so the note now misleads anyone who reads it. Correct it, and add a linter rule so our own code cannot reach for the browser features the phone runtimes lack.
architecture: docs/reference-app-rn.md#global-polyfills-polyfillshermesjs
files: eslint.config.mjs, packages/reference-app-rn/polyfills/hermes.js, packages/reference-app-ns/src/polyfills/abort.ts, docs/reference-app-rn.md
difficulty: easy
----

# The `AbortSignal.any` leak is gone; its warning is not

## Where this came from

`tickets/fix/bug-abortsignal-any-leaks-listeners-on-hermes.md` reported that on the two phone runtimes — Hermes under React Native, and NativeScript's V8 — every successful remote block request left one `abort` listener behind on the caller's cancellation signal, and that an app holding a session-long signal would accumulate them.

**That leak no longer exists.** The single named call site, `../optimystic/packages/db-p2p/src/repo/client.ts`, stopped calling `AbortSignal.any` in optimystic commit `7e9cfbaf` (2026-09-16, `ticket(implement): a-library-call-that-does-not-exist-on-phones`). It now builds the combination by hand and removes both listeners in a `finally`, so nothing is left attached whether the request succeeds or fails. The built `dist` that sereus resolves against carries that change (`packages/db-p2p/dist/src/repo/client.js` lines 73–98). Optimystic's sibling call sites — `protocol-client.ts` at both its dial and its response-read — are symmetric too.

The other two callers the docs name are equally clear. Quereus never used `AbortSignal.any`: `../quereus/packages/quereus/src/util/abort-signal.ts` is an explicit combiner returning a `dispose()` its callers run in a `finally`. `p-wait-for` does use it, but always pairs the caller's signal with an `AbortSignal.timeout`, which always fires, so the polyfill's detach always runs — and when no finite timeout is given it does not combine at all.

Measured on 2026-09-24 against the installed tree:

```bash
grep -rn "AbortSignal\.any(" node_modules/ --include=*.js --include=*.mjs --include=*.cjs -l
# → node_modules/p-wait-for/index.js   (the only one)
grep -rn "AbortSignal\.any(" packages/*/src --include=*.ts --include=*.tsx
# → no matches: no first-party sereus source calls it
```

libp2p's own multi-signal sites (`libp2p/dist/src/connection-manager/dial-queue.js:131`, `@libp2p/circuit-relay-v2/dist/src/transport/discovery.js:201`) use the `any-signal` package and call `signal.clear()` in a `finally`.

So nothing in the shipped tree leaks today. What is left is a record that says otherwise, and no guard against the pattern coming back.

## What is wrong now

Three places still assert the leak as a live fact and point at a ticket that will not exist after this one lands:

- `packages/reference-app-rn/polyfills/hermes.js`, the comment block above `AbortSignal.any` (around line 330): *"Optimystic's repo client … hits this on every RPC that succeeds — its deadline controller is cleared, not aborted — see backlog ticket bug-abortsignal-any-leaks-listeners-on-hermes."*
- `packages/reference-app-ns/src/polyfills/abort.ts`, the comment above `static any` (around line 65): the same sentence.
- `docs/reference-app-rn.md` line 289, the `AbortSignal.any()` row of the global-polyfills table: names `@optimystic/db-p2p`'s repo client and `@quereus/quereus` as callers (neither is one any more) and repeats the same claim plus the ticket reference.

A reader who trusts any of those will go looking for a leak that was fixed a week after the note was written.

The underlying limitation is real but is now purely conditional, so it belongs in the code as a tripwire rather than as an open defect: a polyfilled `AbortSignal.any` whose inputs **all** fail to abort keeps its listeners on those inputs forever, because the DOM holds combined signals weakly and neither phone runtime offers an equivalent hook. No caller does that today. If one ever does, the fix belongs at that call site — an explicit combination it can release, the way optimystic's repo client and quereus's `combineAbortSignals` both do — not in the polyfill, which has no way to learn that a combination is finished.

## The guard

Optimystic already closed this class in its own repo, in the same commit that fixed the call site: `../optimystic/eslint.config.js` bans `AbortSignal.timeout(...)`, `AbortSignal.any(...)`, `Promise.withResolvers(...)` and `new DOMException(...)` in `packages/*/src/**/*.ts` via `no-restricted-syntax`, each with a message naming the replacement. Sereus — the repo that actually *ships* the two phone apps and hosts both polyfills — has no equivalent, so first-party sereus code can reach for any of them freely.

Mirror it here. Measured against `packages/*/src` on 2026-09-24, all four selectors have **zero** current violations except one, so this lands as a gate rather than a cleanup epic:

| Selector | Current hits in `packages/*/src` |
|---|---|
| `AbortSignal.timeout(` | none |
| `AbortSignal.any(` | none |
| `Promise.withResolvers(` | none |
| `new DOMException(` | one — `packages/reference-app-ns/src/polyfills/abort.ts:21` |

That one hit is the NativeScript abort polyfill's own feature-detected fallback (`if (typeof DOMException !== 'undefined') return new DOMException(...)`), which is exactly the code allowed to do this. Handle it with a one-line `// eslint-disable-next-line no-restricted-syntax` carrying that reason, rather than a config-level exemption — an exemption block in `eslint.config.mjs` would have to switch `no-restricted-syntax` off wholesale for the file, which would also drop the unrelated `CadreControl.CadrePeer` SQL guard that shares the rule.

The React Native polyfill (`packages/reference-app-rn/polyfills/hermes.js`) needs no exemption: it is `.js` and sits outside any `src/` tree, so the scope does not reach it. The NativeScript polyfill's `static any` / `static timeout` are class member definitions, not `AbortSignal.x(...)` call expressions, so they do not match either.

Scope the rules to all of `packages/*/src/**/*.{ts,tsx}`, matching optimystic. That includes the two browser-only apps (`reference-app-web`, `cadre-host/ui`) where these APIs do exist — accepted deliberately: they have zero uses today, so the rule costs nothing, and a genuinely browser-only need is one `eslint-disable` line with a stated reason. Follow optimystic in **not** banning `AbortSignal.prototype.throwIfAborted()`: libp2p and its dependencies require it regardless, both apps' polyfills supply it, and banning it would move the requirement without removing it.

`eslint.config.mjs` already has the shape to copy — the `CadreControl.CadrePeer` block at lines 124–138 defines `no-restricted-syntax` entries with explanatory messages. Add the new selectors to a rules block scoped to `packages/*/src/**/*.{ts,tsx}`; keep them as named consts with a comment above, the way optimystic's config does, so the reason survives.

Note `tickets/backlog/debt-tooling-scripts-unlinted-and-unchecked` also touches `eslint.config.mjs`, but for an unrelated concern (the `scripts/**` entries in the global `ignores` block). No conflict beyond the file.

## No new tests

`yarn lint` is the enforcement; a test asserting the lint rule fires would duplicate the gate. The existing polyfill specs already pin the behaviour that matters — `packages/reference-app-rn/test/polyfills/hermes-polyfills.spec.ts` ("detaches from the inputs that did not fire", "registers nothing when an input is already aborted") and the matching cases in `packages/reference-app-ns/test/polyfills.spec.ts`. Both were green at HEAD on 2026-09-24 (`yarn workspace @serfab/reference-app-rn vitest run --project polyfills` — 3 files, 30 tests). Leave them alone; do not add a test that pins the never-aborting case, which would be encoding a known limitation as expected behaviour.

## Do not edit the siblings

`../optimystic` and `../quereus` are read-only here (`tickets/rules/sibling-repos.md`). Everything above about them is context for the wording, not work. Do not build them either.

## TODO

- Add the `no-restricted-syntax` selectors for `AbortSignal.timeout(...)`, `AbortSignal.any(...)`, `Promise.withResolvers(...)` and `new DOMException(...)` to `eslint.config.mjs`, scoped to `packages/*/src/**/*.{ts,tsx}`, each with a message naming the cross-platform reason and the replacement pattern (explicit `AbortController` + timer; explicit combinator disposed in a `finally`; hand-built `{ promise, resolve, reject }`; plain named `Error`). Mirror the wording in `../optimystic/eslint.config.js`.
- Add a comment above the block explaining what it is for and why `throwIfAborted` is deliberately not in it.
- Add `// eslint-disable-next-line no-restricted-syntax` with its reason at `packages/reference-app-ns/src/polyfills/abort.ts:21`, the polyfill's own feature-detected `DOMException` fallback.
- Rewrite the `AbortSignal.any` comment in `packages/reference-app-rn/polyfills/hermes.js`: drop the claim about optimystic's repo client and the ticket reference; state as a `NOTE:` tripwire that a combination whose inputs all fail to abort keeps its listeners for as long as the inputs live, that no caller does this today (`p-wait-for`, the only dependency that calls it, always pairs with an `AbortSignal.timeout`), and that the fix for any future one belongs at that call site.
- Make the same correction to the comment above `static any` in `packages/reference-app-ns/src/polyfills/abort.ts`.
- Update the `AbortSignal.any()` row of the global-polyfills table in `docs/reference-app-rn.md` (line 289): "Required by" becomes `p-wait-for` (pulled in by libp2p, @libp2p/websockets, @libp2p/circuit-relay-v2, @libp2p/webrtc and @libp2p/tcp) — remove `@optimystic/db-p2p`'s repo client and `@quereus/quereus`, neither of which calls it. Replace the leak sentence and ticket reference with the same conditional statement, and mention that the lint rule now keeps first-party sereus source off it.
- Run `yarn lint` and confirm it passes with no new violations.
- Run `yarn workspace @serfab/reference-app-rn vitest run --project polyfills` and `yarn workspace @serfab/reference-app-ns test`; both should stay green (no test changes expected).
