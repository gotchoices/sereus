description: The example chat database schema now checks who is writing on every table, so conversation history cannot be edited or erased, keys cannot be registered in someone else's name, and invitations cannot be burned by strangers; tests prove every unauthenticated write is refused and that one member cannot forge another's writes.
files: schemas/chat.qsql, packages/quereus-plugin-sereus/test/e2e/chat-schema.e2e.spec.ts, docs/reference-app-rn.md
repro: verified
----

# Complete: every write path in `schemas/chat.qsql` is guarded, sweep-proven, review-hardened

The fix ticket found six unauthenticated writes the schema accepted (message edit/delete, key registration and revocation in anyone's name, invitation burning, attachment forgery) plus an unauthorized `Response` insert. The implement stage closed all of them: `Message`, `MemberKey`, `UsedInvite` gained `InsertOnly`/authorization constraints, `Attachment` and `Response` gained author-binding authorization, and a permanent sweep test asserts an unauthenticated insert, update and delete against every declared table is refused by a named constraint, with two-way coverage checking between the sweep's cells and the tables the schema file declares. `docs/reference-app-rn.md`'s one-line description of the schema was updated to state the insert-only + signed-insert property. `chat-simple.qsql` remains deliberately permissionless, untouched.

## Review findings

Reviewed the implement diff (`git show 29f818f`) fresh, then the handoff; ran the package suite and repo lint; wrote and ran two adversarial runtime probes beyond the shipped tests.

**Checked**

- Every constraint expression in `schemas/chat.qsql` read line-by-line: bootstrap committed/live counting pairs, `committed.` vs live reads (self-vouching prevention in `MemberKey.InsertValid`), `new.`/`context.` qualification inside subqueries, constraint declaration order vs the engine's first-declared-violated reporting (the handoff's flagged evaluation-order mapping — every sweep cell's expected constraint re-derived independently and confirmed sound).
- The sweep's structure: no expected-to-succeed escape hatch, junk-signature context supplied where NOT NULL variables would otherwise short-circuit before the CHECK, post-sweep row-count re-assertion plus content re-read of message 0.
- Signature replay across every new constraint: first-key signatures are dead after any key commits (committed-count guard), redemption replays die on `ValidUsage`/primary key, attachment/response/message replays collide with their own primary keys.
- Docs: `chat.qsql` is referenced from exactly one doc line (`docs/reference-app-rn.md:122`), which the diff updated accurately. The `IdValid` comment's pointer to `docs/schema-guide.md` "Ordering Events" resolves.
- `yarn workspace @serfab/quereus-plugin-sereus test`: 112 passed, 1 todo. `yarn lint`: clean.

**Found and fixed inline (minor)**

- **Author-binding was unproven.** The sweep's attacker key is unregistered and the lifecycle only ever signed as the true author, so `MessageAuthorized`, `AttachmentAuthorized` and `ResponseAuthorized` could each silently degrade from "signed by the author" to "signed by any registered member" with every test staying green. A runtime probe confirmed the constraints do bind the author today (member m2's registered key forging in m1's name is refused by the named constraint); three permanent negative cases now pin that in the lifecycle test, one per constraint, at the point where m2 holds a registered key.

**Probed and cleared**

- **Timestamp-rewrite replay:** `MessageAuthorized`'s digest omits `Timestamp`, so a replayed signature plus a duplicate-key insert looked like an in-place timestamp rewrite the sweep's content re-read could not see. Probe result: a local duplicate-Id insert is refused by `UNIQUE constraint failed: Message.Id`, so this is unreachable single-writer; it only revives under the concurrent last-writer-wins hazard the `IdValid` comment already documents. Recorded as a tripwire, not a ticket (below).

**Tripwires recorded (`NOTE:` at site, not tickets)**

- `schemas/chat.qsql` at `MessageAuthorized`: digest does not bind `Timestamp`; if concurrent posters ever arrive, a replayed signature could reseat a message with a different timestamp — bind the timestamp then.
- `schemas/chat.qsql` at `Member.UpdateValid` (pre-existing constraint, not from this diff): rename digest carries no nonce, so an observed rename can be replayed to revert the name to an older self-chosen value — bind a monotonic value if that ever matters.

**Explicitly empty categories**

- **No major findings, no new tickets filed.** The one class-level gap (author-binding proof) was closed inline; nothing else rose above tripwire level.
- **Accepted tradeoffs respected, none re-filed:** the `IdValid` monotonic-sequence NOTE, the `MemberKey` permanent-lockout NOTE, and the suite's documented single-writer/no-reopen scope all stand as deliberate decisions with stated revisit conditions, none tripped.
- **Known remaining limits, unchanged and documented in the spec header:** `declaredTables()` is a line-anchored regex over the `.qsql` (two-way coverage check bounds the damage; a schema-catalog query would be sturdier if the engine grows one); `Message`/`Attachment` delete sweep cells pass no context variables and would surface a missing-variable error instead of the named constraint if context validation ever tightens; only the plugin package suite plus repo lint were run — no cross-package integration run, per ticket scope.
