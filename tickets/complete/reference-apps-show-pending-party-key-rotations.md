description: After removing a device, both reference apps now keep showing which private workspaces still have a key replacement waiting, and tell the owner how to finish each one: ask the workspace's host for a fresh invitation and join with it, or have the host admit the key shown.
prereq: pending-party-key-rotations-listed
architecture: docs/architecture.md#removing-a-machine
files: packages/reference-app-rn/src/machines-section.tsx (`useWaitingRotations`, `WaitingRotations`, `WaitingRotationRow`), packages/reference-app-rn/src/machines.ts (`WAITING_ROTATIONS_TITLE`, `waitingRotationLine`), packages/reference-app-rn/src/machine-removal.tsx (`unfinishedWorkspaces`), packages/reference-app-rn/src/share-code.tsx (`CopyBtn`), packages/reference-app-rn/src/use-cadre.ts, packages/reference-app-rn/src/cadre-phone.ts, packages/reference-app-rn/src/test-ids.ts, packages/reference-app-web/src/Machines.svelte, packages/reference-app-web/src/lib/machines.svelte.ts (`refreshWaitingRotations`, `waitingRotationLine`, `unfinishedWorkspaces`), packages/reference-app-web/src/lib/store.svelte.ts, packages/reference-app-web/README.md, docs/reference-app-rn.md
----
# The reference apps show the key replacements still waiting

Both apps list `CadreNode.listPendingPartyKeyRotations()` in the Devices and nodes card, in a **"Key replacements waiting"** block below the machines and invited devices. The block appears only when the list is non-empty, with one line per workspace, by id:

- `another-party`: "‹id›: ask this workspace's host for a fresh invitation and join with it from this device; or have the host admit key ‹public key›." The key is shown in full and can be copied: `Copyable` in the browser; selectable text plus a `CopyBtn` on the phone.
- `owner-machine`: "‹id›: finishes on an owner device that runs it."
- `sealed`: "‹id›: this workspace is sealed, so nobody can admit a new key; the removed device stays a member until the workspace is re-created."

The browser says "this tab" for "this device". A device or tab whose standing is not `owner` reads "from an owner device". The removal confirmation's `another-party` line reads "‹id›: needs the other party's manager: ask the host for a fresh invitation, or have them admit the key shown under Key replacements waiting".

The list is read with the machines list and when the node raises `strand:party-key-rotation-blocked` or `strand:party-key-rotated`. A failed read logs and keeps the last list. Only the latest read begun may write the list.

The implementation is in `ticket(implement): reference-apps-show-pending-party-key-rotations`.

## Review findings

**Validation, after the review's edits.** All exit 0 or pass: `yarn lint`; `yarn workspace @serfab/reference-app-rn typecheck`; `yarn workspace @serfab/reference-app-web check:svelte` (0 errors, 0 warnings) and `typecheck`; web tests 4 files, 11 passed; phone tests 20 files, 180 passed. `vite build` was not re-run: the review changed only comments and docs, and the implement pass's build passed.

**Seen in the browser.** The handoff's gap on the browser side is closed. I ran the web app under `vite` with a real running node and wrote one row of each state into `machinesState().waitingRotations` from the page's console:

- The block renders correctly at full width, including the inline `Copyable` followed by a period.
- There is no overflow with the card narrowed to phone width (328px).
- Setting the standing to `member` changes the line to "from an owner device".
- A real `refreshWaitingRotations` against the running node returned no rows and removed the block.

**Not seen.** The phone screen has not been rendered, and no screen has shown a row produced by a real second party's strand. The rows above were injected. `scenario-party-key-rotation-across-parties` is the real-network proof of the listing and does not cover these screens.

**Filed.**

- `bug-waiting-key-replacement-sends-a-later-admitted-owner-to-join` (backlog, `repro: static`). An owner device admitted after the removal is told to join from itself, but it cannot read the pending key. The invitation's token is spent, the membership invitation stays staged in that machine's memory, and the replacement stays stuck with the same line on screen. The fix starts in cadre-core's listing, so it did not belong in this pass.

**Fixed in this pass (minor).**

- `packages/reference-app-web/src/lib/machines.svelte.ts`: re-wrapped an overlong header comment line.
- `packages/reference-app-web/README.md`: split the "Key replacements waiting" bullet, which carried three topics, into a bullet with two labelled sub-paragraphs (the repo's one-claim-per-item rule), and reflowed the broken line in "The confirmation".

**Tripwire parked.** A key seated while its swap is deferred (this machine is alone) raises no event, so the line keeps asking for an invitation until the next read. Recorded as a `NOTE:` on `useWaitingRotations` and `refreshWaitingRotations`.

**The implementer's questions.**

- **Confirmation wording on a sealed workspace:** it is misleading there, because it says to ask the host when no host can admit a key. I kept it. The plan cannot tell sealed from another-party, the ticket dictated the words, architecture.md already names the listing as the accurate word, and the accurate line appears as soon as the removal returns. The `NOTE:` on `unfinishedWorkspaces` in both apps stays.
- **The phone's stale-read guard (counter only):** the reasoning holds, and for a stronger reason than the handoff gave. `holdNoNode` leaves `connected` false during a join or a dissolve, so the section unmounts and cannot carry one party's list to another. A node replaced while the section stays mounted is the same party, and the refresh effect in that commit drops the older read.
- **A first read that fails shows nothing:** left as the ticket specified (log and keep the last list). Only the log says why.

**Checked, nothing found.**

- **Event order:** `strand:party-key-rotated` fires after the swap transaction removes the pending row, so the re-read does not see the finished row. `strand:party-key-rotation-blocked` fires with the row in place.
- **Join flows:** the phone's Join via Invite and the browser's Form strand both work for a strand already running here, through `claimTrackedStrand` and `adoptFormationMembershipInvite`. Neither button is gated on having no strand.
- **"An owner device" wording:** `ensureStrandPartyKey` requires an owner signer, so a member device joining would fail after the token is spent. The non-owner line is correct to send it elsewhere.
- **Rented-node removal on the phone:** `handleForget` calls `onRentalsChanged` even when forgetting the rental fails.
- **Browser cross-party state:** `resetMachinesCard` clears the list on a join or a removal, and the node comparison drops an in-flight read.
- **Resource cleanup:** the phone's listeners are removed in the effect cleanup. The browser's are subscribed once for the life of the edge node, like the others in `store.svelte.ts`.
- **`superseded` keys are not shown:** the ticket did not ask for them, and a seat under a superseded key in a strand the party does not manage needs the host to have admitted that key within a narrow window. No action.
- **Duplicated wording between the apps:** already covered by the hand-kept-copies `NOTE:` in `machines.svelte.ts`, so not re-filed.
- **Docs:** `docs/reference-app-rn.md` and the web README match the behaviour. `docs/architecture.md` and `docs/strands.md` already describe the listing and needed no change. No other doc or test carries the old confirmation or copy-failure wording.

**Tests.** None added and none cut. The ticket decided on no tests because the wording is copy and the projection is one mapping per state, and this review found no defect in these apps that a test here would reproduce: the filed bug's root is in cadre-core, and its ticket names the scenario that would confirm it.
