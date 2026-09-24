description: In the three reference chat apps, pressing Send again after a send that failed could post the same message twice. Each draft now gets one identity that survives a failed attempt, so a resend can only ever replace the earlier one, never add to it.
architecture: docs/schema-guide.md#client-generated-keys-and-retrying-a-write
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
  - packages/reference-app-ns/src/chat-operations.ts (`newChatMessageId`, `insertMessage`, `messageExists`)
  - packages/reference-app-ns/src/chat-vm.ts (`pendingDraft`, `send`, `_sendError`)
  - packages/reference-app-ns/src/solo-smoke.ts
  - docs/schema-guide.md ("Client-Generated Keys and Retrying a Write")
  - docs/reference-app-rn.md, docs/reference-app-ns.md
----

# The message id belongs to the draft, not to the attempt

## What shipped

All three reference chat apps used to mint the `App.Message` primary key *inside* the insert call. That made a send attempt unrepeatable: the same typed text sent twice produced two different keys, so the primary key could not recognise the second attempt as the same message. A strand write can fail without settling whether it landed — there is no retry funnel over strand writes the way `control-write-retry.ts` covers control writes — so a user pressing Send again after a failed-but-actually-stored write got the message twice, on every peer, permanently.

The id is now a parameter of the insert and belongs to the composed draft:

- **`newChatMessageId()`** is exported from each app's DML module, and the insert (`insertChatMessage` web, `insertMessage` rn/ns) takes `id` as its first data argument. The three one-shot callers that never re-present a write — `cadre-web.ts` `writeChatMessage`, the e2e `formation-responder.ts` seed, `reference-app-ns/src/solo-smoke.ts` — mint at their own call site and keep their signatures.
- **Each composer holds a pending `{ id, text }`.** On Send, if a pending draft exists *and its text still matches the box*, its id is reused; otherwise a new id is minted and recorded. The pending draft is cleared when the send resolves. Web also matches on the author field, since its composer lets the author change between attempts.
- **A resend reads before it writes.** `select Id from App.Message where Id = ?` on the retry path only. Row present → report success, clear the draft, refresh, write nothing. Row absent → insert normally.
- **The draft survives a failed send**, in all three apps, so the user presses Send again rather than re-typing (a re-typed message is a new draft with a new id — the path that stored the message twice).
- **The failure text says "not confirmed sent … press Send again"** rather than "failed". No error classification was added — the stable id is what makes the claim true whichever failure occurred.

`packages/reference-app-rn/src/chat-send.ts` is new: a plain `ChatSender` class holding the pending draft, extracted out of `use-chat.ts` / `app/index.tsx` so the rule is reachable from the `node` vitest project without React or react-native in the graph.

`docs/schema-guide.md` gained "Client-Generated Keys and Retrying a Write" after "Ordering Events (There Is No Commit-Order Column)": mint the key once per logical event and hold it across attempts, `reportsPossiblyStoredWrite` as the list of failures that carry the risk, strand writes getting no equivalent funnel, the read-before-rewrite retry shape, and why `insert or ignore` is the wrong tool (Quereus applies `IGNORE` to every constraint on the row, so a foreign-key failure would silently drop the message — confirmed against quereus' own `schema-declarative.ts`, which says `OR IGNORE` "used to drop it silently" for CHECK / NOT NULL / child-side FK).

## Tests

| Test | What it verifies |
| --- | --- |
| `packages/reference-app-rn/test/chat-send.spec.ts` → "stores one row when the same text is sent again after an uncertain failure" | The reproduction, inverted. Against a fake `Database` that stores by `Id`, refuses a duplicate `Id`, and on the first insert stores the row and *then* throws: a failed send followed by a resend of the same text leaves exactly one row, and the resend reports `alreadyStored` rather than raising. |
| `packages/reference-app-rn/test/chat-send.spec.ts` → "mints a new id when the text changed before the resend" | The edited-text branch: two rows, two ids, the first attempt's row intact. |

Both tests were kept as they stand — one is the bug's reproduction at the lowest layer that reaches it, the other pins the other arm of the load-bearing text-match condition. No test was added for the review's own fix; see the findings below for why.

## Review findings

Read the implement diff (`02c8bfdf`) before the handoff, then the working files, the three composers' call graphs, the docs the change touches and the ones it should have, and the two sibling claims the docs make (cadre-core's `reportsPossiblyStoredWrite`, quereus' `OR IGNORE` semantics — both check out). Traced every send/resend path by hand: first attempt, resend of unchanged text with the row present and with it absent, resend after an edit, repeated failures, failure before the write (`No strand attached`, participant insert), a failure in the post-write refresh, two tabs, and a strand switch mid-draft. The duplicate-storage hole the ticket set out to close is genuinely closed on all of those.

**Fixed in this pass (minor):**

- **A second tap during a send now does nothing (RN, NS).** Moving the draft clear to *after* the await — the core of the fix — left the Send control live for the whole commit, seconds on a slow strand, where it used to go inert immediately. A second tap in that window re-presented the draft's key against its own in-flight insert: one of the two lost on a unique violation and told the user "Not confirmed sent" about a message that was stored. Never a duplicate (the key is stable, which is the whole point) but a false alarm reachable by any impatient tap. `packages/reference-app-rn/app/index.tsx` now guards on a `sendingRef` (a ref, not state, and in `handleSend` rather than on the button, because `onSubmitEditing` routes here too); `ChatViewModel.send` returns early while `sending`, silent like the empty-draft no-op beside it. The web app already had this, via `disabled={msgs.loading}` — that is why only two apps needed it. No test: the lowest layer that reproduces it is the RN screen and the NativeScript view model, neither of which loads under the `node` vitest project, and a React-renderer test of a tap guard is the UI wiring the project's rules say not to test.
- **The e2e responder's seed comment overclaimed.** `formation-responder.ts` said its per-attempt mint meant "nothing re-presents a key across attempts", framed as the safe property. The real reason it is safe is narrower and worth writing down: the failure its retry exists for (an attempt before the cohort is ready) rejects without storing. A failure that stored and then failed to report would seed twice. Comment rewritten to say that.
- **Documentation the change should have touched.** `docs/reference-app-rn.md`'s `src/` inventory did not list the new `chat-send.ts`, and its Step 6 walkthrough still described only the happy path though the failure text the user sees changed; both updated. `docs/reference-app-ns.md`'s RN→NS parity map gained the `chat-send.ts` row (folded into `ChatViewModel.send`, untestable under Node). The schema-guide section named two of the three reference implementations while claiming all three; the third is now named.

**Filed (major):** `tickets/backlog/bug-chat-retry-key-outlives-the-draft-it-belongs-to.md`. The held key is retired only by a resolved send — nothing else. So after an uncertain failure that *did* land, a user who sees the message arrive on the next poll and clears the box by hand still leaves the key alive, and the next time they type that same text (`ok`, `yes`, `thanks` — the messages people repeat) the app reads it as a retry, finds the old row, reports success and **writes nothing**. The message is silently dropped. The stale "Not confirmed sent … Press Send again" banner shown over a message the poll already delivered is the same defect's milder face. One decision at one site per app, so one ticket with three arms; filed to `backlog/` with `severity: wrong-result`, `likelihood: unusual`, and the honest decline argument. Not fixed here: the fix has to reach from the poll (or the composer's change handler) back into composer state in three separate apps, which is new behaviour with real design choices, not a review edit. The schema-guide section now states the missing half of the rule and points at the ticket.

**Appended as evidence, not filed (existing ticket):** `debt-composite-pk-point-lookup-unreliable-untracked` tracks whether a full-primary-key point lookup can come back empty for a row that exists on a networked strand. The three new `where Id = ?` reads are new instances of exactly that shape — the first on a *strand* table rather than a control one — so they were appended as an arm there rather than filed fresh. They degrade safely and the arm says so: a lookup that wrongly reports "absent" leads to an insert the primary key refuses, so the worst case is an error the user retries past, never a duplicate. Each of the three sites carries a `NOTE:` pointing at the ticket, and the schema-guide's "read before re-writing" bullet now carries the caveat with the reason it is survivable — plus the warning not to invert it and treat the read as what keeps the row unique.

**Appended to an existing ticket:** `debt-ns-chat-vm-unit-tests` gained the NativeScript send rule as a thing to cover once `ObservableArray` loads under Node, naming `chat-send.spec.ts` as the test to port.

**Checked and found nothing (explicitly):**

- *The handoff's open questions.* Both readings it asked to be confirmed are right. `useChat.send` and `ChatViewModel.send` did already append after the insert resolved, so the ticket's "move the optimistic append" task genuinely needed no work. `select Id` rather than the ticket's `select 1` is the same point lookup and the better choice.
- *Duplicate storage, the thing the ticket exists to prevent.* No path found that stores two rows for one composed message, including the select-then-insert race the implementer parked as a tripwire (it ends in a unique violation, never a second row) and the strand-switch case (the id is fresh to the new strand, and the message lands once there).
- *Resource cleanup.* `for await … return` over `Database.eval` calls the iterator's `return()`, so the abandoned point lookup closes.
- *Tests.* Both new tests earn their place; nothing was cut. The `use-chat.spec.ts` mock additions are the minimum the hook's new import needs.
- *The NativeScript error plumbing the handoff flagged as possibly too much.* `_sendError` separate from the poll's `_error`, with `notifyErrorChange` notifying only when the combined text changes, was read closely and kept: a two-second poll would otherwise wipe the one message the user needs, and the notify helper is four lines that stop a masked poll error from firing a spurious property change. The banner's staleness is a real problem, but it is the filed ticket's, not this machinery's.
- *The web composer's pending draft living in the store rather than threaded through `Messages.svelte`.* Correct as built — the store is already the module-level singleton holding `refreshInFlight`, and threading it would add a prop for no gain.

**Not run:** the Playwright e2e suite, unchanged from the implementer's note. `packages/reference-app-web/e2e/fixtures/formation-responder.ts` is touched by both the implement commit and this review (a comment only, here), and is covered by `typecheck:e2e`, which passes. It needs a browser and is outside the ticket's validation set; a run before the next release of the web app would close it.

## Validation

- `yarn lint` — clean.
- `yarn workspace @serfab/reference-app-rn test` — 22 files, 319 tests, pass.
- `yarn workspace @serfab/reference-app-web test` — 3 files, 66 tests, pass.
- `yarn workspace @serfab/reference-app-ns test` — 6 files, 110 tests, pass.
- `typecheck` for all three, plus the web app's `typecheck:e2e` and `check:svelte` (1207 files, 0 errors).
- No pre-existing failures. The test run was delayed about 15 minutes by the stale-build guard: `../quereus` and then `../optimystic`'s `db-p2p` were both mid-edit with stale `dist`. Per `tickets/rules/sibling-repos.md` neither was built here; the run waited for their own builds to land and then passed.
