import { describe, it, expect, vi } from 'vitest';
import type { ICohortReachability } from '@optimystic/db-core';
import { StrandPartyMachines, cohortGateWaitingForMachines, watchRemovedMachinesInSeed } from '../src/strand-party-machines.js';
import type { PartyStrandPeer, PartyStrandPeers } from '../src/strand-party-peers.js';

/**
 * The offline queue's hold for the party's own machines (docs/strands/writes.md → "Waiting for the
 * party's own machines"): the gate's branching over a stand-in node gate and key network, and
 * the tracker's handling of failed reads. Pure; the hold end to end is
 * `strand-offline-waits-for-party-machine.integration.ts`.
 */

const SELF = 'self';
const NODE: PartyStrandPeer = { peerId: 'node-control', strandPeerId: 'node-strand', serves: true };
const CLIENT: PartyStrandPeer = { peerId: 'phone-control', strandPeerId: 'phone-strand', serves: false };

/** A `PartyStrandPeerSource.read` the test scripts one answer at a time. */
function scriptedSource(): { read: () => Promise<PartyStrandPeers>; answer: (live: PartyStrandPeer[], removed?: string[]) => void; fail: (error: Error) => void; reads: () => number } {
  const pending: Array<{ resolve: (peers: PartyStrandPeers) => void; reject: (error: Error) => void }> = [];
  let reads = 0;
  return {
    read: () => new Promise<PartyStrandPeers>((resolve, reject) => {
      reads++;
      pending.push({ resolve, reject });
    }),
    answer: (live, removed = []) => pending.shift()!.resolve({ live, removed }),
    fail: (error) => pending.shift()!.reject(error),
    reads: () => reads,
  };
}

/** Lets a read the source just answered run its chain to the end (`inFlight` cleared), so the next `refresh` starts a read. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** A tracker whose first read has already answered `live`. */
async function trackerWith(live: PartyStrandPeer[]): Promise<StrandPartyMachines> {
  const source = scriptedSource();
  const tracker = new StrandPartyMachines({ label: 's', source });
  tracker.refresh();
  source.answer(live);
  await tracker.settled();
  return tracker;
}

const gate = (open: boolean): ICohortReachability & { asked: () => number } => {
  let asked = 0;
  return { reachable: async () => { asked++; return open; }, asked: () => asked };
};

/** A key network whose every cohort is `cohort`, or whose lookup throws when `cohort` is an Error. */
const keyNetwork = (cohort: string[] | Error) => ({
  findCluster: vi.fn(async () => {
    if (cohort instanceof Error) throw cohort;
    return Object.fromEntries(cohort.map((id) => [id, { multiaddrs: [], publicKey: '' }]));
  }),
});

describe('cohortGateWaitingForMachines', () => {
  it('answers closed when the node\'s gate is, and reads nothing further', async () => {
    const network = keyNetwork([SELF]);
    const composed = cohortGateWaitingForMachines(gate(false), network, SELF, await trackerWith([NODE]));
    expect(await composed.reachable(['b1'])).toBe(false);
    expect(network.findCluster).not.toHaveBeenCalled();
  });

  it('answers open while the party has no other machine holding the strand', async () => {
    const network = keyNetwork([SELF]);
    const composed = cohortGateWaitingForMachines(gate(true), network, SELF, await trackerWith([]));
    expect(await composed.reachable(['b1'])).toBe(true);
    expect(network.findCluster).not.toHaveBeenCalled();
  });

  it('answers closed when this node is alone in a block\'s cohort and a party machine holds the strand', async () => {
    const composed = cohortGateWaitingForMachines(gate(true), keyNetwork([SELF]), SELF, await trackerWith([NODE]));
    expect(await composed.reachable(['b1', 'b1'])).toBe(false);
  });

  it('answers open when another member is in the cohort, whoever it is', async () => {
    const composed = cohortGateWaitingForMachines(gate(true), keyNetwork([SELF, 'other-party-member']), SELF, await trackerWith([NODE]));
    expect(await composed.reachable(['b1'])).toBe(true);
  });

  it('answers closed when a cohort lookup throws', async () => {
    const composed = cohortGateWaitingForMachines(gate(true), keyNetwork(new Error('ring not ready')), SELF, await trackerWith([NODE]));
    expect(await composed.reachable(['b1'])).toBe(false);
  });

  it('waits for the first read, and asks for another after a failed one', async () => {
    const source = scriptedSource();
    const tracker = new StrandPartyMachines({ label: 's', source });
    const composed = cohortGateWaitingForMachines(gate(true), keyNetwork([SELF]), SELF, tracker);
    tracker.refresh();
    const asked = composed.reachable(['b1']);
    // Not answered until the first read settles.
    expect(await Promise.race([asked.then(() => 'answered'), Promise.resolve('waiting')])).toBe('waiting');
    source.fail(new Error('store offline'));
    // A failed first read counts as no machines: the gate opens, and asks the tracker to read again.
    expect(await asked).toBe(true);
    expect(tracker.lastReadFailed()).toBe(true);
    expect(source.reads()).toBe(2);
    source.answer([NODE]);
    await vi.waitFor(() => expect(tracker.lastReadFailed()).toBe(false));
    expect(await composed.reachable(['b1'])).toBe(false);
  });
});

describe('StrandPartyMachines', () => {
  it('counts only the machines that serve the strand, and every removed id whether it served or not', async () => {
    const source = scriptedSource();
    const tracker = new StrandPartyMachines({ label: 's', source });
    const changes = vi.fn();
    tracker.onChange(changes);

    tracker.refresh();
    source.answer([NODE, CLIENT], ['gone-server', 'gone-phone']);
    await tracker.settled();
    expect(tracker.machines()).toEqual([NODE]);
    expect([...tracker.removed()].sort()).toEqual(['gone-phone', 'gone-server']);

    // A client arriving or leaving changes neither set, so nothing is announced a second time.
    tracker.refresh();
    source.answer([NODE], ['gone-server', 'gone-phone']);
    await settle();
    expect(changes).toHaveBeenCalledTimes(1);
  });

  it('keeps the last answer through a failed read, coalesces refreshes, and announces only a change', async () => {
    const source = scriptedSource();
    const tracker = new StrandPartyMachines({ label: 's', source });
    const changes = vi.fn();
    tracker.onChange(changes);

    tracker.refresh();
    tracker.refresh();
    tracker.refresh();
    source.answer([NODE]);
    await tracker.settled();
    // The two refreshes asked during the first read ran as one more read.
    expect(source.reads()).toBe(2);
    source.answer([NODE]);
    await settle();
    expect(source.reads()).toBe(2);
    expect(tracker.machines()).toEqual([NODE]);
    expect(changes).toHaveBeenCalledTimes(1);

    tracker.refresh();
    source.fail(new Error('store offline'));
    await settle();
    expect(tracker.lastReadFailed()).toBe(true);
    expect(tracker.machines()).toEqual([NODE]);
    expect(changes).toHaveBeenCalledTimes(1);

    tracker.refresh();
    source.answer([]);
    await settle();
    expect(tracker.machines()).toEqual([]);
    expect(tracker.lastReadFailed()).toBe(false);
    expect(changes).toHaveBeenCalledTimes(2);
  });
});

describe('watchRemovedMachinesInSeed', () => {
  /** How many rebuilds one runtime asks for: built on `seed` under the strand's `announced` memory, its first read naming `removed`. */
  async function rebuildsAsked(removed: string[], seed: string[], announced: Set<string>): Promise<number> {
    const source = scriptedSource();
    const tracker = new StrandPartyMachines({ label: 's', source });
    const found = vi.fn();
    watchRemovedMachinesInSeed(tracker, new Set(seed), announced, found, 's');
    tracker.refresh();
    source.answer([], removed);
    await tracker.settled();
    return found.mock.calls.length;
  }

  it('asks for a rebuild for a removed machine in the seed, and not for one outside it', async () => {
    expect(await rebuildsAsked(['gone'], ['gone', 'other'], new Set())).toBe(1);
    expect(await rebuildsAsked(['gone'], ['other'], new Set())).toBe(0);
  });

  it('does not ask again while a rebuilt seed still names the machine, and asks again once a seed has left it out', async () => {
    const announced = new Set<string>();
    expect(await rebuildsAsked(['gone'], ['gone'], announced)).toBe(1);
    expect(await rebuildsAsked(['gone'], ['gone'], announced)).toBe(0);
    expect(await rebuildsAsked([], [], announced)).toBe(0);
    expect(await rebuildsAsked(['gone'], ['gone'], announced)).toBe(1);
  });
});
