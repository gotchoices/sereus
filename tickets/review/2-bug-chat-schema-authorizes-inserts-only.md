description: The example chat database schema now checks who is writing on every table, so conversation history can no longer be edited or erased, keys cannot be registered in someone else's name, and invitations cannot be burned by strangers; a sweep test proves every unauthenticated write is refused.
files: schemas/chat.qsql, packages/quereus-plugin-sereus/test/e2e/chat-schema.e2e.spec.ts, docs/reference-app-rn.md
repro: verified
difficulty: hard
----

# Review: every write path in `schemas/chat.qsql` is now guarded, with a permanent sweep proving it

The fix ticket found six unauthenticated writes the schema accepted (message edit/delete, key registration and revocation in anyone's name, invitation burning, attachment forgery) plus an unauthorized `Response` insert. All are closed, and a general sweep test now asserts that an unauthenticated insert, update and delete against **every** declared table is refused by a named constraint.

## What changed

**`schemas/chat.qsql`** — five tables gained constraints, exactly as specified and verified in the fix ticket:

- `Message` gained `InsertOnly` (messages are never edited or deleted — the design call settled in the fix ticket: the only rule consistent with a signed, gapless-sequence log).
- `MemberKey` gained `InsertOnly` and a two-branch `InsertValid`: a member's first key is vouched for by the invitation they joined under (invitation's private key signs `digest(MemberId, Key)`, restricted to the first key by the committed-count = 0 guard), and additional device keys are signed by a key the member already holds (read from `committed.` so a new key cannot vouch for itself). A `NOTE:` above the table records the deliberate consequence: total key loss is permanent lockout, since the first-key branch closes once any key is committed and there is no revocation path.
- `UsedInvite` gained `RedemptionAuthorized`: redemption is signed with the invitation's own private key over `digest(Key, MemberId)`, so pairing an unspent invitation with an arbitrary member no longer burns it. Applies to the founding redemption too.
- `Attachment` gained `AttachmentAuthorized` and `Response` gained `ResponseAuthorized`: only the author of the message (for a response, the responding message) may write the row. Both are declared **last** in their tables on purpose — the engine reports a multiply-violated statement against the first declared constraint, so the referential rules (`MessageExists`, `OriginalExists`, `ResponseExists`) must keep winning the report or the suite's negative cases silently start proving something else. Comments at both sites say so.
- The file's header comment now states the actual property: every table is insert-only (Member allows a signed self-rename and refuses deletes), and every insert after the founding transaction carries a signature.

**`chat-schema.e2e.spec.ts`** — restructured around a shared `seedChat` helper (bootstrap invitation, founding member + first key, messages 0–2, a signed attachment and response, an unspent one-time invitation), used by both the lifecycle test and the new sweep. The lifecycle test's flows were re-signed for the new constraints: first keys are invitation-signed, redemptions are invitation-signed, attachments/responses are author-signed.

**`docs/reference-app-rn.md`** — the one sentence describing `chat.qsql` ("signature verification on every authorized write") now states the insert-only + signed-insert property precisely.

## How to validate

- `yarn workspace @serfab/quereus-plugin-sereus test` — 112 passed, 1 todo. Includes the new sweep and lifecycle.
- `yarn lint` — clean.
- The sweep test ("refuses an unauthenticated insert, update and delete on every declared table") is the heart of the fix: 7 tables × 3 operations, each cell asserted refused by a **named** constraint via the existing `expectRefusedBy` helper (a bare "did throw" would also pass on parse errors and missing-context refusals). Cells that need NOT NULL context variables (`Message`/`Attachment` insert and update need `now` etc.) supply them with junk signature values so each statement actually reaches its CHECK. After the grid, every table's row count is re-asserted unchanged and message 0's content is re-read (a count cannot see an in-place edit).
- Coverage is checked in both directions: the sweep's cell keys must equal the table list parsed from the schema file itself, so a future table without cells fails immediately, as does a stale cell for a removed table.
- New positive/negative cases the sweep cannot express, all green: a second device key signed by an existing key (accepted), a self-vouching new key (refused `InsertValid`), a spent invitation attempting a member's second key (refused `InsertValid`), and a signed attachment with a **null** `Filename` (accepted — this was the unproven `digest`-over-NULL path; `digest` canonicalizes SQL NULL as its own tagged field rather than propagating it, confirmed in the crypto plugin source and now by test).

## Honest gaps for the reviewer

- **Expected-constraint mapping in the sweep encodes evaluation-order knowledge**: constraints without subqueries check at statement time, subquery-bearing ones defer to commit, and within each group declaration order decides which refusal is reported. Every cell's expected constraint came back as predicted on the first green run, but the mapping is worth an adversarial read — a wrong expectation here would still be "a refusal", just proving less than the comment claims.
- **`declaredTables()` is a line-anchored regex** (`^\s*table\s+(\w+)\s*\(`) over the raw `.qsql`. The two-way equality check catches a regex miss on any of the current seven tables and any removed table, but a *future* table written in a formatting the regex misses would escape the sweep silently. All current declarations match; a schema-catalog introspection query would be sturdier if the engine offers one.
- **Delete cells for `Message` and `Attachment` pass no context variables** — the engine demands NOT NULL context variables only for statements whose active constraints reference them, and a delete has no `new.` row for `TimeValid` to read. Green today; if the engine's context-validation ever tightens, those two cells will start failing with a missing-variable message rather than the named constraint.
- **Single-writer, single-session, no reopen** — unchanged limitation, still documented in the spec header: nothing proves the schema survives a warm restart or serializes two concurrent redeemers. Fine while no app loads `chat.qsql`.
- Only the plugin package's suite and repo lint were run, per the ticket. No cross-package integration run.

## Not in scope

`chat-simple.qsql` is deliberately permissionless and untouched, as the fix ticket required.
