description: Corrected comments and tests that wrongly claimed Quereus stores timestamps in a "YYYY-MM-DD HH:MM:SS" space form, and removed the now-pointless string munging that reformatted timestamps before inserting them.
prereq:
files: packages/reference-app-rn/src/chat-operations.ts, packages/reference-app-web/src/lib/chat-dml.ts, packages/reference-app-web/src/Messages.svelte, packages/reference-app-ns/src/chat-operations.ts, packages/reference-app-ns/src/chat-vm.ts, packages/reference-app-rn/test-fixture/sidecar.mjs, packages/integration-tests/src/scenarios/websocket-chat.integration.ts, packages/cadre-core/test/strand-membership-invite.spec.ts, packages/cadre-core/src/strand-membership-writer.ts, packages/cadre-core/src/canonical-datetime.ts
----

## Summary

Comment corrections and behaviour-equivalent timestamp simplifications. The implementation replaced the false "space-form" claim with the verified T-separated truth and dropped five `.replace('T', ' ')…` munging sites. No schema, SQL, or runtime-logic changes.

## Review findings

### Core factual claims — VERIFIED against quereus source

The whole ticket rests on the claim that a Quereus `datetime` column coerces any valid input form to T-separated ISO (no trailing `Z`) on read. Traced through the actual engine:

- **Column coercion → T-form.** `DATETIME_TYPE.parse` (`quereus/.../types/temporal-types.ts:174`) returns `parseDateTimeStringToUtcPlain(v).toString()`, i.e. `Temporal.PlainDateTime.toString()` → `YYYY-MM-DDTHH:MM:SS[.frac]`, no `Z`. `parseDateTimeStringToUtcPlain` (line 11) accepts space-form, T-form, and `Z`/offset ISO. So space/T/ISO-Z all coerce to T-form. ✔
- **`canonicalDatetime` → T-form.** `select datetime(?)` with one arg resolves via `getFunction(name, 1)` (`schema/schema.ts:197`, exact-arity before variadic `-1`) to the conversion `DATETIME_FUNC` (`conversion.ts:169`, numArgs 1), NOT the variadic builtin `datetimeFunc` (`datetime.ts:472`, numArgs -1) whose `formatDateTime` would have produced *space*-form. Both are registered under distinct keys (`datetime/1`, `datetime/-1`), so no collision. The enriched `canonical-datetime.ts` `@returns` (T-separated, no Z) is correct. ✔
- **All touched insert sites use `Timestamp datetime not null`** (chat-strand schemas in rn/ns/web and `websocket-chat.integration.ts:36`), so removing the munging is genuinely behaviour-equivalent. ✔

### Finding (minor — FIXED inline)

`strand-membership-invite.spec.ts` test *"admits a member with a same-UTC-day future expiry"*: the implementer corrected the comment's facts (T-form, `.000Z`) but the corrected facts contradict the comment's stated purpose. With a **one-hour** gap, canonical `Expiration` (`…T13:00:00`) vs a regressed raw ISO `Now` (`…T12:00:00.000Z`) diverge at the **hour digit (position 12)** in the *admit-correct* direction — so a raw-ISO-Now regression would still pass this test. The `.000Z` suffix (position 19+) only matters when both sides are equal through the seconds, which a one-hour gap never reaches. The claim "this test guards the divergence … because of the trailing `.000Z`" was inaccurate. Rewrote the comment to state honestly what the test pins (sub-day / time-of-day granularity of `Expiration > Now`) and that it does NOT distinguish canonical vs raw ISO Now.

### Other aspects checked

- **`quereusTimestamp()` returning full ISO with `.000Z`** (the implementer's flagged review focus): acceptable. All callers write into `datetime` columns, which coerce to T-form on read. Web (`messages.svelte.ts`) always displays from a DB read, so it shows T-form. rn/ns return the in-memory `now` (raw ISO-Z) in the optimistic `ChatMessage`, but `formatTime` slices `[11,16]` → `HH:MM` for both forms, so no display regression. No change made.
- **`strand-membership-writer.ts` consumeInvite doc** (line 348-361): production compares two canonical T-form strings (Now via `canonicalDatetime`, Expiration via the same), so byte-for-byte ordering is correct. The corrected `.000Z` rationale for the diverging *control* layer is defensible; left as-is.
- **DRY / single-source:** the `canonical-datetime.ts` enrichment is the right home for the stored-form contract; `control-database.ts:796-803` already states the same fact (model doc, untouched). No duplication introduced.
- **Lint:** `yarn lint` passes (exit 0).

### Pre-existing failure (flagged, not mine)

`strand-membership-invite.spec.ts` fails 21/25 with `Error: Unsupported output encoding: utf8` from `digest(payload, 'sha256', 'utf8', 'bytes')` (`strand-membership-writer.ts:50`). Root cause is API drift: `quereus-plugin-crypto`'s `digest` is now 3-arg `(fields, algorithm, encoding)`, matching the pre-existing `TS2554: Expected 1-3 arguments, but got 4` build errors. This ticket made comment-only changes to that file and never touched a `digest()` call. A prior triage (commit ba2beaf) documented an earlier manifestation (`libp2p not set`) of the same broken file; the failure now surfaces as the `digest` encoding error first. Re-flagged in `tickets/.pre-existing-error.md` for the runner to re-triage. The failing tests do not exercise the datetime corrections.
