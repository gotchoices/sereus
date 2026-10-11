import { describe, it, expect, vi, afterEach } from 'vitest';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import type { Connection, PrivateKey } from '@libp2p/interface';
import type { Multiaddr } from '@multiformats/multiaddr';
import { superviseStrandPeerRedial, type RedialNode, type StrandPeerRedial, type StrandRedialTimings } from '../src/strand-peer-redial.js';
import type { TimeoutScheduler } from '../src/timeout-scheduler.js';
import { fretEntry, fretService, type FretEntryFake } from './fret-record-helpers.js';

/**
 * The strand member redial's decisions over a stand-in strand node: whom it dials, when it
 * does nothing, and how long it waits between rounds. Real signed FRET records and the real
 * `dialPeerAddrs`; only the node's `dial`, its connection list and the timers are doubles.
 */

const TIMINGS: StrandRedialTimings = {
  budget: { perAddressMs: 60_000, totalMs: 60_000 },
  minBackoffMs: 1_000,
  maxBackoffMs: 3_000,
  checkMs: 500
};

const idOf = (key: PrivateKey): string => peerIdFromPrivateKey(key).toString();

/** A scheduler that runs nothing on its own and records each wait it was asked for. */
function fakeScheduler(): TimeoutScheduler & { waits: number[]; fire(): void } {
  const pending: Array<() => void> = [];
  const waits: number[] = [];
  return {
    waits,
    setTimeout: (fn, ms) => { pending.push(fn); waits.push(ms); return fn; },
    clearTimeout: (handle) => {
      const index = pending.indexOf(handle as () => void);
      if (index >= 0) pending.splice(index, 1);
    },
    fire: () => {
      const fn = pending.shift();
      expect(fn, 'no look was scheduled').toBeDefined();
      fn!();
    }
  };
}

/** A strand node connected to `connected`, whose FRET table is `entries`, and whose dials `dial` answers. */
function fakeNode(self: PrivateKey, entries: FretEntryFake[], connected: Set<string>, dial: (addr: Multiaddr) => Promise<void>) {
  const events = new EventTarget();
  const node = {
    peerId: peerIdFromPrivateKey(self),
    services: fretService(entries),
    getConnections: () => [...connected].map((id) => ({ remotePeer: { toString: () => id } })),
    dial: vi.fn(async (addr: Multiaddr) => { await dial(addr); return {} as Connection; }),
    addEventListener: (type: 'peer:disconnect', listener: () => void) => events.addEventListener(type, listener),
    removeEventListener: (type: 'peer:disconnect', listener: () => void) => events.removeEventListener(type, listener),
    disconnect: (peerId: string) => { connected.delete(peerId); events.dispatchEvent(new Event('peer:disconnect')); }
  };
  return node satisfies RedialNode;
}

/** The peer ids `node.dial` was called for, in call order. */
function dialedPeers(node: ReturnType<typeof fakeNode>): string[] {
  return node.dial.mock.calls.map(([addr]) => addr.getComponents().filter((c) => c.name === 'p2p').at(-1)!.value!);
}

describe('superviseStrandPeerRedial', () => {
  const loops: StrandPeerRedial[] = [];
  afterEach(() => loops.splice(0).forEach((loop) => loop.stop()));

  function start(...args: Parameters<typeof superviseStrandPeerRedial>): void {
    loops.push(superviseStrandPeerRedial(...args));
  }

  it('dials the member it knows when only the relay is connected, and stops once that member is connected', async () => {
    const [self, relay, founder] = await Promise.all([1, 2, 3].map(() => generateKeyPair('Ed25519')));
    const connected = new Set([idOf(relay)]);
    const node = fakeNode(self, [
      // FRET files the relay like any connected peer, record included; only its label says it is no member.
      { ...await fretEntry(relay, ['/ip4/127.0.0.1/tcp/4001/ws']), membership: 'foreign' },
      { ...await fretEntry(founder, [`/ip4/127.0.0.1/tcp/4001/ws/p2p/${idOf(relay)}/p2p-circuit`]), membership: 'member' }
    ], connected, async () => { connected.add(idOf(founder)); });
    const scheduler = fakeScheduler();

    start({ label: 's', node, seed: [], excluded: new Set(), scheduler }, TIMINGS);
    await vi.waitFor(() => expect(scheduler.waits).toEqual([TIMINGS.checkMs]));
    expect(dialedPeers(node)).toEqual([idOf(founder)]);

    scheduler.fire();
    await vi.waitFor(() => expect(scheduler.waits).toHaveLength(2));
    expect(node.dial).toHaveBeenCalledTimes(1);
  });

  it('dials nobody when it knows no member it may dial', async () => {
    const [self, relay, partyRelay, revoked] = await Promise.all([1, 2, 3, 4].map(() => generateKeyPair('Ed25519')));
    const node = fakeNode(self, [
      { ...await fretEntry(relay, ['/ip4/127.0.0.1/tcp/4001/ws']), membership: 'foreign' },
      // A party-run relay speaks a control network's protocols, so FRET may not have judged it; it is excluded by id.
      await fretEntry(partyRelay, ['/ip4/127.0.0.1/tcp/4002/ws']),
      { ...await fretEntry(revoked, ['/ip4/127.0.0.1/tcp/4003/ws']), membership: 'member' }
    ], new Set([idOf(relay)]), async () => {});
    const scheduler = fakeScheduler();

    start({
      label: 's', node, seed: [], excluded: new Set([idOf(partyRelay)]),
      isRevoked: (peerId) => peerId === idOf(revoked), scheduler
    }, TIMINGS);
    await vi.waitFor(() => expect(scheduler.waits).toEqual([TIMINGS.checkMs]));
    expect(node.dial).not.toHaveBeenCalled();
  });

  it('backs off between failed rounds, doubling to the cap, and starts over after a round connects', async () => {
    const [self, sibling] = await Promise.all([1, 2].map(() => generateKeyPair('Ed25519')));
    const connected = new Set<string>();
    let answers = false;
    const node = fakeNode(self, [], connected, async () => {
      if (!answers) throw new Error('unreachable');
      connected.add(idOf(sibling));
    });
    const scheduler = fakeScheduler();

    // Known from the launch seed alone: what a joiner's first launch has before FRET holds a record.
    start({ label: 's', node, seed: [`/ip4/127.0.0.1/tcp/4001/ws/p2p/${idOf(sibling)}`], excluded: new Set(), scheduler }, TIMINGS);
    for (const expected of [[1_000], [1_000, 2_000], [1_000, 2_000, 3_000], [1_000, 2_000, 3_000, 3_000]]) {
      await vi.waitFor(() => expect(scheduler.waits).toEqual(expected));
      if (expected.length < 4) scheduler.fire();
    }
    answers = true;
    scheduler.fire();
    await vi.waitFor(() => expect(scheduler.waits.at(-1)).toBe(TIMINGS.checkMs));
    answers = false;
    node.disconnect(idOf(sibling));
    await vi.waitFor(() => expect(scheduler.waits.at(-1)).toBe(TIMINGS.minBackoffMs));
    expect(node.dial).toHaveBeenCalledTimes(6);
  });

  it('looks at once when a peer disconnects while it is watching, but not while it is backing off', async () => {
    const [self, member] = await Promise.all([1, 2].map(() => generateKeyPair('Ed25519')));
    const connected = new Set([idOf(member)]);
    const node = fakeNode(self, [{ ...await fretEntry(member, ['/ip4/127.0.0.1/tcp/4001/ws']), membership: 'member' }],
      connected, async () => { throw new Error('unreachable'); });
    const scheduler = fakeScheduler();

    start({ label: 's', node, seed: [], excluded: new Set(), scheduler }, TIMINGS);
    await vi.waitFor(() => expect(scheduler.waits).toEqual([TIMINGS.checkMs]));
    node.disconnect(idOf(member));
    await vi.waitFor(() => expect(scheduler.waits).toEqual([TIMINGS.checkMs, TIMINGS.minBackoffMs]));
    node.disconnect(idOf(member));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(node.dial).toHaveBeenCalledTimes(1);
    expect(scheduler.waits).toHaveLength(2);
  });
});
