description: Code comments across the chat reference apps and a couple of tests claim Quereus stores timestamps with a space ("YYYY-MM-DD HH:MM:SS"), but it actually stores them with a "T" — correct the misleading comments and drop the now-pointless string reformatting they justified.
prereq:
files: packages/reference-app-rn/src/chat-operations.ts, packages/reference-app-web/src/lib/chat-dml.ts, packages/reference-app-web/src/Messages.svelte, packages/reference-app-ns/src/chat-operations.ts, packages/reference-app-ns/src/chat-vm.ts, packages/reference-app-rn/test-fixture/sidecar.mjs, packages/integration-tests/src/scenarios/websocket-chat.integration.ts, packages/cadre-core/test/strand-membership-invite.spec.ts, packages/cadre-core/src/strand-membership-writer.ts, packages/cadre-core/src/control-database.ts, packages/cadre-core/src/canonical-datetime.ts
difficulty: easy
----

# Reconcile Quereus `datetime` format comments to verified reality

## Verified reality (empirical, against the in-use `@quereus/quereus`)

The in-use engine resolves to `link:../quereus/packages/quereus` (root
`package.json` resolutions → `C:\projects\quereus\packages\quereus\dist`). Probes
were run with a bare `new Database()` (builtins only, no plugins), exercising the
exact path the apps use (`db.eval` + a `datetime`-typed column). Findings:

1. **The `datetime()` scalar's *raw string* return is space-form.** Calling the
   builtin implementation directly returns `"2031-03-04 13:00:00"` (a space). The
   source `formatDateTime` (`../quereus/.../func/builtins/datetime.ts:448`) is
   `` `${formatDate(dt)} ${formatTime(dt, subsec)}` `` — a literal space. This is
   the SQLite-shaped value the false comments were presumably written against.

2. **But datetime *values* are normalised to ISO `T`-separated form once they flow
   through the query pipeline / a typed column / a cast.** Empirically:
   - `select datetime(?)` via `db.eval` → `"2031-03-04T13:00:00"` (a `T`).
   - `cast(x as datetime)` → `T`-form (drops a trailing `.000Z`).
   - `canonicalDatetime(db, epochMs)` (which round-trips through `datetime()` via
     `db.eval`) therefore returns **`T`-form**, not space-form.

3. **A `datetime`-typed column stores/reads back `T`-form for *any* valid input.**
   Inserting space-form, `T`-form, or ISO-`Z`+ms all read back as the *same*
   `"2031-03-04T13:00:00"`. Non-zero sub-seconds are preserved (`...00.5`,
   `...42.326`); a zero `.000Z` suffix is dropped. A parallel `text` column keeps
   the verbatim bytes — proving the normalisation is a property of `datetime`
   affinity, not of storage in general.

4. **`order by <datetime column>` is chronologically correct across mixed input
   forms** (verified: inputs at `:41`, `:42.326Z`, ` 43` sort to 41 / 42.326 / 43),
   because every stored value is `T`-form.

5. **Comparisons coerce *only* operands that carry datetime semantics.** When both
   operands are datetime-typed / `cast(... as datetime)` they compare by normalised
   instant (correct). But comparing a `datetime` column/value against a **raw,
   un-coerced bound parameter** (`Exp > ?`) compares the raw param **lexically**:
   `Exp("...T13:00:00") > "2031-03-04 14:00:00"` returns **true** — wrong — because
   at position 10 `'T'`(84) > `' '`(32). So a *space-form* raw operand is the thing
   that mis-orders against the `T`-form column, the **opposite** of what the
   comments claim.

## Conclusion — what the comments got wrong, and whether there is a real bug

- **The "space, not T" comments are doubly false:** (a) a `datetime` column stores
  `T`-form, not space-form; (b) pre-formatting app timestamps to space-form is the
  *wrong* idiom — it is the form that would mis-order in a raw lexical comparison,
  not the form that prevents it.

- **There is no genuine storage/ordering bug in the reference apps.** They embed the
  **chat-simple** schema (`packages/reference-app-{web,rn,ns}/src/chat-strand.ts`,
  matching `schemas/chat-simple.qsql` — `Timestamp datetime not null`, *no*
  `TimeValid` CHECK) and only ever read via `order by Timestamp` (intra-column, all
  `T`-form). Their space-form pre-formatting (`.replace('T',' ').replace(/\.\d{3}Z$/,'')`)
  is a behavioural **no-op for correctness** — every input form converges to `T`-form
  on read. So this is a doc/comment + cleanup task, **not** a behaviour fix, and no
  separate follow-up "genuine bug" ticket is warranted. (The full `schemas/chat.qsql`
  `TimeValid` CHECK using a `now datetime` *context* value is not wired into any app
  path; its coercion was not exhaustively probed — noted below as out of scope.)

- **One production-source comment is factually wrong:**
  `packages/cadre-core/src/strand-membership-writer.ts:356` calls the canonical
  `Expiration` "space-separated" — it is `T`-separated. Note
  `packages/cadre-core/src/control-database.ts:800` already states the truth ("the
  engine `datetime()` separator is `T`, not a space") and is the model to reconcile
  toward.

## Single source of truth

Make `packages/cadre-core/src/canonical-datetime.ts` the authoritative explanation
(it already returns the engine-canonical string and is correctly worded — just
enrich it with the form + the lexical-comparison subtlety). Every other site should
state the corrected fact tersely and *point at* `canonical-datetime.ts` rather than
re-deriving the mechanism. Stay DRY.

## App simplification (recommended, behaviour-equivalent)

Replace the janky `new Date().toISOString().replace('T',' ').replace(/\.\d{3}Z$/,'')`
munging (which AGENTS.md's "no half-baked janky parsers" discourages, and which only
existed to satisfy the false comment) with plain `new Date().toISOString()`. The
`datetime` column coerces it to identical `T`-form; ordering is unaffected (verified
in finding #4). Keep test *assertions* intact — the websocket integration test only
asserts on `Content`, so changing the timestamp form is safe there.

## TODO

### Correct the false comments + simplify

- `packages/reference-app-rn/src/chat-operations.ts:125-126` — fix the comment;
  replace the space-form munging with `new Date().toISOString()`.
- `packages/reference-app-web/src/lib/chat-dml.ts:26-31` — fix the `quereusTimestamp()`
  doc comment; let it return `new Date().toISOString()` (or inline it).
- `packages/reference-app-ns/src/chat-operations.ts:87-88` — same comment + munging fix.
- `packages/reference-app-ns/src/chat-vm.ts:44` — comment only: `formatTime` slices
  `[11,16)` which yields `HH:MM` for both separators; correct the "stores
  YYYY-MM-DD HH:MM:SS" claim (it stores `T`-form).
- `packages/reference-app-web/src/Messages.svelte:49` — comment only: "Strand
  timestamps are 'YYYY-MM-DD HH:MM:SS'" → `T`-separated ISO.
- `packages/reference-app-rn/test-fixture/sidecar.mjs:119` — fix the "Quereus
  DATETIME format" comment; simplify any adjacent space-form munging the same way.
- `packages/integration-tests/src/scenarios/websocket-chat.integration.ts:154-155`
  — fix the comment; simplify the munging. Leave the `Content`-only assertions as-is.

### Fix the false test/source explanations

- `packages/cadre-core/test/strand-membership-invite.spec.ts:291-299` — the test
  passes and asserts the correct behaviour; only the *comment* is false. Reword: both
  operands are produced via `canonicalDatetime` → **`T`-form** (not space-form), and
  the real near-same-instant risk from a raw ISO `Now` is its trailing `.000Z`/ms
  suffix, **not** a `' ' < 'T'` separator mismatch. Keep the test.
- `packages/cadre-core/src/strand-membership-writer.ts:350-358` — correct
  "space-separated `Expiration`" to the `T`-separated canonical form; reconcile the
  mis-order mechanism to match `control-database.ts:800`. Point to
  `canonical-datetime.ts`.

### Single source of truth

- `packages/cadre-core/src/canonical-datetime.ts` — enrich the doc comment with: the
  stored form is ISO `T`-separated; a `datetime` column coerces any valid input
  (space/`T`/ISO-`Z`) to `T`-form on read; raw un-coerced bound params compare
  lexically, so anything that must lexically match a `datetime` value should be
  `T`-form (i.e. produced by this helper / `datetime()` / a cast).
- `packages/cadre-core/src/control-database.ts:796-803` — already correct; optionally
  add a one-line pointer to `canonical-datetime.ts`. Low priority.

### Archived summaries (optional, doc accuracy — low priority)

- `tickets/complete/1-reference-app-web-cadre-node-and-strand.md:57` and
  `tickets/complete/1-formation-convergence-e2e-app-hooks.md:52` repeat the
  `'YYYY-MM-DD HH:MM:SS'` form. These are historical records; correct only if cheap.
  `tickets/complete/control-invite-expiry-same-day-misorder.md` already carries the
  correct analysis (it spawned this ticket) — leave it.

### Validate

- `cd packages/cadre-core && yarn build 2>&1 | tee /tmp/build.log` (or repo-root
  `yarn workspaces foreach -Apt run build` if scoping is awkward).
- Run the touched cadre-core test: the `strand-membership-invite` spec — confirm it
  still passes (comment-only change must not alter behaviour). Stream with `tee`.
- `yarn lint` on the changed packages.
- The real-network `integration-tests` (`websocket-chat.integration.ts`) are
  heavy/possibly not agent-runnable in foreground — if so, document the deferral
  rather than blocking the ticket; the edit there is a comment + a behaviour-equivalent
  timestamp-form change with `Content`-only assertions.

## Out of scope

- The control `FormationInvite`/`FormationUsage` path — reviewed and confirmed
  correct (`control-database.ts:796-803`); both operands are `canonicalDatetime`-derived.
- The full `schemas/chat.qsql` `TimeValid` CHECK (`Timestamp between now ± timespan`)
  with a `now datetime` *context* value — not wired into any reference-app path; its
  context-param coercion was not exhaustively verified here. If it ever gets wired in,
  re-verify that the `now` context value is coerced (not lexically compared) before
  relying on it.
