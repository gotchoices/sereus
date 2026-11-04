/**
 * The party's other machines known to hold one strand, and the offline queue's gate that waits
 * for them (`docs/strands.md` → Waiting for the party's own machines).
 *
 * Why. Optimystic's own reachability gate (`KeyNetworkCohortReachability` in db-p2p) knows only
 * the peers this strand node has itself met and seen serve the network. A sibling of the party
 * that this node has never connected to is not among them, so with the sibling's port blocked
 * the gate answers "genuinely alone" and a queued transaction is committed by this machine
 * alone. The party's control database knows better: every machine that runs the strand has
 * written a `CadreControl.StrandPeer` row for it (`strand-party-peers.ts`), so the machines a
 * queued transaction must not be committed without are the live, trusted machines with such a
 * row.
 *
 * What it does. {@link StrandPartyMachines} keeps the last good read of those machines, read
 * through the launch's `PartyStrandPeerSource` at bring-up and again whenever the control
 * database's party tables change (`StrandInstanceManager.notifyPartyPeersChanged`).
 * {@link cohortGateWaitingForMachines} composes the node's gate with it: a block whose cohort
 * names nobody but this node is unreachable while the party has a machine holding the strand.
 * The composed gate is registered with the strand connection's collection factory
 * (`StrandConnectionOptions.cohortReachability`), where the queue and the offline live-read
 * path both ask it. Only a node offering offline mode builds either.
 */

import debug from 'debug';
import type { BlockId, ICohortReachability, IKeyNetwork } from '@optimystic/db-core';
import { routingKeyForBlock } from '@optimystic/db-core';
import { describeThrown } from './describe-thrown.js';
import type { PartyStrandPeer, PartyStrandPeerSource } from './strand-party-peers.js';

const log = debug('sereus:cadre:strand-party-machines');

export interface StrandPartyMachinesDeps {
  /** Names the strand in logs. */
  label: string;
  source: Pick<PartyStrandPeerSource, 'read'>;
}

/**
 * The party's other machines known to hold one strand, from the last good read of the control
 * database. Built per runtime build, before the strand's node, and stopped with the runtime.
 *
 * NOTE: a machine that stops running the strand but stays in the cadre (its filter changed, its
 * app was removed, `stopStrand`) keeps its `StrandPeer` row, so it keeps counting here until it
 * is removed from the cadre, as a peer that never returns keeps counting in Optimystic's own
 * gate. If operators hit this, add a strand-address reply saying the filter excludes the strand,
 * and drop a machine that answers so.
 *
 * NOTE: {@link settled} waits on the first control read, and the gate waits on it, so a stalled
 * read would stall the queue and offline live reads with it. The read is the local one
 * `connectedSiblingTargets`' NOTE in `cadre-node.ts` measured in milliseconds; if a control read
 * ever can stall, bound this one and answer "no machines" past the bound.
 */
export class StrandPartyMachines {
  private last: readonly PartyStrandPeer[] = [];
  private failed = false;
  private inFlight: Promise<void> | null = null;
  /** A refresh asked while a read was in flight: one more read follows, so no change is missed. */
  private again = false;
  private stopped = false;
  /** One entry per `onChange` call, so a listener subscribed twice is two subscriptions. */
  private readonly listeners = new Set<{ readonly listener: () => void }>();
  private readonly firstRead: Promise<void>;
  private settleFirstRead: (() => void) | null = null;

  constructor(private readonly deps: StrandPartyMachinesDeps) {
    this.firstRead = new Promise<void>((resolve) => {
      this.settleFirstRead = resolve;
    });
  }

  /** Read again now: coalesced, one read in flight. A failed read logs and keeps the last answer. */
  refresh(): void {
    if (this.stopped) {
      return;
    }
    if (this.inFlight !== null) {
      this.again = true;
      return;
    }
    this.inFlight = this.read().finally(() => {
      this.inFlight = null;
      this.settleFirstRead?.();
      this.settleFirstRead = null;
      if (this.again) {
        this.again = false;
        this.refresh();
      }
    });
  }

  /** Settles once the first read has finished, either way. */
  settled(): Promise<void> {
    return this.firstRead;
  }

  /** The last good read's live machines; empty before one. */
  machines(): readonly PartyStrandPeer[] {
    return this.last;
  }

  /** Whether the most recent read failed, so the answer in {@link machines} may be stale. */
  lastReadFailed(): boolean {
    return this.failed;
  }

  /** Called only when the set of machines changes. Returns an idempotent unsubscribe. */
  onChange(listener: () => void): () => void {
    if (this.stopped) {
      return () => undefined;
    }
    const subscription = { listener };
    this.listeners.add(subscription);
    return () => {
      this.listeners.delete(subscription);
    };
  }

  /** Drops every listener; a read in flight keeps nothing. */
  stop(): void {
    this.stopped = true;
    this.listeners.clear();
    // A gate waiting on a tracker that never read must not wait forever.
    this.settleFirstRead?.();
    this.settleFirstRead = null;
  }

  private async read(): Promise<void> {
    let machines: readonly PartyStrandPeer[];
    try {
      machines = (await this.deps.source.read()).live;
    } catch (error) {
      this.failed = true;
      log('strand %s: the party\'s machines could not be read (keeping %d known): %s',
        this.deps.label, this.last.length, describeThrown(error));
      return;
    }
    this.failed = false;
    if (this.stopped || sameMachines(this.last, machines)) {
      return;
    }
    this.last = machines;
    log('strand %s: the party has %d other machine(s) holding the strand', this.deps.label, machines.length);
    for (const { listener } of [...this.listeners]) {
      try {
        listener();
      } catch (error) {
        log('strand %s: a machines listener threw: %o', this.deps.label, error);
      }
    }
  }
}

function sameMachines(a: readonly PartyStrandPeer[], b: readonly PartyStrandPeer[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  const keys = new Set(a.map(machineKey));
  return b.every((machine) => keys.has(machineKey(machine)));
}

function machineKey(machine: PartyStrandPeer): string {
  return `${machine.peerId}/${machine.strandPeerId}`;
}

/** The slice of {@link StrandPartyMachines} the composed gate reads. */
export type CohortGateMachines = Pick<StrandPartyMachines, 'settled' | 'machines' | 'lastReadFailed' | 'refresh' | 'onChange'>;

/**
 * `inner` (the node's gate), closed also while this node is alone in a block's cohort and the
 * party has machines holding the strand. In order: `inner` closed answers closed and nothing
 * further is read; then the first machine read is awaited, and a failed last read is asked again
 * (the retry rides the asker's own re-check, so no timer here); no machines answers open;
 * otherwise every distinct block's cohort is read from the key network, and one naming nobody
 * but this node, or one whose lookup throws, answers closed.
 *
 * The test is "alone in the cohort", not "a machine is unconnected": with one sibling connected
 * and another blocked the cohort has two members, the commit runs on it, and nothing is held.
 * The same goes for another party's member being connected. `onChange` forwards both the node
 * gate's wakes and a change of the machines.
 */
export function cohortGateWaitingForMachines(
  inner: ICohortReachability,
  keyNetwork: Pick<IKeyNetwork, 'findCluster'>,
  selfId: string,
  machines: CohortGateMachines
): ICohortReachability {
  /** The previous answer, so the log marks each change rather than each ask. */
  let lastAnswer: boolean | undefined;
  const answer = (open: boolean, why: string): boolean => {
    if (open !== lastAnswer) {
      lastAnswer = open;
      log('gate %s: %s', open ? 'open' : 'closed', why);
    }
    return open;
  };
  const aloneInCohort = async (blockId: BlockId): Promise<boolean | 'lookup-failed'> => {
    try {
      const cohort = Object.keys(await keyNetwork.findCluster(routingKeyForBlock(blockId)));
      return !cohort.some((peerId) => peerId !== selfId);
    } catch (error) {
      log('gate: the cohort of block %s could not be read: %s', blockId, describeThrown(error));
      return 'lookup-failed';
    }
  };
  return {
    async reachable(blockIds) {
      if (!(await inner.reachable(blockIds))) {
        return answer(false, 'the node\'s own gate is closed');
      }
      await machines.settled();
      if (machines.lastReadFailed()) {
        machines.refresh();
      }
      const known = machines.machines();
      if (known.length === 0) {
        return answer(true, 'the party has no other machine holding the strand');
      }
      for (const blockId of new Set(blockIds)) {
        const alone = await aloneInCohort(blockId);
        if (alone === 'lookup-failed') {
          return answer(false, `block ${blockId}'s cohort could not be read`);
        }
        if (alone) {
          return answer(false, `alone in block ${blockId}'s cohort while ${known.length} party machine(s) hold the strand`);
        }
      }
      return answer(true, 'another member is in every cohort');
    },
    onChange(listener) {
      const releaseInner = inner.onChange?.(listener);
      const releaseMachines = machines.onChange(listener);
      return () => {
        releaseInner?.();
        releaseMachines();
      };
    }
  };
}
