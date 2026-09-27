description: In the three reference chat apps, if a send fails and the user gives up instead of pressing Send again, sending that exact same text later can be silently swallowed — the app decides it is a repeat of the earlier attempt and stores nothing.
architecture: docs/schema-guide.md#client-generated-keys-and-retrying-a-write
files:
  - packages/reference-app-web/src/lib/messages.svelte.ts (`pendingDraft`, `sendMessage`, `refresh`)
  - packages/reference-app-rn/src/chat-send.ts (`ChatSender.pending`)
  - packages/reference-app-rn/src/use-chat.ts (`refresh`)
  - packages/reference-app-ns/src/chat-vm.ts (`pendingDraft`, `send`, `setMessages`, `_sendError`)
repro: static
severity: wrong-result
likelihood: unusual
tradeoffs: A maintainer could reasonably say the reference apps are demonstrations, that reaching this needs a write that fails after storing its row, and that the user who hits it gets their message through by typing one more character — against a fix that has to reach from the poll back into composer state in three separate apps.
----

# The retry key outlives the draft it belongs to

## Background: what shipped, and why

`bug-chat-resend-after-uncertain-failure-can-store-message-twice` fixed a duplicate-message bug in all three reference chat apps. A strand write can fail without settling whether it landed, so the apps now mint a message's primary key **once per composed message** and hold it across attempts: pressing Send again after a failed send re-presents the same key, and the primary key refuses the second copy. The held key — the "pending draft" — is `{ id, text }` (plus the author, on web), and a press of Send reuses it when the text still matches what is in the box.

That much is right. The problem is *when the held key is let go of*: only when a send resolves. Nothing else retires it — not the box being cleared, not the poll discovering that the uncertain write did in fact land. So the key can outlive the draft it was minted for, and then it matches text the user meant as a brand-new message.

## The defect

Take any of the three apps. A send fails in the uncertain way — the row was stored, the outcome never came back. The app says "Not confirmed sent … Press Send again", leaves the text in the box, and holds `{ id, "ok" }`.

The user does **not** press Send again. Two seconds later the poll brings the message into the list, the user sees it arrived, and clears the box by hand. The held key is still `{ id, "ok" }`.

Later in the conversation the user types `ok` again, meaning it as a new message, and presses Send. The text matches the held key, so the app treats this as a retry: it reads the row, finds it (that is the *old* message), reports success, clears the box, and **writes nothing**. The user's message is gone with no error. Short replies — "ok", "yes", "thanks" — are exactly the ones a person sends more than once, which is what makes this reachable rather than theoretical.

A second, milder symptom has the same cause: after the poll has shown the message, the "Not confirmed sent … Press Send again" banner is still up, telling the user to retry something they can see already arrived. The banner is deliberately not cleared by a successful poll (that was the point of keeping the send error separate from the poll error), so it stays until the next send.

## Root cause

One decision, at one site per app: the pending key is cleared only by a resolved send.

- `packages/reference-app-web/src/lib/messages.svelte.ts` — module-level `pendingDraft`, cleared inside `sendMessage`'s try block.
- `packages/reference-app-rn/src/chat-send.ts` — `ChatSender.pending`, cleared inside `send`.
- `packages/reference-app-ns/src/chat-vm.ts` — `ChatViewModel.pendingDraft`, cleared inside `send`.

## Expected behaviour

The key should be held exactly as long as the composer still holds the draft it was minted for, and no longer. Concretely:

- Pressing Send again on text the user has not touched since the failed attempt is still a retry, and still stores at most one row. This is the behaviour the earlier ticket bought and it must not regress.
- Editing the text away and back, or clearing the box and typing the same thing later, is a **new** message and gets a new key. The user's second "ok" is stored.
- Once the app can see the uncertain write landed, it says so instead of asking for a retry: the banner goes, and the key is retired together with it.

## Two candidate mechanisms, either or both

**Retire the key when the composer stops holding that draft.** Watch the composer text rather than comparing it only at Send: the moment the box no longer holds the pending draft's text, the key is dead. This alone closes the dropped-message hole, and it is one hook per app (NativeScript's `set draft()` setter is the natural site; web and React need the input's change handler to reach the store / sender).

**Retire the key when the poll observes the row.** The poll already reads every message; if it returns the pending key's row, the earlier attempt landed and the send is complete. Clearing the key, the send-error banner, and the box (only if it still holds that same text — never discard text the user has edited) turns the confusing banner into a correct "sent". This is the one that also fixes the second symptom.

Whichever is chosen, the invariant is worth stating in `docs/schema-guide.md` beside the pattern it belongs to, because it is the other half of the rule that section already gives: hold the key across attempts at one event, and let it go when the event is no longer the one the user is composing.

## Not in scope

Anything about whether the key is minted per draft at all, or about the read-before-rewrite retry shape. Both are settled and correct.
