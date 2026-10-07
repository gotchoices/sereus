description: Make the reference chat apps refresh when a strand actually changes, using Optimystic's change notifications, instead of re-reading the strand every two seconds.
prereq: strand-reactivity-scenario
files: packages/reference-app-rn/src/use-chat.ts, packages/reference-app-web/src/lib/messages.svelte.ts, packages/reference-app-ns/src/chat-vm.ts, packages/cadre-rn/src/phone-node/, docs/reference-app-rn.md
tradeoffs: The cold-start registration no longer freezes a phone's JS thread: since Optimystic 1.12.0 a strand node self-endorses with its peer key instead of solving a proof of work (Optimystic #31). Re-measure the first-registration latency on a phone before switching the RN app.
----
# Reference apps watch strand changes instead of polling

`use-chat.ts` (RN), `messages.svelte.ts` (web) and `chat-vm.ts` (NativeScript) poll the chat
strand's Quereus database every 2 s. Once `strand-reactivity-node-option` and `strand-reactivity-scenario` land, a chat table
tagged `optimystic.network_watch` on a node with the strand reactivity option fires
`Database.watch` on another machine's commit.

- Turn the option on for the chat strand in each app's node config (the RN kit's
  `createPhoneNode` `configure` hook, or a kit-level option if that reads better).
- Replace the interval with a `db.watch(scope, …)` subscription that triggers the existing
  `refresh`, keeping a slow fallback timer only if the watch service's own tail tick (20 s edge)
  proves too slow in practice.
- Keep the existing single-flight refresh guards; a watch can fire twice for one commit on a
  machine that both stores and watches the table.
- Measure on a device before switching the RN app (see tradeoffs).
