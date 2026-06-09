description: Deterministic strand selection + strand picker on reference-app-rn chat screen
prereq:
files: packages/reference-app-rn/app/index.tsx, packages/reference-app-rn/src/use-cadre.ts, packages/reference-app-rn/src/use-chat.ts, packages/reference-app-rn/src/test-ids.ts, packages/reference-app-rn/src/strand-selection.ts (new), packages/reference-app-rn/test/strand-selection.spec.ts (new), packages/reference-app-rn/maestro/_setup.yaml
----

## Problem (recap)

`app/index.tsx:23` picks the chat strand non-deterministically:

```ts
const firstStrand = cadre.strands.values().next().value ?? null;
```

`cadre.strands` is a `Map<string, StrandInstance>` and its iteration order is
insertion order, which is a race between the local `createStrand` and the
inbound control-sync auto-join of the drone's pre-created strand (`STRAND_ID`).
When both strands are present the chat can show either one. In the e2e flows
the drone-side helpers target `WORKING_STRAND_ID` (the phone-created strand
discovered via `discover-phone-strand.js`), so if the chat happens to show
`STRAND_ID` instead, flows 2 and 3 silently miss each other's messages.

## Design decision

**Chosen: Option 1 (strand picker UI) + a deterministic auto-selection rule**
(which folds in the spirit of Option 3 — "most-recently-created locally" as the
default). This is the recommended path in the plan ticket and resolves both the
UX gap and the e2e determinism in one change. Option 2 (drop "Create Strand"
from the flow) is rejected because it sacrifices coverage of the Create Strand
button for no lasting UX benefit.

The two mechanisms compose:

1. **Deterministic active-strand derivation.** A pure helper decides which
   strand the chat renders, given the strand set and an explicit selection.
   Rule, in order:
   - if an explicit `selectedStrandId` is set **and** present in the set → use it;
   - else → the **lexicographically smallest** strand id (stable, order-independent);
   - else (empty set) → `null`.
   This is deterministic regardless of `Map` insertion order, so it never
   depends on the create-vs-sync race.

2. **Auto-select on explicit user action.** When the user explicitly creates or
   joins a strand (`createStrand`, `createClosedStrandWithInvite`,
   `joinViaInvite`), set `selectedStrandId` to that strand id. The auto-join of
   a *discovered* open strand (`onDiscovered` in use-cadre.ts) must **not**
   change the selection — that is the whole point: the drone's pre-created
   strand syncing in must never steal the chat away from the strand the user
   created.

   Net effect for the e2e: tapping "Create Strand" makes the phone-created
   strand the active strand, which equals `WORKING_STRAND_ID`, regardless of
   whether `STRAND_ID` synced in first or later. No flow needs to tap the
   picker; the picker is the UX win and a manual override.

3. **Strand picker.** A row of selectable chips on the chat screen, one per
   `cadre.strands`, highlighting the active one; tapping a chip calls
   `selectStrand(id)`. Plus a label element rendering the **full** active strand
   id so Maestro can assert determinism (see below).

### Interfaces

New pure module `src/strand-selection.ts`:

```ts
/**
 * Decide which strand the chat should render. Deterministic and independent of
 * Map insertion order, so it never depends on the create-vs-control-sync race.
 *
 *  - explicit selection that still exists  -> that id
 *  - otherwise                             -> lexicographically smallest id
 *  - empty set                             -> null
 */
export function pickActiveStrandId(
  strandIds: readonly string[],
  selectedId: string | null,
): string | null;
```

`UseCadreResult` (src/use-cadre.ts) gains:

```ts
/** Explicitly selected strand id (null = use the deterministic default). */
selectedStrandId: string | null;
/** The strand the chat should render, per pickActiveStrandId. Null if none. */
activeStrand: StrandInstance | null;
/** Pick a strand to view; persists until changed or the strand disappears. */
selectStrand: (strandId: string) => void;
```

`TEST_IDS.chat` (src/test-ids.ts) gains:

```ts
strandPicker: 'chat-strand-picker',
strandLabel: 'chat-strand-label',         // renders the FULL active strand id
strandRow: (id: string) => `chat-strand-${id}`,
```

## Edge cases & interactions

- **Both strands present** (drone pre-created `STRAND_ID` + phone-created): after
  "Create Strand", active strand MUST be the phone-created one regardless of
  which `Map` slot it landed in. Covered by the helper test + the `_setup.yaml`
  assertion.
- **Empty strand set**: `activeStrand === null`. Composer input stays disabled
  (replace the existing `!!firstStrand` editable guard with `!!cadre.activeStrand`),
  picker renders no chips, `send` throws "No strand attached" (already guarded in
  use-chat.ts). No crash.
- **Selected strand disappears** (stopped / removed from the map): derivation
  falls back to the lexicographically smallest id — no dangling reference, no
  crash. `selectStrand` may store an id not (yet) in the set; the derivation
  guards on presence, so an as-yet-unsynced selection simply resolves to the
  fallback until it appears, then becomes active.
- **Discovered-strand auto-join must not steal selection**: `onDiscovered`
  joins open strands but leaves `selectedStrandId` untouched. Verify by reading
  the handler — it must not call `selectStrand`.
- **Switching strands via the picker — member re-registration**: `use-chat.ts`
  guards `insertMember` with a single `registeredRef` boolean, so switching to a
  second strand would skip registering the local member there. Replace the
  boolean with a `Set<string>` of registered strand ids keyed by
  `strand.strandId` (register once per strand). The e2e never exercises two
  active strands, but the picker makes this reachable.
- **Switching strands — stale message bleed**: `messages`/`members` state is not
  cleared on strand change, so the previous strand's messages render until the
  first poll of the new strand completes. Clear `messages` and `members` (and
  reset `loading`) when `strand?.strandId` changes so the list doesn't show the
  wrong conversation mid-switch.
- **Cold-start / OS-killed node** (`ensureNode` re-creates the node): the hook
  stays mounted so `selectedStrandId` survives; `getStrands()` repopulates and
  `activeStrand` recomputes. A full app restart resets `selectedStrandId` to
  `null` → deterministic fallback to the smallest id. Persisting the selection
  across restarts is **out of scope** (note it; do not implement).
- **Maestro text matching**: render the full active strand id as the visible
  text of the `strandLabel` element (small font, allow wrap — do **not**
  `numberOfLines`-clamp it), so `assertVisible { id, text }` reliably matches
  `${WORKING_STRAND_ID}`.

## Acceptance

- Flows 2 and 3 reliably pass when the drone has both the pre-created and the
  phone-created strand present at insert/assert time.
- `_setup.yaml` fails loudly (rather than flows 2/3 silently diverging) if the
  chat is not showing `WORKING_STRAND_ID`.
- `pickActiveStrandId` unit tests pass.
- `yarn typecheck` and `yarn test` pass in `packages/reference-app-rn`.

## TODO

### Phase 1 — pure selection helper

- Create `src/strand-selection.ts` exporting `pickActiveStrandId(strandIds, selectedId)`
  per the interface above. Keep it dependency-free and pure.
- Create `test/strand-selection.spec.ts` (vitest, mirror the style of
  `test/background-runner.spec.ts`) covering:
  - empty set → `null`;
  - explicit selection present → returns it **even when it is not the smallest**;
  - explicit selection `null` → smallest lexicographic id;
  - explicit selection not in the set → smallest lexicographic id (fallback);
  - single strand, selection `null` → that strand;
  - **order independence**: same ids in two different array orders → identical result.

### Phase 2 — cadre hook wiring

- In `src/use-cadre.ts`:
  - Add `selectedStrandId` state (`string | null`, default `null`) and a
    `selectStrand` callback that sets it.
  - Derive `activeStrand` with `useMemo` from `pickActiveStrandId([...strands.keys()], selectedStrandId)`
    then `strands.get(activeId) ?? null`.
  - In `createStrand`, `createClosedStrandWithInvite`, and `joinViaInvite`, set
    `selectedStrandId` to the created/joined strand id.
  - Do **not** touch the selection in `onDiscovered`.
  - On `stop()`, reset `selectedStrandId` to `null` alongside the other resets.
  - Export `selectedStrandId`, `activeStrand`, `selectStrand` from the returned
    object and add them to `UseCadreResult`.
- `src/cadre-context.tsx` needs no change (it forwards the whole result object).

### Phase 3 — chat screen picker

- In `app/index.tsx`:
  - Replace `firstStrand` with `cadre.activeStrand`; update `useChat({ strand })`
    and the composer `editable` guard (`!!cadre.activeStrand`).
  - Add a horizontal strand picker (e.g. a `ScrollView horizontal` of `Pressable`
    chips) below the status bar, testID `TEST_IDS.chat.strandPicker`. One chip
    per `cadre.strands` entry: label `id.slice(0, 8)`, testID
    `TEST_IDS.chat.strandRow(id)`, highlighted when it is the active strand;
    `onPress` → `cadre.selectStrand(id)`.
  - Render the **full** active strand id in a label with testID
    `TEST_IDS.chat.strandLabel` (only when `activeStrand` exists). Small font,
    no `numberOfLines` clamp.
- Add the new ids to `src/test-ids.ts` (`strandPicker`, `strandLabel`,
  `strandRow(id)`).

### Phase 4 — use-chat correctness for switching

- In `src/use-chat.ts`:
  - Replace the boolean `registeredRef` with a `Set<string>` of registered
    strand ids; register the member once per `strand.strandId`.
  - Clear `messages`/`members` (and set `loading` true) when `strand?.strandId`
    changes, before the first poll of the new strand.

### Phase 5 — e2e determinism guard

- In `maestro/_setup.yaml`, after the "Switch to Chat tab" step, assert the chat
  is showing the discovered working strand:

  ```yaml
  - assertVisible:
      id: "chat-strand-label"
      text: ${WORKING_STRAND_ID}
  ```

  This enforces the acceptance criterion "no silent divergence" — if the active
  strand is ever not `WORKING_STRAND_ID`, setup fails here instead of flows 2/3
  passing vacuously. (Note: e2e is hardware/emulator-gated via
  `yarn test:e2e`; run it only if an emulator + drone fixture are available,
  otherwise document the deferral for CI/human.)

### Validation

- `cd packages/reference-app-rn`
- `yarn test 2>&1 | tee /tmp/rn-test.log`
- `yarn typecheck 2>&1 | tee /tmp/rn-typecheck.log`
- e2e (`yarn test:e2e`) only if an emulator + drone fixture are wired up; else
  note the deferral.
