description: The example chat database schema checks who you are when you post a message, but not when you edit one, delete one, or register a new signing key for yourself — so anyone with write access can impersonate any member and rewrite or erase the conversation.
files: schemas/chat.qsql, packages/quereus-plugin-sereus/test/e2e/chat-schema.e2e.spec.ts
repro: verified
severity: corruption
likelihood: normal-use
tradeoffs: No shipping app loads this file, so a maintainer may reasonably rank it behind product work — and closing the Message-edit hole means first deciding whether chat messages are editable at all, a design call nothing currently forces.
----

# `schemas/chat.qsql` authorizes inserts, and nothing else

`schemas/chat.qsql` is the fuller of the two example chat schemas. Its whole reason to exist
is to show how a schema authorizes writes with signatures. It does that on the insert path
and only on the insert path. Every other way of changing the data is wide open.

An outside consumer reading this file as a security reference — which is exactly what
happened in gotchoices/sereus#7, the issue that produced the repair ticket this was found
during — will conclude the design is authenticated end to end. It is not.

## What was measured

All four holes below were confirmed by running them against the repaired schema, on the
`local` transactor through `connectToStrand`, with real ed25519 keys. Each was **accepted**
and the effect was read back from the table afterward. (The probe was a throwaway spec, run
during the review of `repair-the-chat-reference-schema` and deleted; the sequence it ran is
the one in `test/e2e/chat-schema.e2e.spec.ts` up to the first message, then the writes below.)

| write attempted | outcome |
| --- | --- |
| `update Message set Content = 'tampered' where Id = 0`, with an attacker's key and the literal string `'garbage'` as the signature | accepted; `Content` read back as `tampered` |
| `insert into MemberKey (MemberId, Key) values ('m1', <attacker key>)` | accepted; `m1` now has two registered keys |
| `insert into UsedInvite (Key, MemberId) values (<unspent one-time invite>, 'm1')` | accepted; that invitation is now spent and its intended holder can never join |
| `delete from Message where Id = 0`, unauthenticated | accepted; the row is gone |

## Why each one is open

**`Message` update and delete.** `MessageAuthorized` — the constraint that checks the
signature — is declared `check on insert`. The other two constraints on the table,
`IdValid` and `TimeValid`, never look at who is writing. There is no `on delete` constraint
at all, unlike `Member`, which has `CantDelete`.

**`MemberKey`.** The table carries no constraints whatsoever. Anyone may register any public
key against any member id. Once they have, every `verify(...)` elsewhere in the file passes
for them: they can sign as that member for messages, renames, and invitations. This single
hole defeats the entire signature scheme the rest of the file builds.

**`UsedInvite`.** `MemberValid` requires the named member to exist and `ValidUsage` enforces
the one-time rule, but nothing requires the *invitation holder's* consent. Pairing an unspent
one-time invitation with any already-seated member burns it: the redemption is now committed,
so `ValidUsage` refuses the real invitee. Every outstanding invitation can be destroyed this
way by anyone who can write.

## What the fix has to settle

Three of the four are unambiguous and should simply be closed:

- `MemberKey` needs an authorization constraint on insert. The open question is *what*
  authorizes adding a key to an existing member — the member's own existing key (a member
  adding a second device) or the invitation they joined under (a member's first key). Both
  are needed; the constraint is a two-branch `or`, shaped like `Member.InsertValid` already is.
  `MemberKey` also needs an `InsertOnly` guard so a key cannot be swapped or removed.
- `UsedInvite` needs the redemption to be signed by the invitation's private key, the way
  `Member.InsertValid` already requires for the joining member.
- `Message` needs a delete rule. Mirroring `Member.CantDelete` is the obvious default for an
  append-only chat log.

The one genuinely open design call is **whether a chat message may be edited at all.**
Recommended default: **no** — make `Message` insert-only like `Invite`, `Attachment` and
`Response`, which is both the simplest rule and the one consistent with a signed,
gapless-sequence log. If edits are wanted instead, `MessageAuthorized` has to be re-scoped
from `on insert` to cover updates too, and the digest has to bind whatever the edit is allowed
to change.

## Close the class, not just the four instances

The reason these survived is the same reason the original eleven defects did: nothing wrote
rows through the schema, and the constraints that *do* exist all fire on the path that was
eventually exercised. A per-hole fix leaves the next unguarded operation to be discovered the
same way.

`test/e2e/chat-schema.e2e.spec.ts` should gain a **general sweep**, not four more cases: for
every table the schema declares, attempt an unauthenticated insert, update, and delete, and
assert each is refused by a named constraint. That fails today for the four rows in the table
above, passes once they are closed, and keeps failing the moment a future table or column is
added without a rule. Tables that are legitimately open (if any survive the fix) are named in
one explicit allow-list in the test, so opening one is a visible, reviewed edit rather than
an omission.

## Not in scope

`chat-simple.qsql` is deliberately permissionless and documented as such — it is not affected
and must not be "fixed" to match.

## Promoted to `fix/` 2026-09-10

The public reply on gotchoices/sereus#7 tells the reporter that `schemas/chat.qsql` is repaired but
still unsafe as a reference because of exactly this defect, and that the fix is next. Severity is
`corruption`: anyone with write access can impersonate a member and rewrite or erase history in a
schema consumers are copying.
