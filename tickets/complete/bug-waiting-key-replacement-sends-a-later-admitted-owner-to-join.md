description: After a device is removed, the apps' list of waiting key replacements now names the devices that can actually finish each one, so an owner device that joined the cadre later is no longer told to spend the host's fresh invitation it cannot use.
architecture: docs/architecture.md#removing-a-machine
files: packages/cadre-core/src/types.ts (`PendingPartyKeyRotation.sealedTo`), packages/cadre-core/src/cadre-node.ts (`listPendingPartyKeyRotations`, `presentMachinePeerIds`, `pendingKeyRecipientsPresent`, `pendingPartyKeyRecipients` NOTE), packages/cadre-core/test/cadre-node-remove-machine.spec.ts, packages/reference-app-rn/src/machines.ts, packages/reference-app-rn/src/machines-section.tsx, packages/reference-app-web/src/lib/machines.svelte.ts, packages/reference-app-web/src/Machines.svelte, docs/architecture.md, docs/reference-app-rn.md, packages/reference-app-web/README.md
repro: static
----
# The waiting key replacement list names the devices that can finish it

## What landed

`PendingPartyKeyRotation` now has `sealedTo: string[]`. It holds the control peer ids the pending key's envelope is sealed to (`partyKeyRecipients(row.sealedKey)`), keeping only those that are still a live `CadrePeer` row or are this node. `listPendingPartyKeyRotations` reads the live peer set once per call. An envelope that does not decode lists `sealedTo: []` and logs the error; the rest of the listing still comes back.

Both reference apps (RN `machines.ts`, web `machines.svelte.ts`) resolve `sealedTo` against their machine list:

- An `another-party` line sends the host's invitation to "this device" only when this device is an owner and a recipient. Otherwise it reads "an owner device among ‹named recipients›". An owner device that is not a recipient also gets "(this device cannot: it joined after the removal)".
- An `owner-machine` line names the recipients.
- When `sealedTo` is empty, the line says no device can finish the replacement and does not offer the key (`waitingRotationOffersKey`). That is because the replacement driver must open the new key even after a seat is admitted by hand.
- When the machine list has no row for this device yet, whether it is a recipient is treated as unknown.

Docs updated: architecture.md "What the app lists afterwards" and its Proof paragraph, reference-app-rn.md "Key replacements waiting", and the web README.

The core half of the reproduction is in `cadre-node-remove-machine.spec.ts`. A machine is admitted after the first removal. The test asserts it is absent from `sealedTo`, and that it is the recipient alongside this node after the second removal.

Landed in `ticket(implement): bug-waiting-key-replacement-sends-a-later-admitted-owner-to-join`.

## Review findings

Read the implement diff first, then the handoff. Then read `listMachines` / `readMachines` / `describeMachines` (`machine-removal.ts`), `pendingPartyKeyRecipients`, `partyKeyRecipients` (`sealed-party-key.ts`), docs/strands.md "the host's re-invitation" and "the old key when the party cannot leave", and the RN doc section.

**Correctness, checked; no defect found.**
- `presentMachinePeerIds` reads the same `queryCadrePeers` rows that `listMachines` maps one-to-one. So every id in `sealedTo` other than this node resolves to a listed machine whenever the app's two reads agree.
- Self is added to the present set using `this.peerId`, which is `controlNode.peerId`: the same id the envelope is sealed under (`selfPartyKeyIdentity`).
- On an ephemeral identity (tests only), self is never in the envelope, so it is correctly left out of `sealedTo`.
- The machine list has no `isSelf` row until this node's `CadrePeer` row lands. The apps read that as "unknown" (`self: null`) and do not claim that this device cannot.
- The ticket says a seat admitted by hand with no recipient left does not finish. I confirmed this against `strand-party-key-rotation.ts` and docs/strands.md (a machine that cannot read the pending key leaves a staged invitation alone). So not offering the key on an empty `sealedTo` is right.

**Implementer's known gaps, weighed:**
- *Untrusted rows counted as present.* No change made. Only machines that were trusted or self when the key was sealed are recipients (`pendingPartyKeyRecipients`), so an untrusted row is named only if it was trusted at removal time. That has no realistic user-visible effect, so no ticket or tripwire.
- *"(this device cannot: it joined after the removal)" when the real reason is something else.* The other reasons are a machine untrusted at removal, or an ephemeral identity, which is tests only. The wording is accurate for the case a user meets, so it is kept.
- *Advice on an empty `sealedTo` after the docs/strands.md recovery path.* The combination is very unlikely, and the advice is still harmless there. No action.

**Duplication between the two apps:** the line builders and `machineNoun` are hand-kept copies in RN and web. This is already covered by the existing `NOTE` in `machines.svelte.ts` about moving them into cadre-core, so it was not re-filed.

**Tests:** the added assertions are the core reproduction of the bug (they fail without `sealedTo`) and pin the "admitted later is not a recipient" contract, so they are kept. No app-side test was added: the line builders have no test harness, the wording is pinned in docs, and the branching is shallow. Nothing cut.

**Docs:** architecture.md, reference-app-rn.md and the web README match the code. docs/strands.md needed no change, since its re-invitation and lost-recipient paragraphs already describe the core behavior these lines report. The removed `NOTE` on `listPendingPartyKeyRotations` (the old tripwire this ticket resolves) has nothing left referring to it.

**Performance / resource cleanup:** each listing does one extra `queryCadrePeers` and decodes each pending row's envelope. That is negligible next to the per-strand reads already in the loop, and there is nothing to release. No action.

**Validation run in review:** `yarn workspace @serfab/cadre-core test cadre-node-remove-machine` (10 passed); `yarn workspace @serfab/reference-app-rn typecheck`, `yarn workspace @serfab/reference-app-web typecheck` and `yarn lint` all exit 0. I did not re-run the full cadre-core suite, which the implementer ran green (2629 passed), because review changed no code. The integration scenarios and a rendered app were not run (real network and device); the line text was checked by reading the code.

**Changes made in review:** none.
