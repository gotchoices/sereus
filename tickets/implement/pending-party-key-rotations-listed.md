description: A membership key replacement that waits on another party, or on an owner device that is not running, leaves a pending record behind that no app can read today. Give apps a listing of these waiting replacements, saying for each private workspace who can move it forward and which key to name.
prereq: party-key-rotation-redeems-an-invitation-under-the-pending-key
architecture: docs/architecture.md#removing-a-machine
files: packages/cadre-core/src/control-database.ts (`queryPendingStrandPartyKey` ~2311, `PENDING_PARTY_KEY_SELECT`), packages/cadre-core/src/cadre-node.ts (`readClosedStrandStates` ~10015, `closedStrandState`, `planMachineRemoval`), packages/cadre-core/src/machine-removal.ts (`ClosedStrandState`, `rotationSite`), packages/cadre-core/src/types.ts (`MachineRemovalPlan`, `StrandKeyRotationPlan`), packages/cadre-core/src/strand-membership-writer.ts (`isStrandSealed`, `isStrandMember`), packages/cadre-core/src/index.ts, packages/cadre-core/test/cadre-node-remove-machine.spec.ts (where `planMachineRemoval` and the per-strand rotation site are pinned), docs/architecture.md (Removing a machine, "What the app is told"), docs/strands.md (Replacing the party's key)
difficulty: medium
----
# Listing the party key replacements still pending

A `PendingStrandPartyKey` row outlives the `removeMachine` call that wrote it whenever the replacement cannot finish on the removing machine: the strand is managed by another party (`needs-another-party`), runs only on an owner machine that is offline (`later`/`pending`), or the control swap was deferred while alone. `MachineRemovalResult.strands` reports that once, to the caller, and nothing afterwards. The plan ticket settled that the app lists each pending row under its strand until the swap. This ticket is the read behind that list.

## The API

```ts
/** One closed strand whose membership key replacement has not finished (docs/architecture.md → "Removing a machine"). */
export interface PendingPartyKeyRotation {
  strandId: string;
  /** The key the party is moving to, public half (base64url): what another party's manager admits by hand. */
  publicKey: string;
  /** Earlier pending keys this one replaced, public halves. A seat one of them holds in a strand the party does not manage is for that strand's manager to revoke. */
  superseded: string[];
  /**
   * Who can move the replacement forward from here.
   * - `another-party`: the strand runs here and the party holds no manager seat, so another party's manager has to admit `publicKey`: a fresh invitation to the strand redeemed on an owner device of this party, or the key admitted by hand.
   * - `sealed`: the strand has no managers at all; nobody can admit the key, and the removed machine stays a member until the strand is re-formed.
   * - `owner-machine`: an owner device of this party that runs the strand finishes it (the strand does not run here, this machine holds no owner key, or the new key is already seated and the swap is next).
   */
  waitingOn: 'another-party' | 'sealed' | 'owner-machine';
}

CadreNode.listPendingPartyKeyRotations(): Promise<PendingPartyKeyRotation[]>
```

- **Which rows.** Every live `PendingStrandPartyKey` row (retired stamps hidden, as `queryPendingStrandPartyKey` hides them) whose strand the party still holds: a `Strand` row or a `JoinedStrand` row. A pending row for a strand the party has left stays in the table, by the design the complete ticket documents (a re-formation finishes it), and is not listed; the listing is "what is waiting", not "what the table holds". Add `ControlDatabase.queryPendingStrandPartyKeys()` returning every live row keyed by strand id, beside the single-row read, sharing `pendingPartyKeyOfRow` and the revoked-stamp filter.
- **`waitingOn`** is a pure projection in `machine-removal.ts` next to `rotationSite`, over an input read by `CadreNode`: the strand's runtime here (`ClosedStrandState.runtime`), the party's manager seat, whether the strand is sealed (`isStrandSealed`), and whether `publicKey` is already a `Strand.Member` (`isStrandMember`); each strand read is `'unknown'` when there is no live database. `sealed` wins over `another-party`; `another-party` needs a live database, no manager seat and the new key not yet a member; everything else is `owner-machine`. Reuse `closedStrandState` for the first two reads rather than a second reader, extending its input if that is cleaner than a parallel read.
- **No new event.** The party key tables already have a watch, and the apps refresh the listing on `strand:party-key-rotation-blocked`, `strand:party-key-rotated` and after their own `removeMachine`; a second phone of the party that learns of the pending row by replication sees it on its next screen open. If an app ever needs a push, emit from `onPartyKeyTablesChanged`.
- **Withdrawal.** There is none, by decision: the row is the durable intent, it goes with the strand when the strand leaves the party (`unpublishStrand` takes it; a joined strand that is left keeps it for a re-formation), and the only thing that ends it is the swap. Say so in the docs.

## Edge cases & interactions

- **A row sealed to other machines** still lists here (the listing reads public columns only), with `waitingOn` computed from this machine's view; `owner-machine` when the strand does not run here. By inspection.
- **The new key seated but not swapped** (the by-hand admission landed, the owner machine's driver has not run): `owner-machine`, not `another-party`, so the app stops asking the host. Pinned by the projection test.
- **A strand not running here** with no database: `owner-machine` whatever the seat, as `rotationSite` answers `later`. Pinned by the projection test.
- **Hibernating strand**: no live database, so `owner-machine`; a removal wakes it, this listing does not. By inspection.
- **A removed node** (`removedFromCadre()` set) holds pending rows it cannot act on: return the empty list, as the drivers refuse there. By inspection.
- **The control database is gone** (node stopped): throw, as other listings do.

## Tests

One table test on the pure `waitingOn` projection, in `cadre-node-remove-machine.spec.ts` beside the plan's rotation-site cases: sealed with no seat; live, no seat, key not a member; live, no seat, key a member; live with a seat; no runtime. One expectation per row. Nothing on `listPendingPartyKeyRotations` itself: the reads are wiring, and `scenario-party-key-rotation-across-parties` asserts the listing on a real network before and after the re-invitation.

## Docs

- `docs/architecture.md` "What the app is told": the listing, its three states and the no-withdrawal decision.
- `docs/strands.md` "Replacing the party's key": one sentence pointing at the listing from the cross-party bullet.

## TODO

- `ControlDatabase.queryPendingStrandPartyKeys()`.
- `PendingPartyKeyRotation` in `types.ts`, exported from `index.ts`; the pure projection in `machine-removal.ts`; `CadreNode.listPendingPartyKeyRotations()`.
- The projection test.
- Docs.
- `yarn workspace @serfab/cadre-core typecheck`, `yarn lint`, the touched specs, then `yarn workspace @serfab/cadre-core test`.
