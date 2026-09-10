----
description: The docs now say plainly that an app cannot safely invent its own auto-incrementing integer id on this stack — a duplicate id created by two peers at once is silently accepted and one message is thrown away with no error, so the earlier advice that apps could roll their own numbering was wrong and has been corrected everywhere a reader meets it.
files: docs/schema-guide.md, schemas/chat-simple.qsql, docs/reference-app-rn.md, packages/reference-app-ns/src/chat-operations.ts, packages/reference-app-rn/src/chat-operations.ts, packages/reference-app-web/src/lib/chat-dml.ts, packages/integration-tests/src/scenarios/convergence-stress.integration.ts, tickets/fix/7-repair-the-chat-reference-schema.md
----

# Refutation of the self-imposed monotonic int sequence — written and reviewed

Answers **gotchoices/sereus#5**. Documentation only; no runtime behavior changed.

## What the change says

An integer primary key assigned as `max(id) + 1`, guarded by a uniqueness or "no gaps" check, is
**not safe** on this stack. When two peers insert the same key concurrently, the write is not
refused: both are told they succeeded and the commits resolve last-writer-wins, so one row vanishes
with no error anywhere. The claim is scoped correctly — a *sequential* duplicate insert still raises
the ordinary constraint error — and the "no gaps" variant (`id = 0 or exists(id - 1)`) is called out
as failing identically rather than being the safer option. The limitation is stated as tracked and
unresolved; it does **not** promise the pattern becomes safe once fixed, because the upstream fix's
surfaced error shape is still undecided
(`tickets/blocked/optimystic-concurrent-same-pk-insert-silent-lww.md`).

Sites carrying it:

- `docs/schema-guide.md` §"Ordering Events (There Is No Commit-Order Column)" — a "Not a third
  pattern" block immediately after Patterns A and B. The canonical explanation; every other site
  points here.
- `schemas/chat-simple.qsql:14-19` and its byte-for-byte copy in `docs/reference-app-rn.md:131-136`.
- The three reference apps' insert paths and the convergence-stress integration test, which each
  explain why the key is a locally-generated UUID.

## Review findings

**Implementation verified.** Read the implement diff (`aeaa4d8`) before the handoff summary. Its
substantive claims hold: the schema-guide text is placed correctly relative to Patterns A/B, the
concurrency scoping and the "no gaps" caveat are both present and accurate against the evidence in
the blocked ticket, and no forward promise about the upstream fix was made. The handoff's own
statements checked out — `chat-simple.qsql` and `docs/reference-app-rn.md` are indeed the only two
copies of that schema comment (grepped for "Text UUID primary key"), and the packages' embedded
`CHAT_SCHEMA` string constants do strip comments.

**Major findings: none.** No new tickets filed. The one architectural gap in the area — the actual
unsafe integer sequence still live at `schemas/chat.qsql:77` (`IdValid`) with no warning at the site
— is already owned by `fix/repair-the-chat-reference-schema` item 6, so it is evidence for an open
ticket, not a new one.

**Minor findings, all fixed in this pass:**

- *The sweep stopped at `docs/`.* The ticket's TODO scoped the "does anything else say this?" check
  to `docs/`, and the implementer honored that scope — but four **code** comments carried the exact
  understated wording this ticket exists to retire ("a max(Id)+1 read **would collide**", which
  reads as a refused write rather than a silently lost row):
  `packages/reference-app-ns/src/chat-operations.ts:90`,
  `packages/reference-app-rn/src/chat-operations.ts:128`,
  `packages/reference-app-web/src/lib/chat-dml.ts:40`,
  `packages/integration-tests/src/scenarios/convergence-stress.integration.ts:74`.
  All four rewritten to say silently-last-writer-wins / row lost with no error, and the three app
  sites now point at the schema-guide section. (A fifth hit,
  `convergence-stress.integration.ts:290`, is a historical note about why that test stopped using a
  `max(Id)+1` subquery — not a claim about collision semantics — and was left alone.)
- *The schema-guide block named the cause vaguely and stated the failure three times.* It said the
  behavior "lives in the underlying storage layer's merge/sync path" while the same section already
  names Optimystic by name two paragraphs earlier. Rewritten to name Optimystic's commit/merge path
  and split into two paragraphs: the failure once, then the two scoping caveats (concurrent-only;
  not a schema-authoring mistake). No claim added or removed.
- *An in-flight ticket still argued from the refuted premise.*
  `fix/repair-the-chat-reference-schema` item 6 cited the owner's "sApp developers can impose their
  own monotonic scheme using ints and constraints" as reason the `chat.qsql` sequence constraint was
  "not automatically a defect" and could be "kept if it can be made to hold". Left as-is, that would
  have led the fix agent to document the constraint as a viable pattern in the same repo that now
  says it is not. Item 6 rewritten: the premise is marked refuted with a pointer to the schema-guide
  paragraph, the constraint is described as unable to hold under concurrent writers, and the
  required comment wording is pinned to the new `chat-simple.qsql` phrasing rather than the old
  "would collide". The ticket's actual instruction (keep the constraint, comment its limit) is
  unchanged.

**Tripwires: none recorded.** Nothing found here is conditional-on-a-future-state; the concerns were
either wrong-now (fixed above) or already ticketed.

**Accepted-tradeoff `NOTE:`s at the touched sites: none found**, so nothing was re-filed against a
prior human decision.

**Handoff caveats resolved.** The implementer flagged two items for a second look and both are now
closed: the fix ticket's stale premise (corrected above), and the risk of the two schema comments
drifting apart (item 6 now pins the exact wording, so a differently-worded comment landing there is
no longer the open risk it was).

**Scope addition judged in bounds.** `docs/reference-app-rn.md` was outside the ticket's `files:`
list; syncing it was correct — it is a verbatim copy of the edited comment and leaving it would have
shipped two docs disagreeing about the same schema.

**Documentation currency checked.** Re-read `docs/schema-guide.md` §"Ordering Events" in full and
every file the change touched. The section's own framing (no commit-order column; use Pattern A or
B) is consistent with the new block, and `docs/schema-guide.md:56`'s cross-reference to the section
still resolves.

**One inaccuracy in the review ticket's own `description:`** — it claimed the change landed in "both
chat schemas". It did not: `schemas/chat.qsql` was deliberately untouched (the fix ticket owns that
file). This ticket's description is corrected.

## Validation

- `yarn lint` — clean, exit 0.
- `tsc --noEmit` on all four packages whose comments were edited (`reference-app-ns`,
  `reference-app-rn`, `reference-app-web`, `integration-tests`) — all exit 0. Comment-only edits
  cannot change behavior, but this rules out a malformed block comment.
- `vitest run` on `reference-app-ns` (103 tests), `reference-app-rn` (192), `reference-app-web` (66)
  — all pass. No pre-existing failures surfaced.
- `packages/integration-tests`' suite was **not** run: it requires real libp2p networking and
  routinely exceeds the 10-minute agent budget, so it is out-of-band by repo convention. Its only
  change is one doc comment and it typechecks.
- **No tests added.** Prose and comments have no behavior to assert, and nothing in the build ingests
  the comment text (verified: the SQL loader does not parse comments, and the packages' embedded
  schema strings carry none).
