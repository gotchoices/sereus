description: In the three reference chat apps, if a send fails and the user gives up instead of pressing Send again, sending that exact same text later is silently swallowed — the app mistakes it for a retry of the earlier attempt and stores nothing. Let go of the retry key once the composer no longer holds that draft, or once the list shows the earlier attempt landed.
architecture: docs/schema-guide.md#client-generated-keys-and-retrying-a-write
files:
  - packages/reference-app-rn/src/chat-send.ts (`ChatSender`)
  - packages/reference-app-rn/src/use-chat.ts (`refresh`, `send`, result type)
  - packages/reference-app-rn/app/index.tsx (composer `onChangeText`, `sendError`, `draft`)
  - packages/reference-app-rn/test/chat-send.spec.ts
  - packages/reference-app-web/src/lib/messages.svelte.ts (`pendingDraft`, `sendMessage`, `refresh`)
  - packages/reference-app-web/src/Messages.svelte (`content`, `author`, `composeError`)
  - packages/reference-app-ns/src/chat-vm.ts (`pendingDraft`, `set draft`, `send`, `refresh`, `_sendError`)
  - docs/schema-guide.md (section "Client-Generated Keys and Retrying a Write")
  - tickets/plan/11.5-debt-ns-chat-vm-unit-tests.md (arm appended by the fix stage; no edit needed)
repro: verified
----

# Retire the chat retry key when its draft is gone

## Background

`bug-chat-resend-after-uncertain-failure-can-store-message-twice` made each of the three reference chat apps mint a message's primary key once per composed message and hold it across attempts, so pressing Send again after a failed send re-presents the same key and the primary key refuses a second copy. The held key (the "pending draft": `{ id, text }`, plus `author` on web) is reused when the text being sent matches it.

The key is released only when a send resolves. Nothing else releases it, so it can outlive the draft it was minted for.

## Reproduction (verified)

Against `ChatSender` in `packages/reference-app-rn`, with the `UncertainDatabase` fixture from `test/chat-send.spec.ts` (stores the row on the first insert, then throws):

```ts
const db = new UncertainDatabase(1);
const sender = new ChatSender();
await expect(sender.send(fakeStrand(db), 'me', 'ok')).rejects.toThrow(/outcome unknown/);
// the user sees the message arrive via the poll, clears the box, and much later types "ok" again
const result = await sender.send(fakeStrand(db), 'me', 'ok');
// actual: result.alreadyStored === true, one row stored — the second "ok" is swallowed
// expected: a new row
```

Today there is no way for the composer to tell the sender "the box was cleared", which is the defect: the held key's lifetime is tied to send outcomes only. NativeScript's `ChatViewModel.send` and web's `sendMessage` have the same rule and the same gap (read, not run — there is no chat-vm or web-store unit test; see below).

Second symptom, same cause: after the poll shows the message, the "Not confirmed sent … Press Send again" banner stays up until the next send.

Note on running the RN tests: at the time of this fix stage, `yarn workspace @serfab/reference-app-rn test` refused to start because the stale-build guard reported `@serfab/cadre-core`'s `dist` stale (cadre-core is in this repo, not a sibling, and the tree was clean — likely just a commit that landed without a rebuild). The repro above was run with a throwaway vitest config that skipped the global setup. If the guard still fires, `yarn workspace @serfab/cadre-core build` is permitted (it is not one of the read-only sibling repos), but check `git status` first for someone's in-flight cadre-core edits.

## The rule to implement (both arms, all three apps)

The key is held exactly as long as the composer still holds the draft it was minted for.

**Arm A — the composer stops holding that draft.** Whenever the composer text changes, compare it (normalised the same way the send path normalises it — all three apps trim) against the pending draft's text; if it differs, drop the pending draft. On web the author field is part of the match, so a change to either field retires it. Consequences, all intended:

- Pressing Send again on untouched text is still a retry (no regression of the earlier ticket).
- Editing away and back, or clearing and retyping the same text, is a new message with a new key.
- Web: `pendingDraft` is module-level and the component's `content`/`author` state resets on remount, so the remount's first change notification (empty box) retires it. That is correct — the draft is gone.

This arm alone closes the swallowed-message hole.

**Arm B — the poll sees the pending draft's row.** After a successful poll read, if the rows contain the pending draft's id, the earlier attempt landed: drop the pending draft, clear the send-error banner, and clear the composer **only if it still holds that same text** (never discard text the user has since edited — by Arm A, if they edited it the pending draft would already be gone, but keep the check; it is cheap and it is the invariant).

Arm B **must not act while a send is in flight.** If it retired the key mid-flight and that send then failed, the app would show "Press Send again" with the text still in the box and no pending key — and the next press would mint a new key and could store a duplicate, which is exactly the bug the earlier ticket fixed. Skipping while in flight is enough: seeing the row means it landed, so the next poll after the send settles will retire it correctly.

### Per-app shape (suggested)

**React Native** — keep the rule in `ChatSender` so it stays testable from the `node` vitest project:

- `composerChanged(text: string): void` — Arm A.
- Track in-flight in `send` (try/finally).
- `observe(ids)` (or `settle(messages)`) — Arm B; returns the retired draft's text, or null, and returns null while a send is in flight.
- `use-chat.ts`: expose `composerChanged` on `UseChatResult`; call the sender's Arm B method in `refresh` after `setMessages`, only when `strandRef.current === s`. The sender is currently created *below* `refresh` in the hook; move it above. The banner (`sendError`) and box (`draft`) live in `app/index.tsx`, so accept an option like `onDraftSettled(text)` in `UseChatOptions` (held in a ref, like `strandRef`) and in `index.tsx` implement it as `setSendError(null); setDraft(d => d.trim() === text ? '' : d)`.
- `index.tsx`: `onChangeText` calls `setDraft(t)` and `chat.composerChanged(t.trim())`.

**NativeScript** — `chat-vm.ts`:

- `set draft(value)`: after storing, retire `pendingDraft` if its text differs from `value.trim()`.
- `refresh()`: after `setMessages(messages)`, if `!this.sending` and `pendingDraft` and a message has its id → drop it, `setSendError('')`, and `this.draft = ''` if `this._draft.trim()` equals the retired text.
- Keep the existing `send` behaviour; its success path already sets `pendingDraft = null` before `this.draft = ''`, so the setter's check is a no-op there.

**Web** — `messages.svelte.ts` + `Messages.svelte`:

- Store: export `composerChanged(author, content)` (Arm A). Track in-flight for `sendMessage` (a module flag, or `state.loading` if nothing else sets it during a send — check). In `refresh`, after assigning `state.messages`, apply Arm B and notify the component through a subscription such as `onDraftSettled(cb): () => void` (register in `onMount`, return the unsubscribe).
- Component: call `composerChanged(author.trim(), content.trim())` from an `$effect` reading both fields (or `oninput` on both inputs); in the settle callback set `composeError = null` and clear `content` only if `content.trim()` still equals the settled text (and the author matches).
- Note `state.error` (poll error) and `composeError` (send error) are separate; only `composeError` is the retry banner.

The three apps are separate packages with no shared app-logic module, so this is written three times. If NS or web end up with more than a few lines of rule, mirror `ChatSender`'s shape (a small pending-draft holder class) in that package rather than inlining it across methods.

## Tests

Extend `packages/reference-app-rn/test/chat-send.spec.ts` only (the rule's one unit-testable home):

- The reproduction above, with `sender.composerChanged('')` between the two sends → two rows. This is the bug's reproduction.
- Arm B: after an uncertain failure, the observe/settle method with the stored rows' ids retires the key (returns the text; a following send of the same text mints a new id and stores a second row), and returns null / leaves the key alone while a send is in flight. One test; the in-flight guard is the branch that matters.
- Optionally fold a `sender.composerChanged('hello')` (unchanged text) into the existing "stores one row" test, to pin that untouched text stays a retry — rather than a separate test.

No NS test: `chat-vm.ts` cannot be loaded under vitest yet (`ObservableArray` import blocker). That coverage is owned by `debt-ns-chat-vm-unit-tests` (plan/), to which this fix stage appended an arm for this behaviour. No web store test exists or is required here.

## Docs

`docs/schema-guide.md`, section "Client-Generated Keys and Retrying a Write": the paragraph ending "…`tickets/backlog/bug-chat-retry-key-outlives-the-draft-it-belongs-to.md`. Hold the key while the event is still the one being composed, and let it go when it is not." points at this ticket as an open question. Replace the ticket reference with the settled rule: the key is released when the composer no longer holds the text it was minted for, or when a read shows the earlier attempt's row (never while an attempt is in flight), and name where each app does it. Update the doc comments on `ChatSender`, `ChatViewModel.send`, `ChatViewModel.pendingDraft`, and `sendMessage` / `pendingDraft` on web that say the key is held "until a send resolves".

## TODO

- RN: add `composerChanged`, in-flight tracking and the Arm B settle method to `ChatSender`; update its doc comment.
- RN: wire `use-chat.ts` (move sender above `refresh`, settle after `setMessages`, `onDraftSettled` option, expose `composerChanged`) and `app/index.tsx` (`onChangeText`, settle callback clearing banner and matching box text).
- RN: extend `test/chat-send.spec.ts` as described under Tests; confirm the reproduction test fails before the change.
- NS: `set draft` retirement; Arm B in `refresh` guarded by `!this.sending`; update doc comments.
- Web: `composerChanged` + in-flight flag + Arm B in `refresh` + `onDraftSettled` subscription in the store; `$effect`/`oninput` and settle callback in `Messages.svelte`.
- Docs: rewrite the schema-guide paragraph as described.
- Run `yarn workspace @serfab/reference-app-rn test`, `yarn lint`, and the type checks for the three app packages (see each package's `package.json` for its typecheck script).
