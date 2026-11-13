description: After a device is removed, the apps' list of waiting key replacements now names the devices that can actually finish each one, so an owner device that joined the cadre later is no longer told to spend the host's fresh invitation it cannot use.
architecture: docs/architecture.md#removing-a-machine
files: packages/cadre-core/src/types.ts (`PendingPartyKeyRotation.sealedTo`), packages/cadre-core/src/cadre-node.ts (`listPendingPartyKeyRotations`, `presentMachinePeerIds`, `pendingKeyRecipientsPresent`, `pendingPartyKeyRecipients` NOTE), packages/cadre-core/test/cadre-node-remove-machine.spec.ts, packages/reference-app-rn/src/machines.ts (`waitingRotationLine`, `waitingRotationOffersKey`, `machineNoun`), packages/reference-app-rn/src/machines-section.tsx (`WaitingRotations`, `WaitingRotationRow`), packages/reference-app-web/src/lib/machines.svelte.ts (same functions), packages/reference-app-web/src/Machines.svelte, docs/architecture.md, docs/reference-app-rn.md, packages/reference-app-web/README.md
repro: static
----
# The waiting key replacement list names the devices that can finish it

## What changed

**Core.** `PendingPartyKeyRotation` gains `sealedTo: string[]`: the control peer ids the pending key's envelope is sealed to (`partyKeyRecipients(row.sealedKey)`), kept only when the peer is still a live `CadrePeer` row or is this node. `listPendingPartyKeyRotations` reads the live peer set once per call (`presentMachinePeerIds`, which uses `queryCadrePeers` directly: the same rows `listMachines` lists, without the trust-chain read). An envelope that does not decode lists `sealedTo: []` with a log rather than failing the whole listing. `waitingOn` is unchanged. The old NOTE on `listPendingPartyKeyRotations` ("`waitingOn` does not look at who the key is sealed to…") is gone; the method doc now says a lost-but-not-removed recipient stays in `sealedTo` and removing it writes a fresh replacement. The `pendingPartyKeyRecipients` NOTE now points at `sealedTo`.

**Apps** (RN `machines.ts`, web `machines.svelte.ts`, same wording, "this device" vs "this tab"). `waitingRotationLine(rotation, owner, machines)` resolves `sealedTo` against the app's machine list. Whether this device is a recipient is read from the `isSelf` row. When the list has no self row (not read yet), it is treated as unknown, so the line never claims "this device cannot" on a guess. Other recipients are named "the app 1a2b3c4d", "the always-on node 5e6f7a8b": a new `machineNoun` helper, which `machineName` now builds on. I used lowercase rather than `machineName`'s sentence-initial "The" because the names sit mid-sentence; this is a small departure from the ticket's example text. Recipients missing from the list are skipped.

- `another-party`, owner and this device a recipient: unchanged ("…join with it from this device; or have the host admit key").
- `another-party` otherwise: "…join with it from an owner device among the app …, the always-on node …; or have the host admit key". An owner device that is not a recipient also gets "(this device cannot: it joined after the removal)". A non-owner device does not get it, and is never named, since it cannot join for the party.
- `owner-machine`: "…finishes on an owner device that runs it, among ‹names›." When this device is an owner recipient and others exist, "this device" is first in the names. The line stays plain when this device is the only recipient, or when no recipient resolves to a row.
- `sealedTo` empty (any `waitingOn` but `sealed`): "‹id›: none of the devices this key was sealed to is in this cadre any more, so none can finish it; removing a device from this cadre writes a fresh replacement sealed to the devices here." The key is not offered.
- `sealed`: unchanged.

`waitingRotationOffersKey(rotation)` (`another-party` and `sealedTo` non-empty) now decides the trailing key and Copy button in both callers.

**By-hand admission with no recipient left (checked).** It does not finish. `strand-party-key-rotation.ts` `prepare` calls `readPending`, which rejects when this machine cannot open the key (`openPendingPartyKey`), and the background triggers skip non-recipients (`isPendingPartyKeyRecipient`). So a seat admitted by hand still needs a recipient to bind, step down and swap. That is why the empty-`sealedTo` line does not offer the key.

**Docs.** architecture.md "What the app lists afterwards" names `sealedTo` and why, the `another-party` and `owner-machine` items say "sealed to (`sealedTo`)", and the Proof paragraph mentions the new assertion. docs/reference-app-rn.md "Key replacements waiting" has the new wording plus a new item for an empty `sealedTo`. The web README sub-paragraph says to join "on the tab or device the line says". The web README otherwise defers to the RN doc for wording.

## Test

The existing test is extended: `cadre-node-remove-machine.spec.ts` › "records the party key rotation of a closed strand not running here as pending, and a second removal replaces the pending key…". After the first removal, a third machine is admitted through a fresh one-use invitation. The test then asserts that the listing's `sealedTo` is exactly {this node, `second`}: not the removed `first`, and not the later-admitted `third`. After the second removal it asserts `sealedTo` is exactly {this node, `third`}. This is the core half of the bug's reproduction. Without the change the field is absent and the assertions fail.

No app-side test, as the ticket said: the line builders have no tests today, and the wording is pinned in the docs.

## Validation run

- `yarn workspace @serfab/cadre-core test cadre-node-remove-machine`: 10 passed.
- `yarn workspace @serfab/cadre-core test` (full): 197 files, 2629 passed, 1 skipped.
- `yarn workspace @serfab/cadre-core build` and `typecheck`; `yarn workspace @serfab/reference-app-rn typecheck`; `yarn workspace @serfab/reference-app-web typecheck` and `check:svelte` (0 errors); `yarn workspace @serfab/integration-tests typecheck` (covers `party-key-rotation-across-parties.integration.ts`, which uses `toMatchObject` and needed no edit); `yarn lint`: all clean.
- Not run: the integration scenarios (real network). No app was launched; the new lines were read, not seen rendered.

## Known gaps for the reviewer

- `sealedTo` counts every live `CadrePeer` row, trusted or not, as the ticket specified. An untrusted row would be named in the app as a device that could finish the replacement. That is unlikely to matter, since recipients were trusted when the key was sealed.
- The "(this device cannot: it joined after the removal)" reason is the common case but not the only one. A machine untrusted at removal time, or on an ephemeral identity, is also not a recipient. The text says "joined after the removal" for all of them.
- Advice on the empty-`sealedTo` line: "removing a device writes a fresh replacement" only holds while the party still holds a `StrandPartyKey` row for the strand (`readClosedStrandStates`). The docs/strands.md recovery path deletes that row, so in that path the advice would not apply. That path and an empty `sealedTo` together are very unlikely, so I left it.
- The two app copies stay hand-kept duplicates. The existing NOTE in `machines.svelte.ts` covers moving them into cadre-core.
