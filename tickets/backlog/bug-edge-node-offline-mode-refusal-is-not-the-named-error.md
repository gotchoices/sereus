description: On a platform that cannot save unsent changes, asking a phone or browser app's node to switch on offline mode fails with a generic error where the platform's own contract and two documents promise a specific, recognisable one, so an app cannot tell "not supported here" from any other failure.
architecture: docs/strands/writes.md#on-the-edge-node
files: packages/cadre-core/src/edge-node/edge-node.ts (`EdgeNode.setStrandOfflineMode`), packages/cadre-core/src/edge-node/platform.ts (comment on `EdgeNodeStorage.offlineJournal`), packages/cadre-core/src/strand-offline.ts (`StrandOfflineUnavailableError`), docs/cadre/node.md, docs/platforms/nativescript.md, docs/api.md
repro: static
severity: cosmetic
likelihood: unusual
tradeoffs: Only NativeScript and custom platforms lack the journal, an app can test for the journal itself before offering the setting, and `feat-strand-offline-mode-nativescript` removes the only shipped platform that reaches this path.
----

# `EdgeNode.setStrandOfflineMode` throws a plain `Error` where `StrandOfflineUnavailableError` is promised

## What is wrong

The edge node (`createEdgeNode`, used by the React Native kit, the browser app and the NativeScript app) has its own `setStrandOfflineMode(mode)`, which sets the mode for every strand and saves it for the next start. On a platform whose storage implements no `offlineJournal` it throws

```ts
throw new Error('Cannot set the offline mode: this platform keeps no offline journal');
```

The platform contract says otherwise. The comment on `EdgeNodeStorage.offlineJournal` in `edge-node/platform.ts` ends: "Absent: no offline mode on this platform (`setStrandOfflineMode` throws `StrandOfflineUnavailableError`)." A platform author reading that contract, and an app author reading `docs/cadre/node.md` → "What the platform supplies" or `docs/platforms/nativescript.md` → limits, will write `catch (e) { if (e instanceof StrandOfflineUnavailableError) … }` around the edge node's call and never match.

`StrandOfflineUnavailableError` is thrown only by the per-strand `CadreNode.setStrandOfflineMode(strandId, mode)` on a node configured without `strandOffline`. Its constructor takes a strand id and its message names one strand, so the edge node's all-strands call cannot construct it as it stands. `docs/api.md` (the edge-node table) and `docs/strands/writes.md` → "Turning it on" describe the plain `Error` correctly; the two documents above and the contract comment do not, and `tickets/backlog/feat-strand-offline-mode-nativescript.md` repeats the contract's wording.

## Expected behaviour

One recognisable refusal for "this node has no offline journal", whichever of the two calls an app makes: either the edge node throws `StrandOfflineUnavailableError` (with the strand id made optional, or a sibling class under a shared base), or the contract comment and the two documents are corrected to say a plain `Error`. The first serves an app that hides its offline setting on an unsupported platform; the second is the smaller change. The edge node's other plain throw, "the edge node is not running", is a different condition and should stay distinguishable from this one.

## Evidence and confirmation

Read from `edge-node.ts` and `platform.ts`; not run. To confirm: build an edge node over a platform whose `storage` has no `offlineJournal`, start it, call `setStrandOfflineMode('offline')`, and check the rejection's class.
