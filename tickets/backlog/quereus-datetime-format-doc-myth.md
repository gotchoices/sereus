description: Many code comments and reference apps claim Quereus stores date-times as "YYYY-MM-DD HH:MM:SS" with a space, but the engine actually emits an ISO "T" separator — reconcile the docs and confirm the apps still compare/store dates correctly.
prereq:
files: packages/reference-app-rn/src/chat-operations.ts, packages/reference-app-web/src/lib/chat-dml.ts, packages/reference-app-ns/src/chat-operations.ts, packages/integration-tests/src/scenarios/websocket-chat.integration.ts, packages/cadre-core/test/strand-membership-invite.spec.ts, packages/cadre-core/src/canonical-datetime.ts
difficulty: medium
----

# Quereus `datetime` canonical format: docs say space, engine emits `T`

## What was observed (during review of `control-invite-expiry-same-day-misorder`)

The engine's `datetime()` scalar and `cast(? as datetime)` both emit the ISO
**`T`-separated** `PlainDateTime` form, verified empirically against the in-use
`@quereus/quereus`:

```
select datetime(?)            -> "2031-03-04T13:00:00"   (char@10 = 'T')
select cast(? as datetime)    -> "2031-03-04T13:00:00"   (normalises an ISO '.000Z' input too)
```

Yet a recurring comment across the codebase asserts the **space-separated** SQLite
form `YYYY-MM-DD HH:MM:SS`:

- `packages/reference-app-rn/src/chat-operations.ts:~125` — *"Quereus DATETIME expects 'YYYY-MM-DD HH:MM:SS', not ISO 8601 with 'T'/'Z'"* and **actively formats timestamps to space-form before insert**.
- `packages/reference-app-web/src/lib/chat-dml.ts:~26` — same claim + formatting.
- `packages/reference-app-ns/src/chat-operations.ts:~87` and `chat-vm.ts:~44` — same.
- `packages/integration-tests/src/scenarios/websocket-chat.integration.ts:~154` — same.
- `packages/cadre-core/test/strand-membership-invite.spec.ts:~296` — claims both sides canonicalise to `YYYY-MM-DD HH:MM:SS` and that an ISO `Now` "mis-orders at position 10 (' ' < 'T')". The strand code itself derives both operands via `canonicalDatetime` (so it is internally consistent and correct), but the explanatory comment repeats the false mechanism.
- Two `tickets/complete/*` summaries reference the same `'YYYY-MM-DD HH:MM:SS'` form.

## Why this matters

1. **Doc accuracy / maintainability.** The space-vs-`T` mechanism is cited as the
   root cause of a class of "same-UTC-day expiry mis-order" bugs. That mechanism is
   false for any path where both comparison operands are produced by
   `canonicalDatetime`/`datetime()` (they are both `T`-form). The control-layer fix
   that spawned this ticket turned out to be a **behavioral no-op** dressed as a bug
   fix because of this misconception — future work risks the same misdiagnosis.

2. **Possible real divergence in the reference apps.** Those apps *pre-format to
   space-form strings* and insert them into `datetime` columns. Depending on whether
   the column coerces (→ `T`) or stores the literal verbatim (→ space), real strand
   data could contain a **mix** of `T`- and space-separated timestamps, and lexical
   `>`/ordering across that mix would mis-order at position 10 for real. This needs
   verification end-to-end (insert via the app path, read back, compare), not
   assumed.

## Scope

- Determine the authoritative Quereus `datetime` storage/representation: what a
  `datetime` *column* stores when given (a) a `datetime()`/`cast` value, (b) a raw
  space-form string, (c) a raw ISO `T`/`Z` string; and what is read back.
- Reconcile every comment above to the verified reality (single source of truth — do
  not duplicate the explanation; point at `canonical-datetime.ts`).
- If the reference apps' space-form formatting produces stored values that diverge
  from `datetime()`-form values used elsewhere (e.g. strand expiry/Now), file a
  follow-up fix — this is the part that could be a genuine bug, not just a doc fix.

Out of scope: the control `FormationInvite`/`FormationUsage` path, which was reviewed
and confirmed correct (both operands are `canonicalDatetime`-derived).
