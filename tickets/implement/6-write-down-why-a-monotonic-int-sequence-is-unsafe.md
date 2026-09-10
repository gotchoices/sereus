----
description: The owner told an outside consumer that apps can impose their own monotonic ordering with ints and constraints. Our own verified measurement says a concurrent duplicate-key insert is silently last-writer-wins, so that scheme loses rows without an error. Write the refutation down before anyone builds on it.
files: docs/schema-guide.md, schemas/chat-simple.qsql, schemas/chat.qsql, tickets/blocked/optimystic-concurrent-same-pk-insert-silent-lww.md
difficulty: easy
tradeoffs: documenting the limitation closes off the pattern consumers most want; the alternative is silent data loss in their apps
likelihood: certain
----

# Write down why a self-imposed monotonic int sequence is unsafe today

Follow-on to **gotchoices/sereus#5**. The reported question — is commit order available to sApps? —
is answered *no*, and `docs/schema-guide.md` §"Ordering Events (There Is No Commit-Order Column)"
already says so. This ticket exists because the owner's answer to the issue goes one step further:

> "there is no generator mechanism that leaks through those layers. SAP developers can impose their
> own monotonic scheme using ints and constraints."

**That does not hold on the current stack, and we have measured it.** Do not document it as viable.

## The evidence

`tickets/blocked/optimystic-concurrent-same-pk-insert-silent-lww.md` (category (b), verified repro,
measured 2026-08-02 at sereus `53e54bd` / optimystic `092f33f`):

- Two nodes, confirmed replication cohort of 2 on both sides, both inserting the same primary key in
  the same tick: **both promises fulfil, exactly one row survives, no error anywhere.** The second
  commit replaces the first.
- Reproduces with one node and two database handles — two machines are not required, only two
  writers the local write queue cannot see.
- Discriminator: with *different* primary keys both rows survive. The loss is specific to the shared
  key.

Cause, per that ticket: the SQL layer's key probe and deferred checks run against a snapshot taken
before the other writer's row exists, so both pass; when the commits merge in `@optimystic/db-core`'s
`Collection` commit/sync path the decision is never re-made.

A `max(Id)+1` integer scheme is exactly the shape that breaks: both writers read the same max, both
propose the same id, both are told they succeeded, one message vanishes. The constraint the owner's
answer relies on is the very thing that does not fire.

Note this also means `schemas/chat-simple.qsql:14-18` is **right** ("A max(Id)+1 integer key read
from the local replica would collide") but understates the consequence — the collision is not a
refused write, it is a lost one.

## What to write

In `docs/schema-guide.md`, adjacent to Patterns A and B, add the refutation — not a Pattern C:

- The scheme readers will reach for (integer key, `max(Id)+1`, uniqueness constraint to catch
  collisions) and why it is the natural idea.
- Why it fails **specifically here**: a concurrent duplicate key is not refused, it is silently
  last-writer-wins, so the app receives success and loses a row. This is the part that differs from
  every single-writer SQL database a reader has used, and it must be unmissable.
- That the limitation is upstream in `@optimystic/db-core` and tracked, not a schema-authoring
  mistake the reader can work around with a better constraint.
- What to do instead: Patterns A and B, already documented.

Keep it proportionate — a short subsection with the failure stated once, plainly. Do not restate the
whole measurement; link the concept, not the ticket path (tickets are not part of the published docs'
contract).

## Edge cases & interactions

- **Do not claim the scheme becomes safe once the upstream fix lands.** That fix's exact surfaced
  error shape is undecided (see the blocked ticket's "What to do on unblock"), so a retry loop's
  writability is not yet knowable. Say the limitation is tracked; do not promise the sequel.
- **`schemas/chat.qsql`'s `Message` sequence constraint** demonstrates precisely this pattern and is
  being repaired under `fix/6-repair-the-chat-reference-schema`. That ticket must land the same
  caveat at the constraint site; the two must not disagree.
- **Scope the claim to concurrency.** A sequential duplicate insert *does* raise the ordinary
  constraint error. The doc must not leave a reader thinking constraints never fire.
- **The no-holes form** (`Id = 0 or exists(Id - 1)`) is strictly stronger than uniqueness and fails
  the same way; do not present it as the safer variant.

## TODO

- [ ] Add the refutation subsection to `docs/schema-guide.md` near Patterns A and B.
- [ ] Sharpen `schemas/chat-simple.qsql:14-18` from "would collide" to "is silently last-writer-wins;
      the losing row is lost with no error".
- [ ] Confirm nothing elsewhere in `docs/` recommends a self-imposed integer sequence.
- [ ] Cross-check the wording against `fix/6-repair-the-chat-reference-schema` so both say the same
      thing about `chat.qsql`'s `Message` constraint.
