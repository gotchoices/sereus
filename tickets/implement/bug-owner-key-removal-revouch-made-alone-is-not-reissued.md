description: When an owner removes an owner key while their device has no connection to the rest of the cadre, a device they chose to keep can be dropped by every other machine after reconnecting. The removal should be refused until the device is connected, as it already is when the owner keeps another owner key.
architecture: docs/architecture.md#removing-an-owner-key
files: packages/cadre-core/src/cadre-node.ts (removeOwner, revouchDependents, controlWriteCouldFork doc comment), packages/cadre-core/src/owner-keys.ts (OWNER_KEY_REMOVAL_REFUSAL_REASON), packages/cadre-core/src/types.ts (OwnerKeyRemovalRefusal), packages/cadre-core/test/cadre-node-remove-machine.spec.ts, packages/cadre-core/test/cadre-node-owner-signer.spec.ts, packages/reference-app-rn/src/owner-keys.ts, packages/reference-app-web/src/lib/owner-keys.svelte.ts, docs/architecture.md, docs/reference-app-rn.md
repro: verified
difficulty: easy
----

# Refuse `removeOwner` while alone when it would re-vouch any row

## What was found

`CadreNode.removeOwner(key, { revouch: { peers } })` rewrites each kept `CadrePeer` row's voucher (`VouchOwner`, `VouchSig`) to the remover's key, then removes the `OwnerKey` row. When the remover is alone (no sibling reachable, while the party has other members) the rewrite commits on that machine only.

A temporary integration scenario reproduced the loss, and was deleted afterwards. Setup: owner A and pinning member M; a second owner key K that A added; a device row C vouched by K and carrying its own `Sig`. A was cut off with `peerDialGate({ inbound: true })` and `hangUp`, called `removeOwner(K, { revouch: { peers: [C] } })`, then reconnected through `reconcileControlCohort`. Results on M:

| While A was cut off | K's tombstone reached M | C's voucher on M | C authorized on M |
| --- | --- | --- | --- |
| Nobody else wrote `CadrePeer` | yes | A's key | yes |
| M called `registerSelf()` during the cut | yes | still K | **no, within about 1 s of M's anchor dropping K, and still no after 45 s** |

The second row is the bug. The first row shows the original ticket's claim was too broad: the new voucher does arrive when no other member touched the collection (the path it took was not traced). In a running party, members re-publish their own `CadrePeer` rows, so another member advancing the collection during the cut is an expected case. That was simulated here by one `registerSelf()`; a three-machine party was not run.

## Cause and why re-issuing does not fix it

The re-vouch and the other member's write take the `CadrePeer` collection to the same revision with different content. This is the fork described in docs/architecture.md → "Writes made while alone" and `tickets/blocked/forked-control-collection-sync-livelocks.md`, and no re-issue heals it. Queueing the re-vouch for the growth drain would therefore not solve the case above, and `controlWriteCouldFork` is already the check for a write that can fork the party.

The tombstone lives in the separate `Revocation` collection and is unaffected. That is why it arrives without the voucher.

## The fix

In `removeOwner`, extend the existing refusal from `revouch.owners.length > 0` to any re-vouch, using the `OwnerKeyDependents` that `revouchWithinPlan` returns:

```ts
if ((revouch.owners.length > 0 || revouch.peers.length > 0) && await this.controlWriteCouldFork()) {
  throw new OwnerKeyRemovalRefusedError(key, 'alone');
}
```

`revouch.peers` already includes the remover's own row when the plan says `revouchesOwnRow`, so that case is covered with no further branch. The own-row case was not run in the reproduction; it is the same write to the same collection, so the same reasoning applies.

Behaviour that does not change:

- A removal with nothing to re-vouch still commits alone. Its tombstone is re-issued on cohort growth, and the user chose to let the dependents go.
- A party with no other members is not refused, since `controlWriteCouldFork` is false there.
- Callers already handle `alone` by showing the refusal line (`REMOVAL_REFUSAL_LINE`) and letting the user retry once connected.

A connection that drops while the user approves is not closed by this check, because the check runs before the approval. Log it, as `addOwner` and the owner re-vouch do. `addOwner`'s `NOTE` already records when to revisit that window.

## Test setup

Both unit specs below run one node with no connections and an authorized sibling, so their successful re-vouch now reads as alone. Mark a member as reachable through the seam `cadre-node-control-replication.spec.ts` and `cadre-node-control-cohort.spec.ts` already use: `(node as unknown as { identifiedControlPeers: Set<string> }).identifiedControlPeers.add(id)`. Remove the id again afterwards where later cases in the file depend on being alone.

No new integration scenario is needed. The refusal happens before any write and the unit spec pins it. The kept-device path over a live connection is already covered by the `machine-removal` scenario.

## TODO

- `packages/cadre-core/src/cadre-node.ts`: widen the refusal in `removeOwner` as above.
- `cadre-node.ts`: update the `removeOwner` doc comment (the "Steps" sentence on refusing `alone`) and the `controlWriteCouldFork` doc comment (which names only `removeOwner`'s owner re-vouch by its no-re-issue reason; a peer row's reason is the fork).
- `cadre-node.ts` `revouchDependents`: delete the `NOTE` naming this ticket, correct the doc comment's "An owner re-vouch is refused alone before this runs", and log a peer re-vouch that committed alone the same way the owner loop does.
- `packages/cadre-core/src/owner-keys.ts`: reword `OWNER_KEY_REMOVAL_REFUSAL_REASON.alone` to cover devices as well as owner keys.
- `packages/cadre-core/src/types.ts`: reword the `'alone'` member of `OwnerKeyRemovalRefusal` the same way.
- `packages/reference-app-rn/src/owner-keys.ts` and `packages/reference-app-web/src/lib/owner-keys.svelte.ts`: change the `alone` line in `REMOVAL_REFUSAL_LINE` so it no longer names only owner keys, for example "Connect to your cadre first; the devices and owner keys you keep would not reach your other machines."
- `docs/reference-app-rn.md` → "Removing an owner key": match the new line, and "Keeping an owner key while alone" becomes keeping anything while alone. Include this device's own row, which is re-vouched without asking.
- `docs/architecture.md`:
  - "Removing an owner key" → Refusals: `alone` applies to any re-vouch, the remover's own row included. State the two reasons: an `OwnerKey` re-add has no re-issue path, and a `CadrePeer` re-vouch can fork the collection, which leaves other machines holding the tombstone without the new voucher.
  - "Removing an owner key" → Concurrent removals: delete the last sentence, which names this ticket.
  - "Removing an owner key" → Proof: update the description of `cadre-node-remove-machine.spec.ts`.
  - "Writes made while alone": update the last sentence of the `OwnerKey` paragraph.
  - Name this ticket's slug and nothing more about the history.
- `packages/cadre-core/test/cadre-node-remove-machine.spec.ts` (test at line 184): assert that a peer re-vouch while alone is refused `alone` before any write, and that a call with no `revouch` is refused too when `revouchesOwnRow` is true. Then mark a member reachable for the successful call at line 221, and update the test title and the comment at line 213.
- `packages/cadre-core/test/cadre-node-owner-signer.spec.ts` (line 159): mark a member reachable before the call, and adjust the comment at line 150 if it no longer reads correctly.
- Run `yarn workspace @serfab/cadre-core test` for those two specs, the `machine-removal`, `owner-grant-backup-recovery` and `owner-anchor-follows-owner-changes` integration scenarios (each calls `removeOwner` and must not read as alone), the reference-app test suites, and `yarn lint`.
