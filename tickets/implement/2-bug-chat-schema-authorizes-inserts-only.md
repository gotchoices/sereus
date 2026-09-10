description: The example chat database schema only checks who you are when you post a message, so anyone with write access can edit or erase the conversation, register a signing key in someone else's name, attach files to other people's messages, and burn unspent invitations. Close every unguarded write and add a test that sweeps all of them.
files: schemas/chat.qsql, packages/quereus-plugin-sereus/test/e2e/chat-schema.e2e.spec.ts, docs/reference-app-rn.md
repro: verified
difficulty: hard
----

# `schemas/chat.qsql` authorizes inserts, and not all of those

`schemas/chat.qsql` is the fuller of the two example chat schemas, and its whole reason to exist is to show how a schema authorizes writes with signatures. It does that for three of the seven tables' inserts and for nothing else. Six write paths are wide open.

An outside consumer reading this file as a security reference — which is what happened in gotchoices/sereus#7 — will conclude the design is authenticated end to end. It is not.

## What was measured

A throwaway probe spec seeded a real chat (founding invitation, founding member, a member key, three messages, an attachment, a response, a second unspent one-time invitation) on the `local` transactor through `connectToStrand` with real ed25519 keys, then attempted an **unauthenticated insert, update and delete against every one of the seven tables** — 21 cells. The probe has been deleted; the sweep it ran is the one this ticket asks you to add to the permanent suite.

Six cells were **accepted** on today's `schemas/chat.qsql`:

| write attempted, unauthenticated | effect |
| --- | --- |
| `insert into UsedInvite (Key, MemberId) values (<unspent one-time invite>, 'm1')` | the invitation is now spent; its intended holder can never join |
| `insert into MemberKey (MemberId, Key) values ('m1', <attacker key>)` | the attacker can now sign as `m1` everywhere in the file |
| `delete from MemberKey where MemberId = 'm1'` | any member's keys can be revoked by anyone |
| `update Message set Content = 'tampered' where Id = 0` | history is rewritable |
| `delete from Message where Id = 2` | history is erasable |
| `insert into Attachment (...) values (0, 5, ..., <blob>)` | anyone can hang a file off anyone's message |

A seventh — `insert into Response (OriginalId, ResponseId)` — carries no authorization either, and the existing suite already demonstrates it: `chat-schema.e2e.spec.ts` inserts `Response (0, 1)` with no `with context` clause at all and the statement is accepted. In the sweep it happened to be refused by `ResponseExists` only because an earlier cell in the same sweep had already deleted the message it named.

The remaining 14 cells were already refused by a named constraint.

## Why each one is open

**`Message` update and delete.** `MessageAuthorized` — the constraint that checks the signature — is declared `check on insert`. The other two constraints, `IdValid` and `TimeValid`, never look at who is writing. There is no delete constraint at all, unlike `Member`, which has `CantDelete`.

**`MemberKey`.** The table carries no constraints whatsoever. This single hole defeats the whole signature scheme the rest of the file builds: once an attacker has registered a key against a member id, every `verify(...)` elsewhere in the file passes for them.

**`UsedInvite`.** `MemberValid` requires the named member to exist and `ValidUsage` enforces the one-time rule, but nothing requires the invitation holder's consent. Pairing an unspent one-time invitation with any already-seated member commits the redemption, and `ValidUsage` then refuses the real invitee.

**`Attachment` and `Response`.** Both check only that the message ids they name exist. Neither asks who is writing.

## The design calls, settled

**A chat message may not be edited or deleted.** `Message` becomes insert-only like `Invite`, `Attachment` and `Response`. That is the simplest rule and the only one consistent with a signed, gapless-sequence log. If editing is ever wanted, it is a fresh ticket: `MessageAuthorized` would have to be re-scoped to cover updates and the digest would have to bind whatever the edit is allowed to change.

**An attachment may only be added by the author of the message it hangs off; a response link may only be added by the author of the responding message.** Both are the natural owner of the row, and both are already reachable from the row's own columns through `Message.MemberId`.

**A member key is authorized either by the invitation that member joined under (their first key) or by a key they already hold (an additional device).** Two branches, shaped like `Member.InsertValid`. The first branch is restricted to the member's *first* key, so possession of a spent invitation secret does not stay a permanent credential.

## The constraint text, as verified

Every block below was run against a patched copy of the schema on the `local` transactor. All 21 sweep cells came back refused by a named constraint (bar one — see *Watch for* below), and a full second-member join lifecycle still succeeded.

`UsedInvite` — the invitation's own public key **is** `new.Key`, so no extra context variable is needed to name it:

```sql
        constraint MemberValid check (exists (select 1 from Member M where M.Id = new.MemberId)),
        constraint RedemptionAuthorized check on insert (
            verify(digest(new.Key, new.MemberId), context.InviteSignature, new.Key, 'ed25519')
        )
    )
        with context (InviteSignature string null);
```

`MemberKey`:

```sql
    table MemberKey (
        MemberId string,
        Key string, --public key of member, part of private/public key pair
        primary key (MemberId, Key),
        constraint InsertOnly check on update, delete (false),
        constraint InsertValid check on insert (
            -- First key: authorized by the invitation this member joined under.
            (exists (select 1 from UsedInvite U where U.MemberId = new.MemberId and U.Key = context.InviteKey)
                and (select count(1) from committed.MemberKey K where K.MemberId = new.MemberId) = 0
                and (select count(1) from MemberKey K where K.MemberId = new.MemberId) <= 1
                and verify(digest(new.MemberId, new.Key), context.InviteSignature, context.InviteKey, 'ed25519'))
            -- Additional device: signed by a key the member ALREADY holds. The existing
            -- key is read from committed. — the live table already holds the row being
            -- judged, so a live read would let the new key vouch for itself.
            or (exists (select 1 from committed.MemberKey K where K.MemberId = new.MemberId and K.Key = context.MemberKey)
                and verify(digest(new.MemberId, new.Key), context.MemberSignature, context.MemberKey, 'ed25519'))
        )
    )
        with context (InviteKey string null, InviteSignature string null, MemberKey string null, MemberSignature string null);
```

Both counting guards are load-bearing, for the reasons already written up on `Invite.InsertValid`: a CHECK is evaluated with the new row already present, so `committed` = 0 is what makes the branch first-key-only, and live `<= 1` is what stops one transaction registering an unbounded set of keys through it. The `committed.` read in the second branch is what refuses a self-vouching key (probe: a brand-new key naming *itself* as `context.MemberKey` was refused by `InsertValid`; a genuine second device signed by the founder's existing key was accepted).

`Message` — one line, placed immediately after `primary key (Id)`:

```sql
        constraint InsertOnly check on update, delete (false),
```

`Attachment` — declared **after** `MessageExists` and `TimeValid`, which matters (see *Watch for*):

```sql
        constraint AttachmentAuthorized check on insert (
            exists (select 1 from Message M join MemberKey K on K.MemberId = M.MemberId
                where M.Id = new.MessageId and K.Key = context.MemberKey)
                and verify(digest(new.MessageId, new.Sequence, new.Type, new.Filename, new.Content), context.MemberSignature, context.MemberKey, 'ed25519')
        )
    )
        with context (now datetime, MemberKey string null, MemberSignature string null);
```

`Response` — declared **after** `OriginalExists` and `ResponseExists`:

```sql
        constraint ResponseAuthorized check on insert (
            exists (select 1 from Message M join MemberKey K on K.MemberId = M.MemberId
                where M.Id = new.ResponseId and K.Key = context.MemberKey)
                and verify(digest(new.OriginalId, new.ResponseId), context.MemberSignature, context.MemberKey, 'ed25519')
        )
    )
        with context (MemberKey string null, MemberSignature string null);
```

## Watch for

**Constraint declaration order decides which refusal the caller sees.** The engine evaluates a table's CHECKs in declaration order, so a statement that violates two of them is reported against the first. This is what keeps the existing suite's `MessageExists`, `OriginalExists` and `ResponseExists` expectations meaningful: both new authorization constraints are declared last, and the probe confirmed a signed `Attachment` naming message 99 still refuses with `MessageExists`, and a signed `Response (0, 42)` still refuses with `ResponseExists`. Declare them first and those three negative cases silently start proving something else.

**One sweep cell cannot reach a CHECK at all.** `update Attachment ...` with no `with context` is refused before the constraints run, with `table 'app.Attachment' requires mutation context variable 'now'` — `TimeValid` reads a NOT NULL context variable and fires on update. That is a refusal, just not a CHECK refusal. Either supply `with context now = ?` in that sweep cell so it reaches `InsertOnly`, or let the sweep accept a missing-context-variable refusal as a refusal; do not leave it as a bare "did not throw the expected thing".

**A member who loses every key is locked out permanently.** With the first-key branch restricted to `committed` count = 0 and no revocation path, a member whose only key is gone can never register another. That is the honest consequence of an append-only key set, and it is the right default for a reference schema, but it should not be silent — leave a `NOTE:` at `MemberKey.InsertValid` saying so, so the next reader meets the property rather than discovering it.

**`digest` over a NULL column is unproven for a match.** The probe signed an attachment with a real `Filename` and matched; the `null` case only ever reached `MessageExists`, so a null `Filename` round-tripping through `digest` on both the signer's side and the constraint's side has not been demonstrated. The positive case below covers it.

## The permanent sweep

The reason these seven survived is the reason the original eleven defects did: nothing writes rows through this schema in the product, and the constraints that exist all fire on the one path a test eventually exercised. Four — now seven — per-hole fixes leave the next unguarded operation to be found the same way.

`packages/quereus-plugin-sereus/test/e2e/chat-schema.e2e.spec.ts` gains a **general sweep**: for every table the schema declares, attempt an unauthenticated insert, update and delete, and assert each is refused by a named constraint. It fails today on six cells, passes once they are closed, and keeps failing the moment a future table or column arrives without a rule. No allow-list is needed after this fix — all 21 cells are refused — so if the implementation ends up wanting one, that is a signal to re-examine the design, not to add the entry.

Two practical notes from running it: the sweep is **order-sensitive on an unfixed schema**, because an accepted cell mutates the state a later cell reads (the accepted `delete from Message where Id = 2` is what made a later `Response` insert refuse with `ResponseExists` instead). Once every cell is refused the ordering stops mattering, which is itself part of what the test asserts. And the sweep needs a seeded database — an update or delete against an empty table matches no rows and fires nothing — so factor the existing lifecycle test's setup into a reusable seed helper rather than duplicating it.

## Not in scope

`chat-simple.qsql` is deliberately permissionless and documented as such. It is not affected and must not be "fixed" to match.

## TODO

- Add `RedemptionAuthorized` and the `with context (InviteSignature string null)` clause to `UsedInvite` in `schemas/chat.qsql`.
- Add `InsertOnly` and the two-branch `InsertValid` to `MemberKey`, with its `with context` clause, plus the `NOTE:` about permanent lockout on total key loss.
- Add `InsertOnly` to `Message`.
- Add `AttachmentAuthorized` to `Attachment` and `ResponseAuthorized` to `Response`, both declared after the existing referential constraints, both extending the table's `with context` clause.
- Update the file's header comment if it now overstates or understates what is verified.
- Update the existing lifecycle test in `chat-schema.e2e.spec.ts`: the founding member's first key and `m2`'s first key are now signed with the invitation's private key over `digest(MemberId, Key)`; both `UsedInvite` inserts are signed with the invitation's private key over `digest(Key, MemberId)`; the attachment and response inserts are signed with the author's member key. All four flows were run green against the patched schema.
- Factor the lifecycle setup into a seed helper the sweep can reuse.
- Add the sweep: every declared table × insert/update/delete, each asserted refused by a named constraint, using the existing `expectRefusedBy` helper.
- Add positive cases the sweep cannot cover: a second device key signed by a key the member already holds (accepted), a self-vouching new key (refused by `InsertValid`), a spent invitation attempting to add a member's *second* key (refused by `InsertValid`), and an attachment with a `null` `Filename` (accepted — this is the untested `digest` NULL path).
- Extend the spec's header comment to say why the sweep exists, in the same voice as the existing "WHY THIS TEST WRITES ROWS" paragraph.
- Check `docs/reference-app-rn.md` line 122, which describes `schemas/chat.qsql` as having "signature verification on every authorized write" — true only after this change; adjust the sentence if it needs to be more precise about what is now covered.
- Run `yarn workspace @serfab/quereus-plugin-sereus test` and `yarn lint`.
