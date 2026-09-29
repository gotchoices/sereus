description: In the three reference chat apps, a message that failed to send and was then abandoned kept its retry key forever, so typing the same text later was mistaken for a retry and silently dropped. The key is now let go when the composer stops holding that text, or when the message list shows the earlier attempt did land.
architecture: docs/schema-guide.md#client-generated-keys-and-retrying-a-write
files:
  - packages/reference-app-rn/src/chat-send.ts (`ChatSender.composerChanged`, `settle`, in-flight flag, `store`)
  - packages/reference-app-rn/src/use-chat.ts (sender moved above `refresh`; `settle` after `setMessages`; `onDraftSettled` option; `composerChanged` in result)
  - packages/reference-app-rn/app/index.tsx (`handleChangeText`, `onDraftSettled` clears banner and matching box text)
  - packages/reference-app-rn/test/chat-send.spec.ts
  - packages/reference-app-ns/src/chat-vm.ts (`draft` setter, `settlePendingDraft`, doc comments)
  - packages/reference-app-web/src/lib/messages.svelte.ts (`composerChanged`, `onDraftSettled`, `settlePendingDraft`)
  - packages/reference-app-web/src/Messages.svelte (`$effect` calling `composerChanged`, `settleDraft`)
  - docs/schema-guide.md (section "Client-Generated Keys and Retrying a Write")
repro: verified
----

# Retire the chat retry key when its draft is gone

## What was wrong

`bug-chat-resend-after-uncertain-failure-can-store-message-twice` made each reference chat app mint a message id once per composed message (the "pending draft") and reuse it when the same text is sent again, so a retry after an uncertain failure cannot store a second row. The pending draft was released only when a send resolved. After a failed send that had in fact landed, a user who saw the message arrive and cleared the box still left the key alive; typing the same text later (e.g. "ok") was treated as a retry, found the old row, reported success and stored nothing. The "Not confirmed sent … Press Send again" banner also stayed up after the poll showed the message.

## The rule now implemented (all three apps)

The key is held exactly as long as the composer holds the draft it was minted for. It is released at the first of:

- a send of it resolving (unchanged);
- **Arm A** — the composer text (trimmed; on web, author and content) differing from the pending draft's. Any edit, including clearing and retyping the same words, makes a new message with a new key;
- **Arm B** — a completed poll read whose rows contain the pending id. The app then also clears the send-error banner and clears the box only if it still holds that text. Arm B does nothing while a send is in flight.

Where it lives:

- **RN** — `ChatSender.composerChanged(text)` (Arm A) and `ChatSender.settle(messages): string | null` (Arm B, returns the retired text; null while `sending`). `send` now wraps a private `store` in try/finally to track in-flight. `useChat` calls `settle` after `setMessages` (only reached when the read is still for the active strand) and forwards a hit to `opts.onDraftSettled` (held in a ref). `index.tsx` calls `chat.composerChanged(text.trim())` from `onChangeText` and implements `onDraftSettled` as `setSendError(null); setDraft(d => d.trim() === text ? '' : d)`.
- **NS** — `ChatViewModel`'s `draft` setter retires the pending draft when its text differs from `value.trim()`. `refresh` calls `settlePendingDraft(messages)` after `setMessages`; it is guarded by `this.sending`, and it clears `_sendError` and (if the box still matches) the draft.
- **Web** — store exports `composerChanged(author, content)` and `onDraftSettled(listener) => unsubscribe`; `refresh` calls `settlePendingDraft(messages)`, guarded by `state.loading`. Only `sendMessage` writes `state.loading`, and it is true for exactly the length of a send, so it serves as the in-flight flag. `Messages.svelte` runs `composerChanged(author.trim(), content.trim())` in an `$effect` and subscribes `settleDraft` in `onMount` (it sets `composeError = null` and clears `content` only when both fields still match). The listener `Set` has a line-level `svelte/prefer-svelte-reactivity` disable with its reason, which is how the repo already handles non-reactive sets (`diagnostics.svelte.ts`).
- **Docs** — the schema-guide paragraph that pointed at this ticket as an open question now states the settled rule (three release points, the in-flight exception and why) and names each app's site. Doc comments on `ChatSender`, `ChatViewModel.pendingDraft` / `_sendError` / `send`, and web `PendingDraft` / `sendMessage` no longer say "until a send resolves".

## Tests added (`packages/reference-app-rn/test/chat-send.spec.ts`)

- **"stores the same text again once the composer has let go of the draft"** reproduces the bug: an uncertain failure, then `composerChanged('')`, then the same text again, must produce two rows. I confirmed it fails with `composerChanged` as a no-op (`alreadyStored` was `true`, one row stored).
- **"lets a read that shows the earlier attempt retire its key, but not while a send is in flight"**:
  - `settle` returns null while a resend is in flight. The send is started without being awaited, so it is suspended at its first `await`.
  - After a later uncertain failure, `settle` over the stored rows returns the text, and the next send of that text mints a new id and stores a second row.
  - With the stubbed `settle`, the positive half failed (`null` instead of `'yes'`).
- The existing "stores one row …" test now calls `composerChanged('hello')` (unchanged text) between the attempts, which confirms that a change notification with the same text keeps the retry.

## Validation run

- `yarn workspace @serfab/reference-app-rn test`: 20 files, 296 tests pass.
- `yarn workspace @serfab/reference-app-web test`: 66 pass. `yarn workspace @serfab/reference-app-ns test`: 110 pass. Neither package tests this rule; I ran them to confirm nothing they load broke.
- `typecheck` passes for RN, NS and web; `check:svelte` for web reports 0 errors and 0 warnings.
- `yarn lint` is clean.
- The stale-build guard reported `@serfab/cadre-core` `dist` stale, as the fix stage predicted. `git status` showed no in-flight cadre-core edits (its last source commit landed after the last build), so I ran `yarn workspace @serfab/cadre-core build`. No sibling repo was touched.

## Known gaps / things for the reviewer to weigh

- **No NS or web test for this rule.** `chat-vm.ts` cannot load under vitest yet (the `ObservableArray` import); that coverage is owned by `debt-ns-chat-vm-unit-tests` in plan/, which already has an arm for exactly this behaviour. The web store has no unit test harness for this. I verified both by reading the code and type checking, not by running them. I ran no e2e (Maestro / Playwright) suite.
- **Edits made while a send is in flight also retire the key (Arm A has no in-flight guard, by the ticket's design).** On RN and NS the text box stays editable during a send. If the user types a character and deletes it during a slow commit, the key is retired. If that send then fails but had in fact landed, the next Send mints a new key and can store a second row. This is the ticket's "editing away and back is a new message" consequence. It is narrower mid-flight but not zero. A possible tightening is to defer Arm A while `sending` and re-check when the send settles. I did not do it because the ticket specified Arm A without a guard.
- **Web uses `state.loading` as the in-flight flag.** This is correct today (only `sendMessage` writes it). If something else starts setting `loading`, Arm B will only skip more often, which is harmless: it retires later.
- **RN resolves faster than web.** RN's `handleSend` already calls `chat.refresh()` after a failed send, so on RN a failure that actually landed usually settles right away: the banner appears briefly, then clears along with the box. Web and NS wait for the next poll (4 s / 2 s).
- **Unchanged here:** a successful send still clears the whole box (RN `setDraft('')`, NS `this.draft = ''`, web `content = ''`), including anything typed during the send. The pending draft is also not scoped to a strand (switching strands with the same text still in the box counts as a retry on the new strand, and the read-before-write finds nothing there and inserts).
