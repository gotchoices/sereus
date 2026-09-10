----
description: Documented, in the schema guide and both chat schemas, that an app cannot safely invent its own auto-incrementing integer id — a concurrent duplicate insert is silently last-writer-wins on this stack today, not refused, so the earlier "apps can impose their own monotonic scheme" answer was wrong and now says so in the docs a reader actually reaches.
files: docs/schema-guide.md, schemas/chat-simple.qsql, docs/reference-app-rn.md
difficulty: easy
----

# Refutation written: self-imposed monotonic int sequence is unsafe

Follow-on to gotchoices/sereus#5/#6. Pure documentation ticket — no runtime code touched, no
build/test surface affected.

## What changed

1. **`docs/schema-guide.md`**, in the "Ordering Events (There Is No Commit-Order Column)" section,
   directly after Pattern A and Pattern B: new paragraph, explicitly labeled "not a third pattern,"
   stating plainly that an integer `max(id) + 1` scheme (with a uniqueness or "no gaps" check as the
   safety net) is not safe here. A concurrent duplicate-key insert is silently resolved
   last-writer-wins — both writers are told they succeeded, one row is lost, no error anywhere —
   unlike every single-writer SQL database a reader has used. Scoped correctly: a *sequential*
   duplicate insert still raises the ordinary constraint error; only the concurrent case is broken.
   States the "no gaps" variant (`id = 0 or exists(id - 1)`) fails identically, so it isn't a safer
   escape hatch. Says the limitation is tracked upstream and unresolved — does **not** promise it
   becomes safe once fixed (the fix's exact error shape is still undecided per the blocked ticket).
   No ticket path linked from the doc, per instruction — the concept is explained standalone.

2. **`schemas/chat-simple.qsql:14-18`** — the `Message.Id` comment previously said a `max(Id)+1`
   key "would collide"; that undersold it (sounds like a refused write). Reworded to say plainly:
   silently last-writer-wins, not refused, losing row lost with no error. Points at the
   schema-guide section for detail.

3. **`docs/reference-app-rn.md`** (not in the ticket's original `files:` list, but its "Simplified
   Chat Schema" section embeds a byte-for-byte copy of the same `Message.Id` comment) — synced to
   the same sharpened wording so the two copies don't drift back to disagreeing. This is the only
   scope addition beyond the ticket text; flagging it explicitly in case the reviewer wants to judge
   it out of bounds.

## What was NOT changed (by design)

- `schemas/chat.qsql`'s `Message.IdValid` constraint (the actual no-gaps integer sequence) is
  untouched. Repairing/commenting that constraint is `fix/repair-the-chat-reference-schema`'s job
  (currently at `tickets/fix/7-repair-the-chat-reference-schema.md` — sequence number differs from
  what this ticket's body cited, "6"; slug is unchanged and that's what matters). That ticket's item
  6 already says to comment the constraint "in the manner of chat-simple.qsql:14-18" — since that
  site is now sharpened, the two will agree once item 6 lands. No edit made to the fix ticket itself.
- Did not touch `tickets/blocked/optimystic-concurrent-same-pk-insert-silent-lww.md` — it was source
  evidence only, not a target of the doc change.
- Confirmed via `grep -rniE 'max\(.?[Ii]d\)|monotonic|sequence.{0,20}(integer|int\b)' docs/` that no
  other doc recommends a self-imposed integer sequence. The other hits were unrelated (`monotonic
  UpdatedAt` freshness stamps, review-history growth, timestamp assertions in the drone reference
  app) — left alone.

## Worth the reviewer's attention

- **Judgment call, not verified against the fix ticket's future diff:** I asserted the two docs
  "won't disagree" based on fix/7's own wording ("in the manner of chat-simple.qsql:14-18"), not by
  waiting for that ticket to land. If fix/7 lands a differently-worded comment at `chat.qsql`'s
  `Message` table, re-check it against this ticket's phrasing (silently-LWW / lost-with-no-error,
  not "would collide" or "not automatically a defect").
- **fix/7's own body still quotes the now-refuted owner claim** ("sApp developers can impose their
  own monotonic scheme using ints and constraints") as part of its reasoning for keeping the
  `chat.qsql` constraint. I did not edit that ticket — out of this ticket's stated file scope, and
  editing another stage's ticket felt like scope creep for a docs-only ticket. Worth a second look:
  the reasoning there is still sound (keep the constraint, just document the limit), but the
  premise it cites is the one this ticket exists to refute.
- **No test coverage added or needed** — this is prose/comment only. Nothing to run beyond a read of
  the diff. I did grep for any doc/build tooling that ingests `chat-simple.qsql`'s comment text
  verbatim (schema-snapshot tests, etc.); found none — comments aren't parsed by the SQL loader.
- Did not verify the schema-guide.md markdown renders correctly (no lint/build step exists for prose
  docs in this repo); read it back after editing and it reads correctly inline.

## Validation performed

- Read `docs/schema-guide.md`, `schemas/chat-simple.qsql`, `schemas/chat.qsql`,
  `tickets/blocked/optimystic-concurrent-same-pk-insert-silent-lww.md`, and
  `tickets/fix/7-repair-the-chat-reference-schema.md` in full before editing.
- Grepped `docs/` for other instances of the pattern (see above) — no other cleanup needed.
- Grepped `packages/` for other embedded copies of the `chat-simple.qsql` schema
  (`reference-app-rn`, `reference-app-ns`, `reference-app-web` each embed `CHAT_SCHEMA` as a string
  constant) — confirmed those embeds strip comments entirely (no `max(Id)` text present), so no
  further sync needed there.
