description: In the three reference chat apps, a message that failed to send and was then abandoned kept its retry key forever, so typing the same text later was mistaken for a retry and silently dropped. The key is now let go when the composer stops holding that text, or when the message list shows the earlier attempt did land.
architecture: docs/schema-guide.md#client-generated-keys-and-retrying-a-write
files:
  - packages/reference-app-rn/src/chat-send.ts
  - packages/reference-app-rn/src/use-chat.ts
  - packages/reference-app-rn/app/index.tsx
  - packages/reference-app-rn/test/chat-send.spec.ts
  - packages/reference-app-ns/src/chat-vm.ts
  - packages/reference-app-web/src/lib/messages.svelte.ts
  - packages/reference-app-web/src/Messages.svelte
  - docs/schema-guide.md
  - docs/reference-app-rn.md
repro: verified
----

# Retire the chat retry key when its draft is gone

Each reference chat app (React Native, NativeScript, web) mints a message id once per composed message and reuses it when the same text is sent again, so a retry after a failure whose outcome is unknown cannot store a second row. Before this ticket the id (the "pending draft") was released only when a send resolved, so text the user cleared and later typed again was taken for a retry, found already stored, and silently dropped.

The key is now held exactly as long as the composer holds the draft it was minted for, and released at the first of:

- a send of it resolving;
- the composer's text (trimmed; on web, author and content) differing from the pending draft's;
- a completed read of the message list containing the pending id. That read also clears the "Not confirmed sent" notice and empties the box if it still holds that text. It is skipped while a send is in flight, because retiring the key then would leave a later failure with no key to retry under.

Sites: RN `ChatSender.composerChanged` / `ChatSender.settle` (called from `useChat.refresh`, surfaced to the screen via `onDraftSettled`); NS `ChatViewModel`'s `draft` setter and `settlePendingDraft`; web `composerChanged`, `onDraftSettled` and `settlePendingDraft` in `messages.svelte.ts`, wired from `Messages.svelte`. The rule is documented in `docs/schema-guide.md` → "Client-Generated Keys and Retrying a Write".

Tests: `packages/reference-app-rn/test/chat-send.spec.ts` reproduces the bug (clear, retype, second row stored) and pins the read-based release, including the in-flight exception. NS and web have no unit coverage for this rule; the NS arm is carried by `debt-ns-chat-vm-unit-tests` (plan/).

## Review findings

Read the diff of `ticket(implement): bug-chat-retry-key-outlives-the-draft-it-belongs-to` before the handoff, then the full current RN sender, hook and screen, the NS view model's `refresh`/`send`/`settlePendingDraft`, and the web store and component.

- **Correctness, happy path and ordering: no defect found.** The in-flight flag is set synchronously with the pending draft in every app (RN `send` sets `sending` before `store` assigns `pending`; NS sets both in the same synchronous run; web sets `pendingDraft` then `state.loading` before its first `await`), so no read can find a pending draft whose send has started while the flag is still false. In RN, `ChatSender.send`'s `finally` clears `sending` before the rejection reaches `handleSend`, so the post-failure `chat.refresh()` can settle immediately, and it sets the banner before `onDraftSettled` clears it, which is the correct order. Programmatic clears of the box (successful send, settle) do not call `composerChanged`. That is fine, because the pending draft is already null in both cases.
- **Stale or overlapping reads: no defect.** A read that began before a resend and finishes after it can only contain the pending id if that row is stored (rows are never deleted), so retiring on it is correct whatever its timing. RN settles only on reads still for the active strand. NS and web have no such check, but the id can only match on the strand that holds it.
- **Edits during an in-flight send (RN, NS): accepted by design, no action.** Web disables its inputs while `state.loading`, so there this is unreachable. On RN and NS, an edit made mid-send retires the key. If the user then edits back to the same text and resends after an uncertain failure, the resend can store a second row. The fix ticket chose this ("editing away and back is a new message"), and `docs/schema-guide.md` now documents it.
- **Pending draft not scoped to a strand: harmless, no action.** Resending the same text after switching strands reuses the UUID in a different strand's database. The pre-write read finds nothing there and inserts. No collision is possible across separate databases.
- **Docs: one stale claim, fixed.** `docs/reference-app-rn.md` said the message "can be stored at most once" however many times the user presses Send, which no longer holds once the box changes. I qualified it to unchanged text and added the two new release points. `docs/schema-guide.md` was already updated. `docs/reference-app-ns.md` does not describe the send rule (its porting table only points at `ChatViewModel.send`), so nothing there went stale. There is no web reference-app doc.
- **Tests: kept all three.** Each covers a distinct branch of `ChatSender`: the unchanged-text notification keeps the key, clearing retires it, and a read retires it except while a send is in flight. The implementer confirmed each one fails against a stubbed implementation. None restates a mock. I added no tests.
- **Type safety, error handling, resource cleanup: no findings.** No `any`. The web listener registry is unsubscribed on unmount. The `svelte/prefer-svelte-reactivity` disable carries its reason and matches existing repo practice.
- **Source hygiene: no findings.** The comments give reasons rather than narrating statements. The changed files stay small.
- **Tickets filed: none.** No finding met the filing bar.

Validation: `yarn workspace @serfab/reference-app-rn test` passes (20 files, 296 tests). `typecheck` passes for RN and NS, and web `check:svelte` reports 0 errors and 0 warnings. `yarn lint` exits 0. No e2e (Maestro/Playwright) suite was run.
