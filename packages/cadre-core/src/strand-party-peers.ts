/**
 * A party's machines as one strand sees them: which strand peer ids belong to the party's live
 * machines and which to machines removed from the cadre, projected from the control database.
 * The inputs are the strand's `CadreControl.StrandPeer` rows (each machine's own signed
 * statement of its peer id in the strand), the live `CadrePeer` rows judged by this node's
 * membership predicate, and the `CadrePeer` tombstones.
 *
 * Two readers. The closed-strand membership reconciler (`strand-membership-reconciler.ts`)
 * binds every live sibling under the party's current member key and clears a removed
 * machine's binding, so a sibling that was offline when the party's key changed is already
 * bound when it returns, and a machine wrongly bound under a key is cleared. Who binds whom is
 * stated in `docs/strands.md` → Closed-Strand Member Key Handling. The same loop reads the
 * party's pending key through this seam ({@link PartyStrandPeerSource.pendingKey}): while the
 * party is moving to another key in the strand, a staged invitation is redeemed under that key
 * rather than the current one (`docs/strands.md` → Replacing the party's key). On a node
 * offering offline mode, `strand-party-machines.ts` reads the live machines of every strand,
 * open or closed, as the machines a queued transaction must not be committed without
 * (`docs/strands.md` → Waiting for the party's own machines).
 */

import type { OpenedPendingPartyKey } from './strand-party-key-rotation.js';
import type { CadreMachine, RevocationRow, StrandPeerRow } from './types.js';

/**
 * The party's pending key in one strand, as this machine can read it
 * ({@link PartyStrandPeerSource.pendingKey}). `pending: true` means a `PendingStrandPartyKey`
 * row exists for the strand; its `key` is the row opened under this machine's identity key, or
 * null when the row is sealed to other machines (a machine admitted after the removal) or this
 * node runs on an ephemeral identity and can open nothing.
 */
export type PendingPartyKeyState =
  | { pending: false }
  | { pending: true; key: OpenedPendingPartyKey | null };

/** One of the party's other machines in one strand, as its `StrandPeer` row states it. */
export interface PartyStrandPeer {
  /** The machine's control peer id (`CadrePeer.PeerId`, what `listMachines` and `removeMachine` use). */
  readonly peerId: string;
  /** Its peer id in this strand's network. */
  readonly strandPeerId: string;
}

/** The party's machines' peer ids in one strand, as {@link partitionPartyStrandPeers} sorts them. */
export interface PartyStrandPeers {
  /**
   * The party's live machines other than this one: each has a `StrandPeer` row and a live
   * `CadrePeer` row that passes the membership predicate (`CadreMachine.trusted`, which is false
   * for this node itself). One entry per strand peer id.
   */
  live: readonly PartyStrandPeer[];
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
 * The control-database seam of one strand's party machines, scoped to one strand as
 * `PendingMembershipInviteSource` is. `CadreNode` builds one per strand launch
 * (`StartStrandConfig.partyPeers`); the instance manager publishes through it at bring-up and
 * hands it to the reconciler and to the offline-mode machine tracker, each of which reads
 * through it.
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
   * `PendingStrandPartyKey` row), and that key opened for this machine when it can be
   * ({@link PendingPartyKeyState}). Rejects when the row cannot be read or does not decode,
   * which a caller treats as `{ pending: true, key: null }`: while a rotation may be pending, a
   * removed machine's binding under the current key is the orphan the rotation is about to
   * leave, and clearing it would hand the removed machine a clean slate; and nothing may be
   * seated under the current key, which the removed machine holds.
   */
  pendingKey(): Promise<PendingPartyKeyState>;
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
  const live = new Map<string, PartyStrandPeer>();
  const removed = new Set<string>();
  for (const row of rows) {
    const machine = liveMachines.get(row.peerId);
    if (machine !== undefined) {
      if (machine.trusted && !live.has(row.strandPeerId)) {
        live.set(row.strandPeerId, { peerId: row.peerId, strandPeerId: row.strandPeerId });
      }
    } else if (removedMachines.has(row.peerId)) {
      removed.add(row.strandPeerId);
    }
  }
  for (const id of live.keys()) {
    removed.delete(id);
  }
  return { live: [...live.values()], removed: [...removed] };
}
