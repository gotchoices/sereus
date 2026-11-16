description: A conversation created in the NativeScript sample app exists only on that phone and only until the app is closed: the user's other machines never learn of it, and after a restart nothing reopens it.
architecture: docs/platforms/reference-apps.md#founding-and-joining-chat-strands
files: packages/reference-app-ns/src/chat-strand.ts, packages/reference-app-ns/src/cadre-vm.ts, packages/reference-app-ns/src/solo-smoke.ts, packages/reference-app-ns/test/settings-view-model.spec.ts, packages/reference-app-rn/src/chat-strand.ts, packages/reference-app-ns/README.md, docs/platforms/reference-apps.md
repro: static
severity: wrong-result
likelihood: normal-use
tradeoffs: The NativeScript app exists to prove the stack runs on that runtime, not as a product, and it already trails the React Native app in several places, so a maintainer may batch this with its other parity gaps or wait for a device session.
----

# NativeScript app: "Create Chat Strand" starts a strand that is never published

## Background

Creating a strand for a party takes two steps: publishing a `Strand` row to the party's control database, which is what tells the party's other machines the strand exists and what a node reads at start to know which strands to run, and starting the strand locally as its founder. `CadreNode.foundStrand` does both in one call that is safe to repeat. `CadreNode.addStrand` is the second step only; its doc comment says it "never publishes the `Strand` row" and that "a FOUNDER wants `foundStrand`".

## The defect

`createChatStrand` in `packages/reference-app-ns/src/chat-strand.ts` builds a `StrandRow` by hand and calls `cadreNode.addStrand({ strandRow, sAppConfig, founder: true })`. Three things follow.

- **No other machine opens the strand.** No `Strand` row is written, so the party's always-on node and other devices never see it.
- **The phone itself does not reopen it after a restart.** The node restarts the strands the control database lists, and this one is not listed. `addStrand` also deliberately does not record a strand passed with `founder: true` in the joined-strand store (the `rememberable` test in `CadreNode.addStrand`), and `CadreViewModel.createStrand` (`cadre-vm.ts`) stores the id nowhere. The strand's rows stay in its SQLite file with nothing to open them, and the next tap of **Create Chat Strand** makes a new, empty strand under a new id.
- **The app never attaches a strand another machine published.** `CadreViewModel.subscribeToNodeEvents` listens for `strand:started`, `strand:stopped`, `strand:writable`, `strand:error` and `strand:commit-held`, and has no `strand:discovered` handler. `joinChatStrand` is exported from `chat-strand.ts` and has no caller.

The file's header says it was "Ported verbatim from packages/reference-app-rn/src/chat-strand.ts". The React Native file has since changed: its `createChatStrand` calls `foundStrand`, and `use-cadre.ts` joins each discovered strand through `joinChatStrand`.

The browser reference app also calls `addStrand` with `founder: true`, on one fixed strand id, and its comment in `cadre-web.ts` says that is intended ("Local to the tab"). That is not part of this ticket.

## Expected behaviour

A strand created in the NativeScript app is published to the party, is running again after the app restarts, and a strand published by another of the party's machines is attached when the node offers it, as in the React Native app.

Publishing is an owner-signed write. A phone that founded its own party is an owner. A phone that joined another cadre with a machine invitation is not, and this app's join field cannot take an owner grant yet (`feat-reference-app-ns-owner-grant-join`), so on such a phone the create must fail with a message instead of starting a local-only strand.

## Evidence and confirmation

Read from the code, not run on a device. `packages/reference-app-ns/README.md` and `docs/platforms/reference-apps.md` already list "not published" and "not reopened after a restart" as limits of the app; they change with the fix.

To confirm on an emulator: connect, tap **Create Chat Strand**, send a message, force-stop and reopen the app. The strand list is expected to be empty. With a second machine in the party, that machine's strand list is expected not to gain the strand.

The shared Maestro setup also depends on this: `_helpers/discover-phone-strand.js` waits for the drone to see the phone's strand, which cannot happen (`debt-ns-maestro-flow-parity-gaps`).
