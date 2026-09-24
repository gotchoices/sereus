description: In the three reference chat apps, pressing Send again after a send that failed can post the same message twice. Give each draft one identity that survives a failed attempt, so a resend can only ever replace the earlier one, never add to it.
architecture: docs/schema-guide.md#ordering-events-there-is-no-commit-order-column
files:
  - packages/reference-app-web/src/lib/chat-dml.ts
  - packages/reference-app-web/src/lib/messages.svelte.ts
  - packages/reference-app-web/src/Messages.svelte
  - packages/reference-app-web/src/lib/cadre-web.ts (`writeChatMessage`, ~916)
  - packages/reference-app-web/e2e/fixtures/formation-responder.ts (~276)
  - packages/reference-app-rn/src/chat-operations.ts
  - packages/reference-app-rn/src/use-chat.ts (`send`, ~160)
  - packages/reference-app-rn/app/index.tsx (`handleSend`, ~35)
  - packages/reference-app-ns/src/chat-operations.ts
  - packages/reference-app-ns/src/chat-vm.ts (`send`, ~222)
  - packages/reference-app-ns/src/solo-smoke.ts (~41)
  - docs/schema-guide.md
difficulty: medium
repro: verified
----

# A draft, not a send attempt, owns the message id

## What is wrong

All three reference chat apps mint the `App.Message` primary key *inside* the insert call — `crypto.randomUUID()` in `chat-dml.ts` (web) and `chat-operations.ts` (NativeScript), `uuid()` in `chat-operations.ts` (React Native). A send attempt is therefore not repeatable: the same typed text sent twice produces two different keys, so the primary key cannot recognise the second attempt as the same message.

That matters because a strand write can fail with an outcome nobody can settle. Cadre already names this class precisely, for control writes, in `packages/cadre-core/src/control-write-retry.ts` → `reportsPossiblyStoredWrite`: an Optimystic `TornActionError` that is not `final`, a `SyncRetryExhaustedError`, a `CoordinatorPartialCommitError` / `PartialCommitError`. That function exists to refuse retrying such a write, in its own words, because "a re-run could store the write twice". Strand writes have no equivalent protection — `StrandDatabase.getDatabase()` hands the app a raw Quereus `Database` and the app calls `exec` directly, with no retry funnel anywhere in `packages/cadre-core/src/strand-database.ts`. The chat composer is the only place idempotence can live, and today it does not.

The user-visible failure: a send fails but has in fact landed (or lands a moment later); the user presses Send again; the chat now shows the message twice, on every peer, permanently.

Two of the three apps make it worse by discarding the draft before the write returns — React Native (`app/index.tsx` calls `setDraft('')` before `await chat.send(text)`) and NativeScript (`chat-vm.ts` sets `this.draft = ''` before `await insertMessage(...)`). A failed send there loses the text entirely and the user re-types it, which is exactly the path that mints a second id. The web app already clears only after success.

## Reproduced

Confirmed on 2026-09-24 against the real `packages/reference-app-rn/src/chat-operations.ts`, driven from a temporary spec (since removed) under `packages/reference-app-rn/test/`. The double was a minimal Quereus-shaped `Database` that stores `App.Message` rows keyed by `Id`, refuses a duplicate `Id`, and — on the first insert only — stores the row and *then* throws, which is the shape of an uncertain failure. Two sends of the text `hello` stored two rows with two different ids. The implement work should land essentially this harness as the real test (see Tasks).

## The fix

**The id belongs to the draft, not to the attempt.** Make it a parameter of the insert rather than something the insert invents, and the duplicate becomes unrepresentable: two attempts at one draft carry one key, and the primary key guarantees at most one row no matter how many times the user presses Send or how late a torn write lands.

Concretely, in each of the three apps:

**1 — The insert takes the id.** `insertChatMessage(database, id, participantName, content)` (web) and `insertMessage(strand, id, participantId, content)` (React Native, NativeScript). Remove the `crypto.randomUUID()` / `uuid()` call from inside. Export a `newChatMessageId()` from the same module so there is one place that mints. The one-shot callers that never retry — `cadre-web.ts` `writeChatMessage`, the e2e `formation-responder.ts` seed, `reference-app-ns/src/solo-smoke.ts` — mint at their own call site and keep their current signatures, which is honest about the fact that nothing re-presents those writes. The integration scenarios already pass explicit ids to their own local helpers (`relay-round-trip-measure.integration.ts`, `strand-chat-participants-converge.integration.ts`), so they need no change and are worth reading as the shape to converge on.

**2 — The composer holds a pending draft.** Not a bare string but `{ id, text } | null`. On Send: if a pending draft exists **and its text still matches what is in the box**, reuse its id; otherwise mint a new id and record the pair. Clear the pending draft only when the write resolves. The text-match condition is load-bearing and not an optimisation: if the user edits the text after a failed send and the first attempt had in fact landed, reusing the id would silently discard the edit — the stored row keeps the old text and the resend is reported as already sent. A changed text is a different message, and the earlier attempt landing under its own id is the correct outcome, because the user did submit that text.

**3 — A resend checks before it writes.** When the send is a retry (a pending draft with matching text already exists), first read `select 1 from App.Message where Id = ?`. Row present → the earlier attempt landed; report success, clear the draft and the pending id, refresh the list, and write nothing. Row absent → insert normally. One point lookup, only on the retry path.

**4 — Keep the draft until the write succeeds.** Remove the pre-send `setDraft('')` in `reference-app-rn/app/index.tsx` and the pre-send `this.draft = ''` in `reference-app-ns/src/chat-vm.ts`; clear after the send resolves, as the web app already does. The React Native `useChat.send` optimistic append should also move to after the insert resolves, so a failed send does not leave a message in the list that is not in the database.

**5 — Say the right thing on failure.** The error shown after a failed send should say the message was not confirmed sent and that pressing Send again is safe. No error classification is needed to say that, and none should be added — the stable id is what makes the claim true regardless of which failure occurred.

## Why a read and not `insert or ignore`

`insert or ignore` would be shorter and it does work against strand tables — the Optimystic vtab honours `IGNORE` for a primary-key collision (`../optimystic/packages/quereus-plugin-optimystic/src/optimystic-module.ts` ~2494). It is the wrong tool here because Quereus applies `IGNORE` to *every* constraint on the row, matching SQLite: a NOT NULL, CHECK or foreign-key violation also silently skips the row (`../quereus/packages/quereus/src/runtime/row-constraints.ts` ~262 and ~389). `App.Message.ParticipantId` has a foreign key to `App.Participant`, and the Participant-before-Message insert ordering exists precisely so that a fresh formed strand's empty `Participant` table produces a loud failure rather than a lost message. `or ignore` would convert that into a message that vanishes without a word.

Classifying the error instead was also rejected. A duplicate key arrives as a Quereus `ConstraintError` carrying `StatusCode.CONSTRAINT` (`../optimystic/packages/quereus-plugin-optimystic/src/optimystic-adapter/txn-bridge.ts` ~632) — the same code a foreign-key or CHECK violation carries — so telling them apart means matching the `UNIQUE constraint failed:` message text. This repo does parse error text in `control-write-retry.ts`, but only where there is no typed alternative, and there is one here: read the row.

Exporting cadre-core's uncertain-failure classifier so a reference app could say "this may already have been sent" was considered and rejected as well. It widens the library's public surface to improve one banner in a demo, and once the id is stable the app does not need to know which failure it hit.

## Known residual, to record as a `NOTE:` and not to handle

If the first attempt lands in the window between the resend's `select` and its `insert`, the insert raises a unique violation and the user sees an error for a message that is in fact stored. The next press of Send reads the row and reports success, so the app self-corrects in one more tap and can still never store a duplicate. Leave a `NOTE:` at the resend site saying so; do not add retry machinery to a reference app for it.

## Tests

One test, in `packages/reference-app-rn`, at the layer that owns the pending-draft rule. That means the rule must land in a plain module the `node` vitest project can import — not in `app/index.tsx`, which no unit project targets. The test is the reproduction above, inverted: against a fake `Database` that stores by `Id`, refuses duplicates and fails after storing on the first insert, a failed send followed by a resend of the same text leaves exactly one row and reports the send as succeeded. Cover the edited-text branch in the same spec: a resend after the text changed mints a new id.

No second copy of that test for the web or NativeScript apps — same rule, and one test per behaviour. The NativeScript view model cannot be loaded under Node at all today (`@nativescript/core`'s `ObservableArray` fails Node's ESM resolution; see `tickets/backlog/debt-ns-chat-vm-unit-tests.md`), so its arm is verified by review only.

## Documentation

The schema guide teaches app authors to mint client-side UUID primary keys but never states the corollary this bug is made of. Add a short subsection after "Ordering Events (There Is No Commit-Order Column)" in `docs/schema-guide.md` — roughly "Client-Generated Keys and Retrying a Write" — saying: a strand write can fail with an outcome that is not knowable (Optimystic's non-final `TornActionError`, a lost commit response), so mint the key once per logical event and hold it across attempts; a key minted per attempt turns any manual retry into a duplicate row. Point at `cadre-core`'s `reportsPossiblyStoredWrite` as the list of failures that carry this risk, and note that the deterministic-key writes in cadre-core (the membership reconciler, the strand-watcher relaunch) are safe re-runs for exactly this reason. Add one bullet under "Practical Guidance & Patterns" linking to it.

## Tasks

- [ ] Web: `chat-dml.ts` — take `id` as a parameter on `insertChatMessage`, export `newChatMessageId()`, drop the internal `crypto.randomUUID()`.
- [ ] Web: `messages.svelte.ts` — hold the pending `{ id, text }`, add the already-sent read on the retry path, clear the pending draft only on success.
- [ ] Web: `Messages.svelte` — thread the pending draft through `onSubmit`; update the failure message per arm 5.
- [ ] Web: `cadre-web.ts` `writeChatMessage` and `e2e/fixtures/formation-responder.ts` — mint at the call site, signatures unchanged.
- [ ] React Native: `chat-operations.ts` — take `id` as a parameter on `insertMessage`, export `newChatMessageId()` over the existing `uuid()`.
- [ ] React Native: move the pending-draft rule into a plain module the `node` vitest project can import, and have `use-chat.ts` / `app/index.tsx` use it; move the optimistic append to after the insert resolves.
- [ ] React Native: `app/index.tsx` — stop clearing the draft before the send; clear on success; update the failure message.
- [ ] NativeScript: `chat-operations.ts` — take `id` as a parameter, export `newChatMessageId()`.
- [ ] NativeScript: `chat-vm.ts` — hold the pending `{ id, text }`, add the already-sent read, clear the draft after the insert resolves rather than before.
- [ ] NativeScript: `solo-smoke.ts` — mint at the call site.
- [ ] `NOTE:` at each resend site for the select-then-insert race described above.
- [ ] Test: `packages/reference-app-rn` — resend after an uncertain failure stores one row; an edited resend mints a new id.
- [ ] Docs: new subsection in `docs/schema-guide.md` plus the "Practical Guidance & Patterns" bullet.
- [ ] `yarn lint`, then the three reference apps' `yarn workspace @serfab/reference-app-{web,rn,ns} test`.
