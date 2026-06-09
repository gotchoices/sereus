description: Deterministic strand selection + strand picker on the reference-app-rn chat screen (reviewed)
files: packages/reference-app-rn/src/strand-selection.ts, packages/reference-app-rn/test/strand-selection.spec.ts, packages/reference-app-rn/src/use-cadre.ts, packages/reference-app-rn/src/use-chat.ts, packages/reference-app-rn/app/index.tsx, packages/reference-app-rn/src/test-ids.ts, packages/reference-app-rn/maestro/_setup.yaml, packages/reference-app-rn/maestro/_helpers/discover-phone-strand.js, packages/reference-app-rn/README.md
----

## What landed

The RN chat screen now renders a **deterministic** active strand instead of
`cadre.strands.values().next().value`, plus a strand-picker to switch manually.
Active-strand selection is a pure helper (`pickActiveStrandId`): an explicit
user selection that still exists wins; otherwise the lexicographically smallest
id; empty set → `null`. The three explicit user actions (`createStrand`,
`createClosedStrandWithInvite`, `joinViaInvite`) set the selection so the chat
stays on the user's strand even as the drone's pre-created open strand auto-joins
in the background; `onDiscovered` deliberately does not touch the selection.
`use-chat` registers the local member once **per strand** and resets the
conversation on strand switch. A Maestro determinism guard in `_setup.yaml`
fails loudly if the chat is ever not showing the discovered working strand.

See the implement commit (`ticket(implement): reference-app-rn-strand-selection`)
for the full implementation narrative.

## Review findings

Adversarial pass over the implement diff (read diff-first, then handoff). Lint,
typecheck, and unit tests all pass (`yarn test` → 84, `yarn typecheck` exit 0,
`eslint` over touched files clean) both before and after the fixes below.

### Correctness — one real race found and fixed (minor)

- **Stale in-flight `refresh` re-bled the previous strand's conversation
  (FIXED).** `use-chat.refresh` captures `s = strandRef.current` at call time and
  awaits the DB queries. The reset-on-switch effect clears `messages`/`members`
  synchronously when `strand?.strandId` changes, but a `refresh()` that was
  already in flight for the *previous* strand (interval-fired or the polling
  effect's initial fetch) would resolve *after* the switch and call
  `setMessages`/`setMembers` with the old strand's rows — re-introducing exactly
  the cross-strand bleed the reset effect exists to prevent (and flipping
  `loading` for the wrong strand). Fixed inline in
  `packages/reference-app-rn/src/use-chat.ts`: after the await (and in the
  `catch`/`finally`), bail if `strandRef.current !== s`, so only the still-active
  strand's result is applied. Narrow window (≤ the 2 s poll interval, requires a
  query in flight during a tap), but on the exact theme of this ticket
  (no stale bleed on switch), so fixed rather than filed.

### Correctness — verified sound

- **Deterministic selection** (`pickActiveStrandId`) is order-independent and
  the unit tests cover empty / explicit-present / null→smallest /
  not-in-set→fallback / single / order-independence. The original
  create-vs-control-sync race is genuinely removed: selection is set on every
  explicit create/join, `onDiscovered` leaves it alone, and `stop()` resets it.
- **No other consumers** of the old `strands.values().next()` pattern remain
  (grep clean across `app/` + `src/`).
- **Maestro guard is meaningful, not vacuous.** `discover-phone-strand.js` sets
  `WORKING_STRAND_ID` to the phone-created strand (id ≠ drone `STRAND_ID`), and
  the phone selects that strand on create, so `chat-strand-label` text equals
  `WORKING_STRAND_ID` deterministically. Strand ids are UUIDs (no regex
  metacharacters), so Maestro's regex `text:` match behaves as a literal/exact
  match against the full-id label. testID namespaces don't collide
  (`chat-strand-label` vs `chat-strand-<uuid>`).
- **`insertMember` is `insert or ignore`** (idempotent), so the per-strand
  `registeredStrandsRef` Set is purely an optimization. Its lack of clearing on
  disconnect/reconnect is therefore benign: a redundant re-register is skipped,
  and the member row persists in the strand DB regardless. Noted, not changed.

### Docs (minor, FIXED)

- `packages/reference-app-rn/README.md` described the Chat tab as showing "the
  strand" (singular) and made no mention of multiple attached strands or the new
  picker. Added a concise paragraph in "Create a strand and chat" describing the
  deterministic active-strand rule and the chip picker, so the docs reflect the
  new multi-strand reality. No other docs reference chat-screen strand selection.

### Edge / error / resource cleanup — checked

- Empty strand set → picker renders nothing, composer `editable` guard false,
  `send` still guarded with "No strand attached". OK.
- Selected strand disappears → `pickActiveStrandId` falls back to smallest id;
  no dangling reference. OK.
- Event listeners (`strand:*`) and the polling `setInterval` are torn down in
  effect cleanups. OK. `stop()` resets `selectedStrandId`. OK.

### Gaps carried forward (not regressions, deferred to CI/human)

- **No RN render/interaction test harness in this package** (vitest is
  logic-only). `StrandPicker`, the chip-highlight, the `editable` guard, and the
  use-chat reset/re-registration/stale-guard effects remain covered only by the
  emulator-gated Maestro e2e. This is a pre-existing package limitation, not
  introduced here; standing up a render harness is out of scope for a review
  pass. The pure derivation is unit-covered.
- **`yarn test:e2e` not run** (hardware/emulator + drone-fixture gated). The new
  `_setup.yaml` determinism assertion is therefore unverified against a live
  emulator. Deferred to CI/human with an emulator + drone fixture.

No major findings → no new fix/plan/backlog tickets filed.

## Validation performed

- `yarn test` (packages/reference-app-rn) — **84 passed**.
- `yarn typecheck` — clean (exit 0).
- `eslint` over touched/added files — clean (exit 0).
- e2e — not run (emulator-gated; see gaps).

## Acceptance status

- Deterministic active-strand selection + picker — **implemented, reviewed**.
- Stale-result switch race — **found and fixed in review**.
- Docs — **updated**.
- `yarn typecheck` + `yarn test` + lint — **pass**.
- Flows 2/3 reliability + `_setup.yaml` loud-fail — **implemented, e2e-unverified**
  (emulator-gated).
