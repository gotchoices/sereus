description: After removing a device, the reference apps say which private workspaces still need another party's manager, but then forget about it. Show the waiting key replacements on the devices page until they finish, and tell the owner what to do: ask the workspace's host for a fresh invitation and join with it, or have the host admit the shown key.
prereq: pending-party-key-rotations-listed
architecture: docs/architecture.md#removing-a-machine
files: packages/reference-app-rn/src/machines-section.tsx, packages/reference-app-rn/src/machines.ts, packages/reference-app-rn/src/machine-removal.tsx (`unfinishedWorkspaces` ~182), packages/reference-app-web/src/Machines.svelte, packages/reference-app-web/src/lib/machines.svelte.ts (`refreshMachines`, `unfinishedWorkspaces`), packages/reference-app-web/README.md, docs/reference-app-rn.md
difficulty: medium
----
# The reference apps show the key replacements still waiting

Both apps already put the removal's per-workspace outcome in the confirmation (`scenario-machine-removal-rotates-party-key`): "‹id›: needs the other party's manager" or "‹id›: finishes on an owner device that runs it". Once the confirmation closes, nothing shows that a replacement is still waiting, and the owner is not told how to finish one. `CadreNode.listPendingPartyKeyRotations()` (`pending-party-key-rotations-listed`) is the read; this ticket is the two apps' use of it, with the same list, wording and placement in both, as the machines card already keeps the phone and the browser in step.

## What each app shows

A **"Key replacements waiting"** block under the Devices and nodes card (the phone's `machines-section.tsx`, the browser's `Machines.svelte`), present only when the listing is non-empty, one entry per strand, by id (the apps have no workspace names; `Home.svelte` shows the raw id already):

- `another-party`: "‹id›: ask this workspace's host for a fresh invitation and join with it from this device; or have the host admit key ‹public key›." The public key is shown in full and copyable (the browser has `Copyable.svelte`; the phone has the share-code pattern).
- `owner-machine`: "‹id›: finishes on an owner device that runs it."
- `sealed`: "‹id›: this workspace is sealed, so nobody can admit a new key; the removed device stays a member until the workspace is re-created."

The removal confirmation's `another-party` line (`unfinishedWorkspaces` in both apps) gains the same "how": "needs the other party's manager: ask the host for a fresh invitation, or have them admit the key shown under Key replacements waiting".

**Refresh.** Read with the machines list (`refreshMachines` in the browser, the phone's machines hook), after a removal, and on `strand:party-key-rotation-blocked` and `strand:party-key-rotated`. A read that fails logs and keeps the last list, as the machines read does.

**Joining with the host's invitation** is the apps' existing join flow (`Form strand` on the browser's Home page; the phone's join section): nothing new to build, only a sentence in each app's doc saying that this is how a waiting replacement in another party's workspace is finished.

## Edge cases & interactions

- **The node is not an owner**: the list still shows (any machine of the party holds the rows), without the "from this device" wording; joining takes an owner device. By inspection.
- **A second phone of the party** sees the list on its next refresh; no push is wired (decided in `pending-party-key-rotations-listed`).
- **The list and the removal confirmation on screen together**: the confirmation's lines come from the plan, the list from the rows; they agree once the removal returns. By inspection.
- **An empty listing after a failed read** must not hide a waiting replacement: keep the last list on failure.

## Tests

None. The wording is copy and the projection is one mapping per state; the web `check:svelte` and `vite build`, and the phone `typecheck`, are the gates. The web unit tests run if the sibling builds allow.

## Docs

- `docs/reference-app-rn.md`: the block, its three lines, and how a waiting replacement is finished.
- `packages/reference-app-web/README.md`: the same for the browser.

## TODO

- The listing state and refresh in both apps.
- The block, the three lines, the copyable key.
- The confirmation line's "how".
- Docs.
- `yarn workspace @serfab/reference-app-rn typecheck`, `yarn workspace @serfab/reference-app-web check:svelte` and `vite build`, `yarn lint`.
