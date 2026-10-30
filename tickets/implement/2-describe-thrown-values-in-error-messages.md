description: Code that turns a caught value into a message uses `err instanceof Error ? err.message : String(err)`. Anything that isn't an `Error` then reads `[object Object]`, which is what a React Native WebSocket failure usually is, so `relayStatus().error` could not say why a phone's relay reservation kept retrying (gotchoices/sereus#54). Add one helper that describes any thrown value, use it at every such site, and add a lint rule so the pattern does not come back.
architecture: docs/testing.md
files: packages/cadre-core/src/relay-reservation.ts (~608, ~766, ~1088), packages/cadre-core/src/index.ts, packages/cadre-host/src/hosted/node-status.ts (`errorMessage` ~95), packages/reference-app-rn/src/settings-controls.tsx (`errorMessage` ~133), packages/reference-app-web/src/lib/cadre-format.ts (`errorMessage` ~35), eslint.config.mjs, docs/testing.md ("Lint coverage")
----
## Report

gotchoices/sereus#54. On Sereus 1.19.0 / `@serfab/cadre-rn` on a Galaxy S7 (Hermes), the phone's reservation on relay.sereus.org stayed `retrying` for minutes with `"error": "[object Object]"`. The reporter traced it to the three `String(reason)` fallbacks in `relay-reservation.ts` and proposed a describer (in the issue).

## Scope (measured)

`grep -rnE "instanceof Error \? *[a-zA-Z_.]+\.message *: *String\(" packages/*/src` (excluding tests) finds **90 sites in 30 files**: cadre-core (relay reservation, strand instance manager, first-sync gate, formation protocol, protocol guard), cadre-cli, cadre-provider, and the three reference apps. Three packages already define their own `errorMessage(err: unknown)` (cadre-host `hosted/node-status.ts`, reference-app-rn `settings-controls.tsx`, reference-app-web `lib/cadre-format.ts`).

## Design

- **One helper in cadre-core**, exported from the package root and platform-neutral (no Node or DOM imports), for example `describeThrown(value: unknown): string`.
  - An `Error` gives its `message` (keep today's text exactly, since specs and users match on it).
  - A non-null object gives its string `type`, `message`, `reason` and `code` fields joined, when it has any. That covers RN and browser WebSocket `Event`/`CloseEvent` (`type`, `code`, `reason`) and libp2p's plain-object rejections.
  - Otherwise `JSON.stringify`, guarded (a cycle, a BigInt, or an object whose `JSON.stringify` gives `{}` or throws falls through).
  - Otherwise `String(value)`.

  Keep the result bounded, truncating a huge stringified object, because it lands in status payloads and logs.
- **Replace all 90 sites** with the helper, and delete the three local `errorMessage` copies in favour of it. cadre-cli, cadre-provider and the reference apps already depend on cadre-core. Check that cadre-host and reference-app-ns import from cadre-core too; if any package doesn't, say so and leave its copy with a note.
- **Lint rule** (`eslint.config.mjs`): a `no-restricted-syntax` selector for a conditional whose test is `instanceof Error` and whose alternate is a `String(…)` call, with a message naming the helper. Add it to the `docs/testing.md` "Lint coverage" list. Every encoded rule is `error`, per AGENTS.md. If the selector can't be made exact, say so rather than writing a loose one that flags unrelated code.

## Edge cases & interactions

- `AggregateError` and errors with a `cause` give `message` only, as today. Don't start walking `cause` here; `control-retry.ts` has its own `causeChain` for classification, and messages users see would change.
- An object whose `message` field is itself an object: skip non-string fields.
- `null`, `undefined`, numbers and strings: `String()` output, as today.
- Sites that build an error from a caught value and rethrow (`new Error(describe(err))`) keep their shape. Only the text improves.

## Tests

One spec for the helper, covering an `Error`, a WebSocket-event-shaped object, a plain object with no known fields, a cyclic object, and a primitive. It is new branching logic. No tests at the call sites: the lint rule enforces the pattern there.

## TODO

- Add and export the helper with its spec.
- Replace the 90 sites; remove the three local copies.
- Add the lint rule; update `docs/testing.md` → "Lint coverage".
- `yarn lint`, `yarn typecheck`, `yarn build`, tests of every touched workspace.
