/**
 * A party's machines as one closed strand sees them: which strand peer ids belong to the
 * party's live machines and which to machines removed from the cadre, projected from the
 * control database. The inputs are the strand's `CadreControl.StrandPeer` rows (each
 * machine's own signed statement of its peer id in the strand), the live `CadrePeer` rows
 * judged by this node's membership predicate, and the `CadrePeer` tombstones.
 *
 * The closed-strand membership reconciler (`strand-membership-reconciler.ts`) binds every
 * live sibling under the party's current member key and clears a removed machine's binding,
 * so a sibling that was offline when the party's key changed is already bound when it
 * returns, and a machine wrongly bound under a key is cleared. Who binds whom is stated in
 * `docs/strands.md` → Closed-Strand Member Key Handling.
 */

import type { CadreMachine, RevocationRow, StrandPeerRow } from './types.js';

/** The party's machines' peer ids in one strand, as {@link partitionPartyStrandPeers} sorts them. */
export interface PartyStrandPeers {
  /**
   * Strand peer ids of the party's live machines other than this one: each has a `StrandPeer`
   * row and a live `CadrePeer` row that passes the membership predicate (`CadreMachine.trusted`,
   * which is false for this node itself).
   */
  live: readonly string[];
  /**
   * Strand peer ids of machines removed from the cadre: each has a `StrandPeer` row, a
   * `CadrePeer` tombstone naming its peer id, and no live `CadrePeer` row. Never an id that is
   * also in {@link live}: a removed machine can state any id as its own (nothing but the
   * machine itself can derive its id, so nothing checks the statement), and a removed machine's
   * row must never clear a live machine's binding.
   */
  removed: readonly string[];
}

/**
 * The control-database seam of the membership reconciler's sibling work, scoped to one strand
 * as `PendingMembershipInviteSource` is. `CadreNode` builds one per closed-strand launch
 * (`StartStrandConfig.partyPeers`); the instance manager publishes through it at bring-up and
 * hands it to the reconciler, which reads through it once per pass.
 */
export interface PartyStrandPeerSource {
  /**
   * Record this machine's own peer id in the strand in the party's control database (its
   * `StrandPeer` row), signed by the machine's identity key. Insert-if-absent, and a no-op once
   * the row is known present. A write deferred while it could fork the party, or refused
   * because this machine's own `CadrePeer` row has not reached this node, is retried by the
   * control-sibling growth drain and by the next call. Never rejects.
   */
  publishOwn(strandPeerId: string): Promise<void>;
  /**
   * The party's machines' peer ids in this strand, read now. Rejects when the rows cannot be
   * read (on a party whose store was migrated to the `StrandPeer` table, a read can fail while
   * the other machines are offline: `ControlDatabase.queryStrandPeers`), and never answers
   * "no machines" for a failed read.
   */
  read(): Promise<PartyStrandPeers>;
  /**
   * Whether the party is moving to another member key in this strand (a
   * `PendingStrandPartyKey` row). Rejects when that cannot be read, which a caller treats as
   * "a rotation may be pending": while one is, a removed machine's binding under the current
   * key is the orphan the rotation is about to leave, and clearing it would hand the removed
   * machine a clean slate.
   */
  isRotationPending(): Promise<boolean>;
}

/**
 * Sort a strand's `StrandPeer` rows into the party's live siblings and its removed machines
 * ({@link PartyStrandPeers}). A row whose machine has a live `CadrePeer` row is a live sibling
 * when that row passes the membership predicate and is ignored otherwise (this node's own row,
 * or a machine this node's anchor does not trust). A row whose machine has no live `CadrePeer`
 * row is a removed machine only when a `CadrePeer` tombstone names it; otherwise the machine's
 * row has simply not replicated here yet, and the row is ignored.
 */
export function partitionPartyStrandPeers(
  rows: readonly StrandPeerRow[],
  machines: readonly CadreMachine[],
  tombstones: readonly RevocationRow[],
): PartyStrandPeers {
  const liveMachines = new Map(machines.map((machine) => [machine.peerId, machine]));
  const removedMachines = new Set(
    tombstones.filter((tombstone) => tombstone.tableName === 'CadrePeer').map((tombstone) => tombstone.rowKey)
  );
  const live = new Set<string>();
  const removed = new Set<string>();
  for (const row of rows) {
    const machine = liveMachines.get(row.peerId);
    if (machine !== undefined) {
      if (machine.trusted) {
        live.add(row.strandPeerId);
      }
    } else if (removedMachines.has(row.peerId)) {
      removed.add(row.strandPeerId);
    }
  }
  for (const id of live) {
    removed.delete(id);
  }
  return { live: [...live], removed: [...removed] };
}
