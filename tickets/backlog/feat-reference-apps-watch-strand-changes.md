description: Make the reference chat apps refresh when a strand actually changes, using Optimystic's change notifications, instead of re-reading the strand every two seconds.
prereq: strand-nodes-opt-in-to-reactivity
files: packages/reference-app-rn/src/use-chat.ts, packages/reference-app-web/src/lib/messages.svelte.ts, packages/reference-app-ns/src/chat-vm.ts, packages/cadre-rn/src/phone-node/, docs/reference-app-rn.md
tradeoffs: The cold-start registration's proof of work (optimystic backlog bug-first-registration-proof-of-work-freezes-the-node-for-seconds) can freeze a phone's JS thread for seconds, so the RN app may have to wait for that fix before it can switch.
----
# Reference apps watch strand changes instead of polling

`use-chat.ts` (RN), `messages.svelte.ts` (web) and `chat-vm.ts` (NativeScript) poll the chat
strand's Quereus database every 2 s. Once `strand-nodes-opt-in-to-reactivity` lands, a chat table
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
