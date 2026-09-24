description: In the three reference chat apps, pressing Send again after a send that failed could post the same message twice. Each draft now gets one identity that survives a failed attempt, so a resend can only ever replace the earlier one, never add to it.
architecture: docs/schema-guide.md#ordering-events-there-is-no-commit-order-column
files:
  - packages/reference-app-web/src/lib/chat-dml.ts (`newChatMessageId`, `insertChatMessage`, `chatMessageExists`)
  - packages/reference-app-web/src/lib/messages.svelte.ts (`PendingDraft`, `sendMessage`)
  - packages/reference-app-web/src/Messages.svelte (`onSubmit` failure text)
  - packages/reference-app-web/src/lib/cadre-web.ts (`writeChatMessage`)
  - packages/reference-app-web/e2e/fixtures/formation-responder.ts (`ensureSeeded`)
  - packages/reference-app-rn/src/chat-send.ts (new — `ChatSender`)
  - packages/reference-app-rn/test/chat-send.spec.ts (new)
  - packages/reference-app-rn/src/chat-operations.ts (`newChatMessageId`, `insertMessage`, `messageExists`)
  - packages/reference-app-rn/src/use-chat.ts (`send`)
  - packages/reference-app-rn/app/index.tsx (`handleSend`, `sendError`)
  - packages/reference-app-rn/test/react/use-chat.spec.ts (mock surface only)
  - packages/reference-app-ns/src/chat-operations.ts (`newChatMessageId`, `insertMessage`, `messageExists`)
  - packages/reference-app-ns/src/chat-vm.ts (`pendingDraft`, `send`, `_sendError`)
  - packages/reference-app-ns/src/solo-smoke.ts
  - docs/schema-guide.md ("Client-Generated Keys and Retrying a Write")
repro: verified
----

# The message id belongs to the draft, not to the attempt

## What shipped

All three reference chat apps used to mint the `App.Message` primary key *inside* the insert call. That made a send attempt unrepeatable: the same typed text sent twice produced two different keys, so the primary key could not recognise the second attempt as the same message. A strand write can fail without settling whether it landed — there is no retry funnel over strand writes the way `control-write-retry.ts` covers control writes — so a user pressing Send again after a failed-but-actually-stored write got the message twice, on every peer, permanently.

The id is now a parameter of the insert and belongs to the composed draft:

- **`newChatMessageId()`** is exported from each app's DML module, and the insert (`insertChatMessage` web, `insertMessage` rn/ns) takes `id` as its first data argument. The three one-shot callers that never re-present a write — `cadre-web.ts` `writeChatMessage`, the e2e `formation-responder.ts` seed, `reference-app-ns/src/solo-smoke.ts` — mint at their own call site and keep their signatures. `insertChatMessage` now returns `void` rather than the id it no longer invents; `writeChatMessage` still returns the id to its e2e caller.
- **Each composer holds a pending `{ id, text }`.** On Send, if a pending draft exists *and its text still matches the box*, its id is reused; otherwise a new id is minted and recorded. The pending draft is cleared only when the send resolves. Web also matches on the author field, since the web composer lets the author change between attempts and a changed author is a different message for the same reason a changed text is.
- **A resend reads before it writes.** `select Id from App.Message where Id = ?` on the retry path only. Row present → report success, clear the draft, refresh, write nothing. Row absent → insert normally.
- **The draft survives a failed send.** The pre-send `setDraft('')` in `reference-app-rn/app/index.tsx` and the pre-send `this.draft = ''` in `reference-app-ns/src/chat-vm.ts` now happen after the send resolves, as the web app already did.
- **The failure text says "not confirmed sent … press Send again"** in all three, rather than "failed". No error classification was added — the stable id is what makes the claim true whichever failure occurred.

`packages/reference-app-rn/src/chat-send.ts` is new: a plain `ChatSender` class holding the pending draft, extracted out of `use-chat.ts` / `app/index.tsx` so the rule is reachable from the `node` vitest project without React or react-native in the graph. `useChat` keeps one instance in a ref and delegates `send` to it.

## How to exercise it

**The failure this fixes, by hand (any of the three apps).** Bring the chat up, type a message, and make the write fail in a way that still stores it — the cheapest reproduction is the fake database the new spec uses; on a device, killing the cohort mid-commit produces the same class. Press Send again with the text untouched. Expect: exactly one row, the send reported as succeeded, the list refreshed. Before this change you got two rows.

**The edited-resend branch.** Fail a send, then change the text before pressing Send again. Expect two messages — the first attempt did land under its own id and the user did submit that text; the edit is a second, different message. This is deliberate, and it is the reason the text match is a condition rather than an optimisation: reusing the id there would report the edit as sent while the stored row still held the pre-edit text.

**One-shot writers are unchanged.** `writeChatMessage` still returns the new id to the e2e formation test, the responder fixture still seeds exactly one known message, and `runSoloSmoke` still echoes its message back. Signatures did not move.

## Tests

| Test | What it verifies |
| --- | --- |
| `packages/reference-app-rn/test/chat-send.spec.ts` → "stores one row when the same text is sent again after an uncertain failure" | The reproduction, inverted. Against a fake `Database` that stores by `Id`, refuses a duplicate `Id`, and on the first insert stores the row and *then* throws: a failed send followed by a resend of the same text leaves exactly one row, and the resend reports `alreadyStored` rather than raising. |
| `packages/reference-app-rn/test/chat-send.spec.ts` → "mints a new id when the text changed before the resend" | The edited-text branch: two rows, two ids, the first attempt's row intact. |

Both were confirmed to fail without the fix — neutering the id-reuse condition in `ChatSender.send` makes the first one fail on `alreadyStored` (it would store a second row), and the pass was restored afterwards.

No second copy for the web or NativeScript apps: same rule, one test per behaviour. The NativeScript view model still cannot be loaded under Node (`@nativescript/core`'s `ObservableArray` fails Node's ESM resolution — `tickets/backlog/debt-ns-chat-vm-unit-tests.md`), so its arm is review-only.

`packages/reference-app-rn/test/react/use-chat.spec.ts` changed only to add `newChatMessageId` and `messageExists` to its existing `chat-operations` mock, since `chat-send.ts` imports from there through the hook. That spec still never sends.

## Validation run

- `yarn lint` — clean.
- `yarn workspace @serfab/reference-app-rn test` — 22 files, 319 tests, all pass.
- `yarn workspace @serfab/reference-app-web test` — 3 files, 66 tests, all pass.
- `yarn workspace @serfab/reference-app-ns test` — 6 files, 110 tests, all pass.
- `typecheck` for all three, plus the web app's `typecheck:e2e` and `check:svelte` (1207 files, 0 errors).

No pre-existing failures surfaced.

## Known gaps and judgement calls, for the reviewer

- **The Playwright e2e suite was not run.** `packages/reference-app-web/e2e/fixtures/formation-responder.ts` changed (the seed now mints its own id), and it is covered only by `typecheck:e2e`. The suite needs a browser and was out of the ticket's validation list; a reviewer with the environment should run it, or say so explicitly.
- **The query is `select Id from App.Message where Id = ?`, not the ticket's `select 1`.** Same point lookup; `select Id` is unambiguously valid Quereus and needs no literal-projection assumption. Flagging it because the ticket names the other form.
- **The ticket's "move the optimistic append to after the insert resolves" needed no work.** Both `useChat.send` and `ChatViewModel.send` already appended after `await insertMessage`. Nothing was changed there beyond appending the row the sender returns; worth confirming that reading is right.
- **Two things were added beyond the ticket's task list, both in service of arm 5 (say the right thing on failure).** The RN screen gained a local `sendError` state, and the NativeScript view model gained `_sendError` separate from the poll's `_error`, because in both apps a successful poll a second or two later would otherwise wipe the one message the user needs to read. The NativeScript version adds a `notifyErrorChange` helper so the `error` / `errorVisibility` bindings only notify when the combined text actually changes. That is real machinery in a reference-app view model; if a reviewer thinks it is too much for the payoff, the honest alternative is a banner that vanishes in under two seconds.
- **The web composer's pending draft lives in `messages.svelte.ts`, not threaded through `Messages.svelte`.** The ticket's task list suggested threading it through `onSubmit`. The store is already a module-level singleton and already holds `refreshInFlight`, so keeping the pending draft beside it is equivalent and shorter; `Messages.svelte` changed only its failure text. Worth a look if the reviewer prefers the component to own it.
- **The docs section cites only the membership reconciler as cadre-core's safe-re-run example.** The ticket also named "the strand-watcher relaunch", but `packages/cadre-core/src/strand-watcher.ts` performs no database write, so that claim was dropped rather than repeated. The reconciler's `MemberPeer` / `ConsumedInvite` keys were checked and do hold.
- **Switching strands does not reset the pending draft.** A failed send on strand A followed by a strand switch and a press of Send inserts into strand B under A's id. No duplicate is possible — the id is fresh to B — and the outcome is the message the user asked for, so it was left alone rather than given a reset hook. Say so if you disagree.

## Tripwires parked in code

- The select-then-insert race the ticket asked to record: an attempt that lands in the window between a resend's read and its insert raises a unique violation, so the user sees an error for a message that *is* stored. The next press of Send reads the row and reports success, so the app self-corrects in one more tap and still cannot store a duplicate. A `NOTE:` says this at all three resend sites — `messages.svelte.ts` `sendMessage`, `chat-send.ts` `ChatSender.send`, `chat-vm.ts` `ChatViewModel.send`.

## Documentation

`docs/schema-guide.md` gained "Client-Generated Keys and Retrying a Write" immediately after "Ordering Events (There Is No Commit-Order Column)", plus a linking bullet under "Practical Guidance & Patterns". It states the corollary the guide was missing — mint the key once per logical event and hold it across attempts — names `reportsPossiblyStoredWrite` as the list of failures that carry the risk, says plainly that strand writes get no equivalent funnel, and covers both the read-before-rewrite retry shape and why `insert or ignore` is the wrong tool (Quereus applies `IGNORE` to every constraint on the row, so a foreign-key failure would silently drop the message).
