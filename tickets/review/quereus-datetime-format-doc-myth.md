description: Review comment corrections that reconcile the false "YYYY-MM-DD HH:MM:SS space-form" claim in chat apps and cadre-core tests to the verified T-separated truth, plus the removal of the now-pointless `.replace('T',' ')` munging.
prereq:
files: packages/reference-app-rn/src/chat-operations.ts, packages/reference-app-web/src/lib/chat-dml.ts, packages/reference-app-web/src/Messages.svelte, packages/reference-app-ns/src/chat-operations.ts, packages/reference-app-ns/src/chat-vm.ts, packages/reference-app-rn/test-fixture/sidecar.mjs, packages/integration-tests/src/scenarios/websocket-chat.integration.ts, packages/cadre-core/test/strand-membership-invite.spec.ts, packages/cadre-core/src/strand-membership-writer.ts, packages/cadre-core/src/canonical-datetime.ts
difficulty: easy
----

## What was done

All changes are **comment corrections and behaviour-equivalent timestamp simplifications** — no schema, SQL, or logic changes.

### Timestamp munging removed (behaviour-equivalent)

The following five sites replaced:
```ts
new Date().toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '')
```
with:
```ts
new Date().toISOString()
```

- `packages/reference-app-rn/src/chat-operations.ts` — `insertMessage`
- `packages/reference-app-ns/src/chat-operations.ts` — `insertMessage`
- `packages/reference-app-web/src/lib/chat-dml.ts` — `quereusTimestamp()` helper + its doc comment
- `packages/reference-app-rn/test-fixture/sidecar.mjs` — `insertMessage`
- `packages/integration-tests/src/scenarios/websocket-chat.integration.ts` — local `now` variable

The `datetime` column coerces any valid input form (space/T/ISO-Z) to T-form on read, so the ordering behavior is identical. The test's assertions are on `Content` only, not on the timestamp form.

### Comment-only corrections

- `packages/reference-app-ns/src/chat-vm.ts:44` — `formatTime` comment: "stores `YYYY-MM-DD HH:MM:SS`" → "stores timestamps as T-separated ISO"
- `packages/reference-app-web/src/Messages.svelte:49` — `formatWhen` comment: same correction
- `packages/cadre-core/test/strand-membership-invite.spec.ts:296-299` — corrected: both operands are T-form (not space-form); the real mis-ordering risk of a raw ISO `Now` is a trailing `.000Z` at position 19+, not a `' ' < 'T'` separator issue at position 10
- `packages/cadre-core/src/strand-membership-writer.ts:356` — corrected: "space-separated `Expiration`" → "T-separated `Expiration`"; added "due to a trailing `.000Z` suffix"

### Single-source enrichment

- `packages/cadre-core/src/canonical-datetime.ts` — enriched with:
  - Stored form is T-separated ISO, no trailing Z
  - Any valid input coerces to that form on read
  - Raw un-coerced bound params compare lexically — anything compared via `> ?` should be produced by this helper

## Testing

- All test failures in `strand-membership-invite.spec.ts` (25/25) are **pre-existing** — confirmed by running the spec on HEAD before any edits. Root cause is `MissingServiceError: libp2p not set` in `connectToStrand`, unrelated to this ticket. Documented in `tickets/.pre-existing-error.md`.
- Build errors in `cadre-core` (`TS2554: Expected 1-3 arguments, but got 4`) are also pre-existing — all in files not touched by this ticket.
- The integration test (`websocket-chat.integration.ts`) is a real-network test; the timestamp change is behaviour-equivalent (datetime column coerces to T-form regardless), and assertions are `Content`-only.

## Known gaps / review focus

- Verify the `quereusTimestamp()` helper in `chat-dml.ts` is acceptable returning the full ISO string (with `.000Z`), or whether callers would prefer it stripped. Both forms coerce identically on a `datetime` column, but a reviewer may prefer the cleaner T-form via `new Date().toISOString().replace(/\.\d{3}Z$/, '')` to avoid the trailing Z being stored verbatim if ever used against a `text` column.
- `packages/cadre-core/src/control-database.ts:796-803` already states the correct T-form fact; no change made (it was the model doc).
- Archived complete tickets were not updated (low-priority historical records as noted in the implement ticket).
