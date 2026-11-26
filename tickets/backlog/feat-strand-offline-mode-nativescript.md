description: The NativeScript reference chat can now queue messages while it has no one to send them to, but there is nothing on screen for it: no switch to turn offline sending on, no line saying how many messages are waiting, and no way to see or drop one that has not gone out.
architecture: docs/strands/writes.md
files: packages/reference-app-ns/app/settings/settings-page.xml, packages/reference-app-ns/app/settings/settings-view-model.ts, packages/reference-app-ns/app/chat/chat-page.xml, packages/reference-app-ns/app/chat/chat-page.ts, packages/reference-app-ns/src/chat-vm.ts, packages/reference-app-ns/src/chat-operations.ts, packages/reference-app-ns/src/test-ids.ts, docs/platforms/reference-apps.md
tradeoffs: NativeScript is a reference platform with no shipping app behind it, and the other two reference apps already demonstrate every part of this surface, so a maintainer may reasonably leave NativeScript without it.
----

# Offline mode on screen in the NativeScript reference chat

## Where this stands

The platform half landed with the Optimystic 1.30 adoption. `ns-edge-platform.ts` implements `offlineJournal(scope)` over the scope's own SQLite database — upstream's own key-value store, through upstream's own factory, so the two questions this ticket used to ask before building (whether that store flushes, and whether the block store would read the journal's keys as blocks) are answered by construction: Optimystic declares the journal's key prefix among the node's own namespaces precisely so one store serves both. `CadreNode.setStrandOfflineMode` no longer refuses on NativeScript, and a NativeScript strand now builds its offline queue even in online mode.

What is left is the reference chat's own surface. `docs/platforms/reference-apps.md` → "Offline mode" describes it for the other two apps and already records this app's absence of it.

## What is wanted

The same four things the React Native and browser chats show, so the three reference apps demonstrate one feature rather than two-thirds of one:

- **A switch that turns offline mode on**, on the Settings page beside the other node controls, calling `setStrandOfflineMode` on the edge node. It changes every strand at once and the choice is saved with the start options, so a restart comes back in the same mode.
- **A line above the message list reporting the queue's state**, from the node's `strand:queue-state` event.
- **A mark per message**, following the same progression the other two apps use: waiting to send, possibly not delivered, delivered. The marks follow `CadreNode` events rather than listeners on the strand's offline queue, because a hibernation rebuilds the database object while the node's events continue across it.
- **Discard on a waiting message that no send attempt can have delivered**, calling the queue's own discard.

Restoring a mark after a restart needs the chat's own node-local record linking a queued transaction id back to the message it holds; the other two apps keep one (`queued-messages.ts`), and it is the app's record, not the kit's.

When this lands, the limits paragraph in `docs/platforms/reference-apps.md` loses its NativeScript clause.
