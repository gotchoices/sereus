description: After removing a device, both reference apps now keep showing which private workspaces still have a key replacement waiting, and tell the owner how to finish each one: ask the workspace's host for a fresh invitation and join with it, or have the host admit the key shown.
prereq: pending-party-key-rotations-listed
architecture: docs/architecture.md#removing-a-machine
files: packages/reference-app-rn/src/machines-section.tsx (`useWaitingRotations`, `WaitingRotations`, `WaitingRotationRow`), packages/reference-app-rn/src/machines.ts (`WAITING_ROTATIONS_TITLE`, `waitingRotationLine`), packages/reference-app-rn/src/machine-removal.tsx (`unfinishedWorkspaces`), packages/reference-app-rn/src/share-code.tsx (`CopyBtn`), packages/reference-app-rn/src/use-cadre.ts, packages/reference-app-rn/src/cadre-phone.ts, packages/reference-app-rn/src/test-ids.ts, packages/reference-app-web/src/Machines.svelte, packages/reference-app-web/src/lib/machines.svelte.ts (`refreshWaitingRotations`, `waitingRotationLine`, `unfinishedWorkspaces`), packages/reference-app-web/src/lib/store.svelte.ts, packages/reference-app-web/README.md, docs/reference-app-rn.md
----
# The reference apps show the key replacements still waiting

Both apps now list `CadreNode.listPendingPartyKeyRotations()` in the Devices and nodes card, in a **"Key replacements waiting"** block below the machines and invited devices. The block appears only when the list is non-empty, with one line per workspace, by id:

- `another-party`: "‹id›: ask this workspace's host for a fresh invitation and join with it from this device; or have the host admit key ‹public key›." The key is shown in full and can be copied: `Copyable` in the browser; selectable text plus a new `CopyBtn` on the phone.
- `owner-machine`: "‹id›: finishes on an owner device that runs it."
- `sealed`: "‹id›: this workspace is sealed, so nobody can admit a new key; the removed device stays a member until the workspace is re-created."

The browser says "this tab" for "this device", as the card's other wording does. A device or tab whose standing is not `owner` (member, unreadable or still checking) reads "from an owner device".

The removal confirmation's `another-party` line now reads "‹id›: needs the other party's manager: ask the host for a fresh invitation, or have them admit the key shown under Key replacements waiting".

**When it is read.** With the machines list (which covers after a removal and Refresh; a removal from the phone's Rent an always-on node section gets there through `handleForget`, `onRentalsChanged` and `refreshKey`, even when forgetting the rental fails), and when the node raises `strand:party-key-rotation-blocked` or `strand:party-key-rotated`. The browser subscribes once in `store.svelte.ts`, which also records both events in its log; the phone subscribes per node in `useWaitingRotations`. A failed read logs and keeps the last list. The read is separate from the machines read, so neither failure affects the other. Only the latest read begun may write the list, because event-driven reads can overlap and an earlier one can finish last.

## Choices the ticket did not spell out

- **The line stops at "admit key".** `waitingRotationLine` leaves out the key so each view can place it in its copyable form. The phone appends the key and the period itself; the browser puts `Copyable` and a period after the text.
- **`COPY_LABEL.failed` changed** from "select the text below instead" to "select the text instead", because the new row shows the key above its Copy button. `ShareCode` shows the same label.
- **The join flow on the phone** is **Join via Invite** under Closed Strand (Invite-Only), which is what the doc names; the ticket called it "the join section". I confirmed by reading that both join flows work for a strand already running here: `addStrand` takes the `claimTrackedStrand` path, and `formStrand` re-forms and stages the invitation. `Form strand` on Home is enabled whenever the node runs.
- **A `NOTE:` on `unfinishedWorkspaces`, in both apps,** records that the plan cannot tell a sealed workspace from one another party can still finish, so a sealed one gets the "ask the host" line in the confirmation and the accurate line in the list. The ticket accepted this mismatch. The confirmation's words were the ticket's, so please check whether you find them misleading for a sealed workspace.

## Known gaps

- **Not seen rendered.** No device or browser has shown this block with a real row, because producing one takes a second party's strand. Layout is unchecked, in particular the browser's inline `Copyable` followed by a period, and the phone's long unbroken key in a `hint` line. `scenario-party-key-rotation-across-parties` is the real-network proof of the listing, and it does not cover these screens.
- **A first read that fails shows nothing.** The ticket asks for log-and-keep-last, so with no earlier list the block stays absent and only the log says why. The machines read also shows an error line; this one does not. The phone's section also loses its list when it unmounts (a disconnect or a join), so the first read after that has no earlier list to keep.
- **The phone's stale-read guard is only the read counter**, unlike the browser's, which also compares the node. The section's refresh effect starts a new read in the same commit that changes the node, so the older read is dropped. Please check this reasoning.

## Validation

No tests were added, as the ticket decided: the wording is copy and the projection is one mapping per state.

| Run | Result |
|---|---|
| `yarn workspace @serfab/reference-app-rn typecheck` | exit 0 |
| `yarn workspace @serfab/reference-app-web check:svelte` | 0 errors, 0 warnings |
| `yarn workspace @serfab/reference-app-web typecheck` | exit 0 |
| `yarn workspace @serfab/reference-app-web vite build` | exit 0 |
| `yarn lint` | exit 0 |
| `yarn workspace @serfab/reference-app-web test` | 4 files, 11 passed |
| `yarn workspace @serfab/reference-app-rn test` | 20 files, 180 passed |

The app typechecks first failed because `packages/cadre-core/dist` predated the listing, so I ran `yarn workspace @serfab/cadre-core build` (git-ignored output, this repo's package). No sibling repository was built or written.

## How to try it

- **Waiting on another party:** in a browser tab, form a closed strand with a second party's invitation, add another machine to the first party, and remove it. The confirmation shows the new line. Afterwards the block shows the `another-party` line with the key. Have the host make a fresh invitation, paste it into *Form strand*, and the line should go away when the swap fires `strand:party-key-rotated`.
- **Non-owner:** the same list on a member device reads "from an owner device".
- **Second device:** another machine of the party shows the entry after its Refresh, with no push.
- **Failed read:** make `listPendingPartyKeyRotations` throw with a list on screen; the list stays and the log has "could not read the key replacements waiting".
