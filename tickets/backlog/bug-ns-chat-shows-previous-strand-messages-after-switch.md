description: In the NativeScript phone app, when the chat screen moves from one conversation to another, messages from the old conversation can keep showing, or reappear, in the new one. The React Native app already guards against this.
prereq: debt-ns-chat-vm-unit-tests
files: packages/reference-app-ns/src/chat-vm.ts, packages/reference-app-ns/test/chat-vm.spec.ts, packages/reference-app-rn/src/use-chat.ts
repro: static
severity: wrong-result
likelihood: unusual
tradeoffs: The NativeScript app in practice runs one strand and only re-attaches when the chat page is re-entered, so a maintainer may judge the switch too rare to be worth the extra state.
----

# NS chat view model applies the previous strand's results after a switch

## What is wrong

`ChatViewModel` in `packages/reference-app-ns/src/chat-vm.ts` attaches to whichever strand the cadre view model lists first. It re-attaches when `start()` runs, which the chat page does on `navigatedTo`, and while it is still unregistered. Two things happen when the attached strand changes to a different instance:

1. **A late read from the old strand overwrites the new list.** `refresh()` captures `strand` and awaits `queryMessages`/`queryParticipants`, then unconditionally calls `setMessages(messages)` and `settlePendingDraft(messages)`. Suppose a read of strand A is still running when `start()` re-attaches to strand B, which is the case the per-strand single-flight guard exists to allow. B's first read lands, then A's lands and replaces B's rows with A's conversation until the next poll. The participant count and `error` are overwritten the same way.
2. **The old list stays up after the switch.** `attach()` does not clear `_messages` (or re-enter `loading`) when the strand changes. The previous conversation stays on screen until the new strand's first read completes. If the new "strand" is none at all, because the strand stopped and no other exists, it stays indefinitely, since `refresh()` returns early with no database.

A third, smaller arm with the same cause: `send()` pushes the inserted row into `_messages` after `insertMessage` resolves without checking that the strand it wrote to is still the attached one.

The RN hook handles all of this (`packages/reference-app-rn/src/use-chat.ts`). A reset-on-switch effect clears the messages and participants and re-enters loading when the strand id changes. `refresh()` drops any result, error included, whose strand is no longer current, and only clears `loading` for the current strand.

## Expected behaviour

- A read, or a send, that settles for a strand the view model is no longer attached to changes nothing visible: not the list, the participant count, the error, or the pending draft.
- Attaching to a different strand, or to none, clears the list and participant count immediately, before the new strand's first read.

## Reproduction to write

Use the harness from `debt-ns-chat-vm-unit-tests` (`test/chat-vm.spec.ts`: a real in-memory Quereus database per strand, with statements that can be held). Hold A's read, re-attach to B with `start()`, let B's read land, then release A's. Expected: the list holds B's rows only. Today it holds A's. That ticket deliberately leaves this outcome unasserted.

## Reachability

This is reachable when the first strand the cadre view model lists changes while the chat page is re-entered. For example, the first strand stops while another is running, or a reconnect replaces the strand instance. With a replaced instance of the same strand, arm 1 shows the same conversation and is harmless. Arm 2's "no strand left" case shows a conversation the user can no longer write to (the composer is disabled). Nothing was run to observe this; it is read from the code.
