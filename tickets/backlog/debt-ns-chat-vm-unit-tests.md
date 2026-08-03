description: The chat screen's logic in the NativeScript phone app still has no automated tests, because the list-of-messages helper it uses cannot be loaded outside a real phone without extra setup.
files: packages/reference-app-ns/src/chat-vm.ts, packages/reference-app-ns/src/chat-operations.ts, packages/reference-app-ns/src/chat-strand.ts, packages/reference-app-ns/vitest.config.ts, packages/reference-app-ns/test/stubs/nativescript-core.ts
difficulty: medium
---

# Chat view model is still untested on `reference-app-ns`

## Situation

`debt-ns-unit-test-harness` gives `reference-app-ns` a Vitest runner, and
`debt-ns-invite-trust-tests` covers `src/cadre-vm.ts` and the Settings view
model. `src/chat-vm.ts`, `src/chat-operations.ts` and `src/chat-strand.ts`
remain uncovered.

The blocker is narrow and measured. `chat-vm.ts` imports both `Observable` and
`ObservableArray` from `@nativescript/core`. The test stub those two tickets
introduce re-exports `Observable` from
`@nativescript/core/data/observable/index.js`, which loads fine under plain
Node. `ObservableArray` does not: its module imports `'../observable'` as a
bare directory, and Node's ESM loader rejects that for a dependency Vitest has
externalized —

```
Error [ERR_UNSUPPORTED_DIR_IMPORT]: Directory import '.../@nativescript/core/data/observable'
  is not supported resolving ES modules imported from .../data/observable-array/index.js
```

## What would resolve it

Most likely `server.deps.inline` for `@nativescript/core` in the package's
`vitest.config.ts`, so Vite transforms the submodule and resolves the directory
import the way a bundler would, rather than handing it to Node. Whether that
pulls in more of the NativeScript runtime than will load headlessly is unknown
and is the thing to find out first. A hand-written `ObservableArray` double is
the fallback, with the usual cost: it can drift from the real one.

## Expected outcome

- The chat view model's own logic is covered without a device: message list
  updates, the strand-attach and detach paths, and what happens when no strand
  is available.
- `chat-operations.ts` / `chat-strand.ts` covered against a fake strand, to
  whatever depth is reachable without the SQLite plugin.
- Whatever unblocks `ObservableArray` is written down where the next person
  meets it, not only in this ticket.

## Not in scope

The screen files themselves (`app/chat/chat-page.ts`, the XML) stay with the
Maestro e2e flows — see `debt-ns-maestro-flow-parity-gaps`.
