/**
 * Party key rotation: the driver that moves a party onto a fresh membership key in one closed
 * strand after a machine was removed from the cadre, so the removed machine is left holding a
 * key that is no longer a member there (docs/architecture.md → "Removing a machine").
 *
 * ## What it rests on
 *
 * - A `Strand.MemberPeer` binding is signed by the member key, which every machine of the
 *   party holds, so any party machine can bind any peer id under the party's key. Which peer
 *   ids are the party's remaining machines, and which the removed machine's, is the control
 *   record's `StrandPeer` rows joined to the live machines (`strand-party-peers.ts`).
 * - The revoked-peer gate (`strand-revocation-enforcer.ts`) denies a peer id only when it has
 *   an orphaned binding and no live one. A remaining machine bound under both the old key K and
 *   the new key K' stays served when K leaves; the removed machine, bound under K alone, is
 *   denied on the rows alone, with no new gate logic.
 * - `leaveStrand` is self-signed by the departing key, and `removeManager`'s resign branch
 *   needs another manager standing. So K can remove itself once K' is a manager, and no second
 *   party is involved in a strand the party manages.
 * - The founder bootstrap skips `Member` and `Manager` when either table has rows, so a founder
 *   restart after a rotation never tries to re-seat K' as a founding row.
 *
 * ## Where the new key lives before it is current
 *
 * The removal transaction writes a `PendingStrandPartyKey` row per closed strand the party holds
 * a key for, in the same owner approval as the machine's tombstone (`ControlDatabase.removeMachine`),
 * so the removal and the intent to rotate are exactly as durable as each other. That row is the
 * run's input; the `StrandPartyKey` row stays K until the last step.
 *
 * ## One run
 *
 * Runs on an OWNER machine that runs the strand (an owner signer is enrolled, the instance is
 * live with a database); `CadreNode` decides that and never asks a non-owner machine to drive.
 * Each run reads the pending row and the strand's rows and continues from wherever the state
 * says it is. Every step reads before it writes, and a duplicate-row rejection counts as done,
 * so two owner machines driving one strand converge:
 *
 * 1. **Clean up superseded keys.** A second removal while a rotation is pending replaced the
 *    pending key, and the replaced key may already hold a seat (a driver seated it before the
 *    replacement). For each public key in `Superseded` that holds a `Member` row: `removeManager`
 *    by K if it holds a `Manager` row, then `revokeMember` by K. Its bindings become orphans
 *    beside K's, harmless to remaining machines, which are bound under K and then K'. A
 *    superseded key that IS the current key is skipped: another driver finished the earlier
 *    rotation and this one continues from it.
 * 2. **Seat K'.** `addMemberByManager(K, K')`. When K holds no `Manager` row and K' is not yet a
 *    member, the run stops here as `needs-another-party` (one event per pending stamp): the row
 *    stays for the cross-party flow (`plan/party-key-rotation-across-parties`).
 * 3. **Bind under K'**: this machine's own strand peer id and every live sibling's, each
 *    `registerMemberPeer(K', id)` (insert-if-absent). Self-signed by K', so this step also runs
 *    after K has left.
 * 4. **Promote K'**: `addManager(K, K')`, when K is a manager. After the bindings, so a key that
 *    was seated but never bound cannot exist beyond step 2.
 * 5. **K steps down**: `removeManager`'s resign branch signed by K (K' now stands, so the sole
 *    manager guard does not fire), then `leaveStrand` signed by K. The removed machine's binding
 *    under K is now the orphan; remaining machines are live under K'.
 * 6. **Swap the control row**, one transaction and one owner approval across every strand whose
 *    steps 1 to 5 completed in this run ({@link StrandPartyKeyRotationDeps.swapKeys}). Deferred
 *    while a control write could fork the party, like every background control write; the
 *    strands are reported `pending` and the growth drain re-runs them. After the swap the
 *    running instance is re-keyed and `strand:party-key-rotated` is emitted.
 *
 * Crash recovery is the same run: pending row present and K' not a member → step 2; K' a member
 * but K still one → steps 3 to 5 as needed; K gone from the strand, control still K → step 6;
 * no pending row → nothing. A run that finds K' already current (another driver swapped) ends.
 *
 * ## Single flight
 *
 * One run per strand at a time: a call that names a strand already being driven waits for that
 * run's outcome rather than starting a second. Strands in one call are prepared one after
 * another and swapped together.
 */

import debug from 'debug';
import type { Database } from '@quereus/quereus';
import type { Ed25519KeyPair } from './ed25519-key.js';
import { strandMemberKeyPair } from './strand-member-key.js';
import {
  addManager,
  addMemberByManager,
  isStrandManager,
  isStrandMember,
  leaveStrand,
  listMemberPeers,
  registerMemberPeer,
  removeManager,
  revokeMember,
  type StrandWriteOptions,
} from './strand-membership-writer.js';
import type { PendingStrandPartyKeyRow, StrandKeyRotationOutcome } from './types.js';
import { describeThrown } from './describe-thrown.js';

const log = debug('sereus:cadre:strand-party-key-rotation');

/** Every strand write here runs in a transaction of its own, never joining one the app has open. */
const OWN_TRANSACTION: StrandWriteOptions = { joinOpenTransaction: false };

/** What became of one strand in a run ({@link StrandKeyRotationOutcome.outcome}). */
export type RotationOutcome = StrandKeyRotationOutcome['outcome'];

/** One strand's finished steps 1 to 5, ready for the control swap (step 6). */
export interface StrandPartyKeySwapEntry {
  strandId: string;
  /** The key the control row names now, encoded as `StrandPartyKey.PrivateKey`. */
  oldKey: string;
  /** The key the strand's rows now name as the party's member, same encoding. */
  newKey: string;
}

/** The seams the driver reads and writes through; `CadreNode` builds one over its control database and strand manager. */
export interface StrandPartyKeyRotationDeps {
  /** The strand's pending row, or null when no rotation is pending there. Rejects when it cannot be read. */
  readPending(strandId: string): Promise<PendingStrandPartyKeyRow | null>;
  /** The strand's `StrandPartyKey.PrivateKey`, or null when the party holds no key there. */
  readCurrentKey(strandId: string): Promise<string | null>;
  /**
   * The strand peer ids of the party's other live machines in the strand
   * (`PartyStrandPeers.live`), read fresh. Rejects when they cannot be read.
   */
  readSiblingPeerIds(strandId: string): Promise<readonly string[]>;
  /** The strand's live database, read per step; `undefined` means the strand does not run here now. */
  getDatabase(strandId: string): Database | undefined;
  /** This machine's own peer id in the strand, read per step. */
  getOwnPeerId(strandId: string): string | undefined;
  /**
   * Step 6: the control-row swap for every entry, one transaction and one owner approval.
   * Resolves the strand ids actually swapped (an entry another driver already swapped is
   * skipped), or `'deferred'` when a control write now could fork the party.
   */
  swapKeys(entries: readonly StrandPartyKeySwapEntry[]): Promise<readonly string[] | 'deferred'>;
  /** After the swap committed: re-key the running instance and tell the app. */
  onRotated(strandId: string, newKey: string): Promise<void>;
  /** Step 2 found no manager seat for the party; once per pending stamp. */
  onBlocked(strandId: string, reason: 'needs-another-party'): void;
}

/** How far one strand got before the swap. */
type Prepared =
  | { kind: 'ready'; entry: StrandPartyKeySwapEntry }
  | { kind: 'blocked'; stampId: string }
  | { kind: 'nothing' }
  | { kind: 'failed'; error: unknown };

/** The rows of one strand a run reads before it writes. */
interface RotationState {
  oldKey: Ed25519KeyPair;
  newKey: Ed25519KeyPair;
  oldIsMember: boolean;
  oldIsManager: boolean;
  newIsMember: boolean;
  newIsManager: boolean;
}

export class StrandPartyKeyRotationDriver {
  /** The run in flight per strand; a call naming the strand joins it. */
  private readonly inFlight = new Map<string, Promise<RotationOutcome>>();
  /** The pending stamp each strand's `needs-another-party` was last reported for. */
  private readonly reportedBlocked = new Map<string, string>();

  constructor(private readonly deps: StrandPartyKeyRotationDeps) {}

  /**
   * Drive every strand in `strandIds` through the steps its state calls for, then swap the
   * control rows of the ones that finished in one transaction. Never rejects: a strand whose
   * step failed is `pending` with a log, and the next trigger re-runs it.
   */
  async drive(strandIds: readonly string[], cause: string): Promise<StrandKeyRotationOutcome[]> {
    const joined = new Map<string, Promise<RotationOutcome>>();
    const fresh: string[] = [];
    for (const strandId of new Set(strandIds)) {
      const running = this.inFlight.get(strandId);
      if (running) {
        joined.set(strandId, running);
      } else {
        fresh.push(strandId);
      }
    }
    const outcomes = new Map<string, RotationOutcome>();
    if (fresh.length > 0) {
      const run = this.run(fresh, cause);
      for (const strandId of fresh) {
        const own = run.then((result) => result.get(strandId) ?? 'pending');
        this.inFlight.set(strandId, own);
        void own.finally(() => {
          if (this.inFlight.get(strandId) === own) {
            this.inFlight.delete(strandId);
          }
        });
      }
      for (const [strandId, outcome] of await run) {
        outcomes.set(strandId, outcome);
      }
    }
    for (const [strandId, running] of joined) {
      outcomes.set(strandId, await running);
    }
    return [...new Set(strandIds)].map((strandId) => ({ strandId, outcome: outcomes.get(strandId) ?? 'pending' }));
  }

  /** Steps 1 to 5 per strand, then one swap over the ready ones. */
  private async run(strandIds: readonly string[], cause: string): Promise<Map<string, RotationOutcome>> {
    log('Party key rotation run over %d strand(s) (%s)', strandIds.length, cause);
    const outcomes = new Map<string, RotationOutcome>();
    const ready: StrandPartyKeySwapEntry[] = [];
    for (const strandId of strandIds) {
      const prepared = await this.prepare(strandId);
      switch (prepared.kind) {
        case 'ready':
          ready.push(prepared.entry);
          break;
        case 'blocked':
          outcomes.set(strandId, 'needs-another-party');
          this.reportBlocked(strandId, prepared.stampId);
          break;
        case 'nothing':
          outcomes.set(strandId, 'rotated');
          break;
        case 'failed':
          outcomes.set(strandId, 'pending');
          log('Party key rotation of strand %s left unfinished (retried on the next trigger): %s', strandId, describeThrown(prepared.error));
          break;
      }
    }
    for (const [strandId, outcome] of await this.swap(ready)) {
      outcomes.set(strandId, outcome);
    }
    return outcomes;
  }

  /** Step 6 for every ready strand, then the re-key of each one swapped. */
  private async swap(ready: readonly StrandPartyKeySwapEntry[]): Promise<Map<string, RotationOutcome>> {
    const outcomes = new Map<string, RotationOutcome>();
    if (ready.length === 0) {
      return outcomes;
    }
    let swapped: readonly string[];
    try {
      const result = await this.deps.swapKeys(ready);
      if (result === 'deferred') {
        log('Party key swap of %d strand(s) deferred: no sibling reachable and the party has other members; re-run on growth', ready.length);
        for (const entry of ready) {
          outcomes.set(entry.strandId, 'pending');
        }
        return outcomes;
      }
      swapped = result;
    } catch (error) {
      log('Party key swap of %d strand(s) failed (retried on the next trigger): %s', ready.length, describeThrown(error));
      for (const entry of ready) {
        outcomes.set(entry.strandId, 'pending');
      }
      return outcomes;
    }
    for (const entry of ready) {
      // An entry the swap skipped names a key already current (another driver swapped it), or a
      // row that moved on; either way the strand's rows are on the new key, so it is rotated.
      outcomes.set(entry.strandId, 'rotated');
      if (swapped.includes(entry.strandId)) {
        await this.deps.onRotated(entry.strandId, entry.newKey);
      }
    }
    return outcomes;
  }

  /** Steps 1 to 5 for one strand, from the state its rows are in. */
  private async prepare(strandId: string): Promise<Prepared> {
    try {
      const pending = await this.deps.readPending(strandId);
      if (pending === null) {
        return { kind: 'nothing' };
      }
      const current = await this.deps.readCurrentKey(strandId);
      if (current === null) {
        log('Party key rotation of strand %s: the party holds no key there; nothing to rotate', strandId);
        return { kind: 'nothing' };
      }
      if (current === pending.privateKey) {
        return { kind: 'nothing' };
      }
      const db = this.deps.getDatabase(strandId);
      if (db === undefined) {
        log('Party key rotation of strand %s: the strand does not run here now; left pending', strandId);
        return { kind: 'failed', error: new Error('strand not running here') };
      }
      const state = await readRotationState(db, current, pending.privateKey);
      await this.cleanUpSuperseded(db, state, pending.superseded);
      if (!state.newIsMember) {
        if (!state.oldIsManager) {
          return { kind: 'blocked', stampId: pending.stampId };
        }
        await addMemberByManager(db, { managerKeyPair: state.oldKey, memberKey: state.newKey.publicKeyB64 }, OWN_TRANSACTION);
        log('Party key rotation of strand %s: new key seated as member', strandId);
      }
      await this.bindMachines(strandId, db, state.newKey);
      if (state.oldIsManager && !state.newIsManager) {
        await addManager(db, { byManagerKeyPair: state.oldKey, newManagerKey: state.newKey.publicKeyB64 }, OWN_TRANSACTION);
        log('Party key rotation of strand %s: new key promoted to manager', strandId);
      }
      await stepDown(db, state);
      return { kind: 'ready', entry: { strandId, oldKey: current, newKey: pending.privateKey } };
    } catch (error) {
      return { kind: 'failed', error };
    }
  }

  /**
   * Step 1: a superseded key holding a seat is revoked by K. Skips the current key itself
   * (another driver finished the rotation it was pending for) and, when K holds no manager seat,
   * leaves the seat with a log for the cross-party flow.
   */
  private async cleanUpSuperseded(db: Database, state: RotationState, superseded: readonly string[]): Promise<void> {
    for (const key of superseded) {
      if (key === state.oldKey.publicKeyB64 || key === state.newKey.publicKeyB64 || !await isStrandMember(db, key)) {
        continue;
      }
      if (!state.oldIsManager) {
        log('Superseded party key %s still holds a seat and this party has no manager seat to revoke it; left for the other party\'s manager', key);
        continue;
      }
      if (await isStrandManager(db, key)) {
        await removeManager(db, { byManagerKeyPair: state.oldKey, targetManagerKey: key }, OWN_TRANSACTION);
      }
      await revokeMember(db, { managerKeyPair: state.oldKey, memberKey: key }, OWN_TRANSACTION);
      log('Superseded party key %s revoked', key);
    }
  }

  /** Step 3: every remaining machine's peer id bound under the new key; bindings already present are skipped. */
  private async bindMachines(strandId: string, db: Database, newKey: Ed25519KeyPair): Promise<void> {
    const own = this.deps.getOwnPeerId(strandId);
    const ids = new Set(await this.deps.readSiblingPeerIds(strandId));
    if (own !== undefined) {
      ids.add(own);
    }
    const bound = new Set(await listMemberPeers(db, newKey.publicKeyB64));
    for (const peerId of ids) {
      if (!bound.has(peerId)) {
        await registerMemberPeer(db, { memberKeyPair: newKey, peerId }, OWN_TRANSACTION);
        log('Party key rotation of strand %s: %s bound under the new key', strandId, peerId);
      }
    }
  }

  private reportBlocked(strandId: string, stampId: string): void {
    if (this.reportedBlocked.get(strandId) === stampId) {
      return;
    }
    this.reportedBlocked.set(strandId, stampId);
    log('Party key rotation of strand %s blocked: this party holds no manager seat there, so another party\'s manager has to admit the new key', strandId);
    this.deps.onBlocked(strandId, 'needs-another-party');
  }
}

/** The rows steps 1 to 5 decide from, read before any write. */
async function readRotationState(db: Database, currentKey: string, pendingKey: string): Promise<RotationState> {
  const oldKey = strandMemberKeyPair(currentKey);
  const newKey = strandMemberKeyPair(pendingKey);
  return {
    oldKey,
    newKey,
    oldIsMember: await isStrandMember(db, oldKey.publicKeyB64),
    oldIsManager: await isStrandManager(db, oldKey.publicKeyB64),
    newIsMember: await isStrandMember(db, newKey.publicKeyB64),
    newIsManager: await isStrandManager(db, newKey.publicKeyB64),
  };
}

/**
 * Step 5: K resigns its manager seat, then leaves. Both writers are no-ops over an absent row,
 * so a run that finds K already gone writes nothing here. The resign runs only when K' holds a
 * manager seat, so the strand never loses its last manager to this step.
 */
async function stepDown(db: Database, state: RotationState): Promise<void> {
  if (!state.oldIsMember) {
    return;
  }
  if (state.oldIsManager) {
    if (!await isStrandManager(db, state.newKey.publicKeyB64)) {
      throw new Error('the new party key holds no manager seat, so the old key cannot resign without emptying the strand\'s managers');
    }
    await removeManager(db, { byManagerKeyPair: state.oldKey, targetManagerKey: state.oldKey.publicKeyB64 }, OWN_TRANSACTION);
  }
  await leaveStrand(db, { memberKeyPair: state.oldKey }, OWN_TRANSACTION);
  log('Old party key %s left the strand', state.oldKey.publicKeyB64);
}
