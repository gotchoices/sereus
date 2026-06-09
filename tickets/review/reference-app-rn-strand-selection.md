description: Review deterministic strand selection + strand picker on the reference-app-rn chat screen
prereq:
files: packages/reference-app-rn/src/strand-selection.ts, packages/reference-app-rn/test/strand-selection.spec.ts, packages/reference-app-rn/src/use-cadre.ts, packages/reference-app-rn/src/use-chat.ts, packages/reference-app-rn/app/index.tsx, packages/reference-app-rn/src/test-ids.ts, packages/reference-app-rn/maestro/_setup.yaml
----

## What landed

The RN chat screen now renders a **deterministic** active strand instead of
`cadre.strands.values().next().value` (which raced the local `createStrand`
against the inbound control-sync auto-join of the drone's pre-created strand).
A new strand-picker lets the user switch strands manually, and an explicit-action
auto-select rule keeps the chat on the strand the user created.

- **`src/strand-selection.ts`** (new) — pure, dependency-free
  `pickActiveStrandId(strandIds, selectedId)`:
  - explicit selection that still exists → that id;
  - otherwise → the **lexicographically smallest** id (stable, order-independent);
  - empty set → `null`.
  This removes the Map-insertion-order dependency entirely.
- **`src/use-cadre.ts`** — added `selectedStrandId` state, a `selectStrand`
  callback, and a `useMemo`-derived `activeStrand` (`pickActiveStrandId([...strands.keys()], selectedStrandId)`
  → `strands.get(id) ?? null`). The three **explicit** user actions
  (`createStrand`, `createClosedStrandWithInvite`, `joinViaInvite`) set
  `selectedStrandId` to the created/joined id. `onDiscovered` (auto-join of a
  *discovered* open strand) is deliberately **untouched** — that is the whole
  point: the drone's pre-created strand syncing in must never steal the chat
  away. `stop()` resets `selectedStrandId` to `null`. All three new members are
  exported and added to `UseCadreResult`.
- **`app/index.tsx`** — `firstStrand` replaced with `cadre.activeStrand`
  (composer `editable` guard now `!!cadre.activeStrand`). New `StrandPicker`
  sub-component: a `ScrollView horizontal` of `Pressable` chips
  (`TEST_IDS.chat.strandPicker`, one chip per strand id, label `id.slice(0,8)`,
  testID `strandRow(id)`, highlighted when active, `onPress → selectStrand(id)`),
  plus a label (`TEST_IDS.chat.strandLabel`) rendering the **full** active strand
  id as visible text with **no `numberOfLines` clamp** so Maestro's exact-text
  match works. Renders nothing when the strand set is empty.
- **`src/use-chat.ts`** — two switch-correctness fixes the picker makes
  reachable: (1) the single boolean `registeredRef` became a
  `Set<string>` of registered strand ids keyed by `strand.strandId` (register the
  local member once **per strand**, not once ever); (2) a new effect clears
  `messages`/`members` and re-enters `loading` when `strand?.strandId` changes,
  so the previous strand's conversation doesn't bleed in before the new strand's
  first poll.
- **`src/test-ids.ts`** — added `chat.strandPicker`, `chat.strandLabel`,
  `chat.strandRow(id)`.
- **`maestro/_setup.yaml`** — after "Switch to Chat tab", a determinism guard:
  `assertVisible { id: chat-strand-label, text: ${WORKING_STRAND_ID} }`. If the
  active strand is ever not the discovered working strand, setup now fails loudly
  here instead of flows 2/3 passing vacuously.

## How to exercise / use cases for testing

**Unit (runs in CI, green now):** `test/strand-selection.spec.ts` covers empty
set, explicit-present-not-smallest, null→smallest, not-in-set→smallest fallback,
single strand, and **order independence** (same ids two orders → same result).
`yarn test` → 84 passing.

**Manual / device use cases the reviewer should sanity-check (no automated
coverage — see gaps):**
- *Both strands present (the original bug):* with the drone's `STRAND_ID`
  pre-created and synced in, tap **Create Strand**; the chat must show the
  phone-created strand (= `WORKING_STRAND_ID`) regardless of which Map slot it
  landed in. The full id under the picker is the `strandLabel`.
- *Manual override:* tap a different chip → `activeStrand` switches, the chip
  highlights, the message list resets (no stale bleed), the local member is
  registered in the newly-selected strand, and polling repopulates from it.
- *Empty set:* before any strand exists, picker renders nothing, composer is
  disabled, and `send` is unreachable (still guarded with "No strand attached").
- *Selected strand disappears:* stop/remove the selected strand → derivation
  falls back to the smallest remaining id, no crash, no dangling reference.

## Validation performed

- `yarn test` (packages/reference-app-rn) — **84 passed** (incl. the 7 new
  `pickActiveStrandId` cases).
- `yarn typecheck` — clean (exit 0).
- `eslint` over all six touched/added files — clean (exit 0).

## Known gaps — treat tests as a floor

- **No render/interaction test for the picker.** This package has only vitest
  unit tests (logic-level: `background-runner`, `strand-selection`); there is no
  React Native render harness wired up, so `StrandPicker`, the `editable` guard,
  the chip-highlight logic, and the use-chat reset/re-registration effects are
  **not** covered by automated tests. They are exercised only by the (gated)
  Maestro e2e. The pure derivation is the only part with unit coverage.
- **e2e not run here.** `yarn test:e2e` is hardware/emulator + drone-fixture
  gated and was **not** executed in this ticket. The new `_setup.yaml`
  determinism assertion is therefore **unverified against a live emulator** —
  worth confirming that Maestro `assertVisible { id, text }` matches the full id
  even when the small-font label visually wraps (it matches element text content,
  not rendered lines, so it should — but this is unconfirmed on-device). Defer to
  CI/human with an emulator + drone fixture.
- **Effect ordering for reset-on-switch** relies on React running the reset
  effect (declared before the polling effect) on the same commit as a strand
  change. Verified by reasoning, not on-device; a reviewer may want to confirm
  there's no one-frame flash of the old list on a real switch.
- **Selection does not persist across full app restart** (resets to `null` →
  deterministic smallest-id fallback). Explicitly out of scope per the ticket;
  noted, not implemented.

## Acceptance status

- `pickActiveStrandId` unit tests — **pass**.
- `yarn typecheck` + `yarn test` — **pass**.
- Flows 2/3 reliability + `_setup.yaml` loud-fail — **implemented, e2e-unverified**
  (emulator-gated; see gaps).
