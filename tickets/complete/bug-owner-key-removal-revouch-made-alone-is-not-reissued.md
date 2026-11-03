description: When an owner removes an owner key while their device has no connection to the rest of the cadre, a device they chose to keep could be dropped by every other machine after reconnecting. The removal is now refused until the device is connected, as it already was when the owner kept another owner key.
architecture: docs/architecture.md#removing-an-owner-key
files: packages/cadre-core/src/cadre-node.ts (removeOwner, revouchDependents, controlWriteCouldFork doc comment), packages/cadre-core/src/owner-keys.ts, packages/cadre-core/src/types.ts, packages/cadre-core/test/cadre-node-remove-machine.spec.ts, packages/cadre-core/test/cadre-node-owner-signer.spec.ts, packages/reference-app-rn/src/owner-keys.ts, packages/reference-app-web/src/lib/owner-keys.svelte.ts, packages/reference-app-web/README.md, docs/architecture.md, docs/reference-app-rn.md
repro: verified
difficulty: easy
----

# Complete: `removeOwner` is refused while alone when it would re-vouch any row

## What shipped

`CadreNode.removeOwner` throws `OwnerKeyRemovalRefusedError` with code `alone` when any row is to be re-vouched (`revouch.owners` or `revouch.peers`, which includes this node's own row when the plan says `revouchesOwnRow`) and `controlWriteCouldFork()` is true. The check runs before the owner's approval and before any write.

The reason: a `CadrePeer` re-vouch committed alone takes the collection to the same revision as another member's write made meanwhile, with different content. No re-issue heals that fork. The removal's tombstone is in the separate `Revocation` collection and still arrives, so the other machines drop the kept row.

A removal with nothing to re-vouch still commits alone, and its tombstone is re-issued on cohort growth. A re-vouch that loses its last connection during the call is logged, for machine rows as for owner rows.

## Review findings

Read the diff of `ticket(implement): bug-owner-key-removal-revouch-made-alone-is-not-reissued` first, then the surrounding `removeOwner`, `revouchDependents`, `controlWriteCouldFork`, `authorizedAmong`, `removeMachine`, the first-growth sweep, both apps' removal flows, and the docs.

**Correctness.** No defect in the check. It sits after the plan and stray-row checks and before the approval, and the predicate waits for the in-flight membership refresh. `authorizedAmong` excludes this node, so "other members" means what the docs say.

**Fixed: dead-end message on the lost-phone path.** This change newly refuses the case the docs name as the reason for the own-row re-vouch: a device admitted by a lost phone's invitation, removing that phone's key. When the phone is the only other machine, "Connect to your cadre first" cannot be followed. The documented order (remove the machine, then the key) does work, because no other member is then left. Done in this pass:
- Both apps' `REMOVAL_REFUSAL_LINE.alone` now also say to remove a lost only other machine under Devices and nodes.
- `docs/architecture.md` and `docs/reference-app-rn.md` state this.
- `cadre-node-remove-machine.spec.ts` gained a case for it, since nothing verified this contract: all other members removed, then a removal that re-vouches the own row commits alone.

**Fixed: docs and comments.**
- `packages/reference-app-web/README.md` did not mention the `alone` refusal, so it now does.
- Repaired a broken line wrap in the `removeOwner` doc comment.

**Parked as a tripwire: stale plan error.** The implementer asked whether this needs a ticket. It does not. A row that moves off the key between the plan and the call (another owner's re-vouch, or the first-growth sweep once the node reconnects) gets the plain "re-vouch names rows..." error. Nothing is written, and both apps re-read the plan on the next Remove, so one retry clears it. This was seen only by forcing the drain in a spec. Recorded as a `NOTE:` in `revouchWithinPlan` (`owner-keys.ts`).

**Declined: test helper for the reachability seam.** The two specs each set `identifiedControlPeers` and `controlSiblingReachable` through a cast, with a comment saying why. Two cohort specs already cast into the first field. A helper for two short call sites adds nothing, so I left them. No test was cut: the three `alone` calls, the unchanged rows and the alone commit each pin a different branch.

**Window left open by design.** A connection that drops during the approval still commits alone and is logged. `addOwner`'s `NOTE` records the same limit, so no new action.

**Other angles, nothing found.**
- Type safety and error handling: `alone` stays out of the plan's `refusal` type because it is decided at call time.
- Resource cleanup and performance: the check adds one membership wait to a user-initiated call, and only when something is to be re-vouched.
- Other callers: the edge node passes through, and no CLI or host calls `removeOwner`.
- Leftovers: the removed slug survives only in `docs/architecture.md` as the ticket reference, plus a stale generated bundle under `packages/reference-app-ns/platforms`.

**Not run over a real network.** The own-row refusal and a three-machine party. The refusal happens before any write, so the unit spec covers it.

## Validation

Run on the final code, after rebuilding `@serfab/cadre-core`:
- `cadre-node-remove-machine`, `cadre-node-owner-signer` and `cadre-node-add-owner` specs
- `machine-removal` integration scenario
- reference-app-rn (180 tests) and reference-app-web (11 tests)
- `yarn lint` and `tsc --noEmit` for cadre-core

The implement pass ran `owner-grant-backup-recovery` and `owner-anchor-follows-owner-changes`. They were not repeated, since this pass changed only comments, strings and a test. The whole `@serfab/cadre-core` suite was not run; no other spec calls `CadreNode.removeOwner`.

`../optimystic` still has uncommitted edits in `db-core` and `db-p2p`, so these runs are against its in-progress work. Nothing was built or changed in that repo.
