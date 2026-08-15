import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { defaultLogger } from '@libp2p/logger';
import { persistentPeerStore } from '@libp2p/peer-store';
import { MemoryDatastore } from 'datastore-core';
import { TypedEventEmitter } from 'main-event';
import { multiaddr } from '@multiformats/multiaddr';
import type { Libp2pEvents, PeerId, PeerStore } from '@libp2p/interface';
import { mergePeerAddrs, type MergeAddrsResult, type PeerAddrBookHost } from '../src/peer-addr-book.js';

/**
 * The address-book merge helper, exercised against a REAL `@libp2p/peer-store`
 * (over an in-memory datastore) rather than a double, with the clock under test
 * control.
 *
 * The point of testing the real package: the helper exists to work around an
 * upstream bug — `peerStore.merge` cannot refresh an address's `observed`
 * timestamp, so a stored address silently dies at `MAX_ADDRESS_AGE` (1 hour) and
 * re-merging never revives it (`@libp2p/peer-store` 12.0.10, shadowed loop
 * variable in `to-peer-pb.js`). The "plain merge dies / helper survives" pair
 * below pins both halves, so a future libp2p bump that fixes the bug shows up
 * here as a failing test rather than in production as addresses that quietly
 * stop being dialable.
 *
 * NOTE: `@libp2p/peer-store`, `datastore-core`, `@libp2p/logger` and `main-event`
 * are transitive dependencies of `libp2p` (which cadre-core does declare) and
 * resolve out of the hoisted root `node_modules`; they are deliberately NOT added
 * to this package's devDependencies, because declaring them re-resolves their
 * ranges and drags an unrelated `datastore-core` bump into the lockfile. If a
 * future install ever fails to resolve one of these imports, declare them at the
 * exact installed versions rather than with `^` ranges.
 */

const HOUR_MS = 60 * 60_000;
const TEN_MIN_MS = 10 * 60_000;

/** Wall clock the peer store sees; advanced by {@link advance}. */
let clock = 1_700_000_000_000;

function advance(ms: number): void {
  clock += ms;
}

beforeEach(() => {
  clock = 1_700_000_000_000;
  vi.spyOn(Date, 'now').mockImplementation(() => clock);
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** A peer store whose SELF id is a throwaway (self entries never expire). */
function makePeerStore(selfPeerId: PeerId): PeerStore {
  return persistentPeerStore({
    peerId: selfPeerId,
    datastore: new MemoryDatastore(),
    events: new TypedEventEmitter<Libp2pEvents>(),
    logger: defaultLogger()
  });
}

async function freshPeerId(): Promise<PeerId> {
  return peerIdFromPrivateKey(await generateKeyPair('Ed25519'));
}

interface Fixture {
  host: PeerAddrBookHost;
  store: PeerStore;
  peerId: PeerId;
}

/** A store plus one remote peer id to write about. */
async function fixture(): Promise<Fixture> {
  const store = makePeerStore(await freshPeerId());
  return { host: { peerStore: store }, store, peerId: await freshPeerId() };
}

/** The addresses currently READABLE for `peerId` — `[]` when there is no entry. */
async function storedAddrs(store: PeerStore, peerId: PeerId): Promise<string[]> {
  try {
    const peer = await store.get(peerId);
    return peer.addresses.map((a) => a.multiaddr.toString());
  } catch (error) {
    if ((error as { name?: string }).name === 'NotFoundError') {
      return [];
    }
    throw error;
  }
}

describe('mergePeerAddrs', () => {
  it('merges a fresh address and makes it readable', async () => {
    const { host, store, peerId } = await fixture();

    await expect(mergePeerAddrs(host, peerId, [multiaddr('/ip4/1.2.3.4/tcp/1234')]))
      .resolves.toBe('merged');

    expect(await storedAddrs(store, peerId)).toEqual(['/ip4/1.2.3.4/tcp/1234']);
  });

  it('reports "merged" (not "restamped") for addresses the store rewrites on the way in', async () => {
    // The store strips a trailing `/p2p/<peerId>` when that id is the address's
    // FIRST `/p2p/` component, and keeps it when it is not (a relayed address,
    // whose first `/p2p/` names the relay). Comparing raw strings would read the
    // stripped case as "not visible" and restamp on every single pass.
    const { host, store, peerId } = await fixture();
    const relay = await freshPeerId();
    const direct = multiaddr(`/ip4/1.2.3.4/tcp/1234/ws/p2p/${peerId}`);
    const relayed = multiaddr(`/ip4/5.6.7.8/tcp/4001/p2p/${relay}/p2p-circuit/p2p/${peerId}`);

    await expect(mergePeerAddrs(host, peerId, [direct, relayed])).resolves.toBe('merged');

    expect(new Set(await storedAddrs(store, peerId))).toEqual(new Set([
      '/ip4/1.2.3.4/tcp/1234/ws',
      relayed.toString()
    ]));
  });

  it('writes nothing at all for an empty address list', async () => {
    // How a revoked / stale / untrusted peer's entry is allowed to age out: the
    // caller resolves [] for it and nothing here refreshes it.
    const { host, store, peerId } = await fixture();
    await mergePeerAddrs(host, peerId, [multiaddr('/ip4/1.2.3.4/tcp/1234')]);
    const before = await store.get(peerId);

    await expect(mergePeerAddrs(host, peerId, [])).resolves.toBe('skipped');

    // Same entry, untouched — both write paths bump `updated`, so an equal read
    // here is proof no write happened.
    expect(await store.get(peerId)).toEqual(before);
  });

  it('keeps an address readable across 200 minutes of passes, where a plain merge cannot', async () => {
    const { host, store, peerId } = await fixture();
    const plainPeerId = await freshPeerId();
    const addr = multiaddr('/ip4/1.2.3.4/tcp/1234');
    const results: MergeAddrsResult[] = [];

    for (let elapsed = 0; elapsed <= 200 * 60_000; elapsed += TEN_MIN_MS) {
      // The control: the same address, the same cadence, straight through
      // peerStore.merge with no workaround.
      await store.merge(plainPeerId, { multiaddrs: [addr] });
      results.push(await mergePeerAddrs(host, peerId, [addr]));
      expect(await storedAddrs(store, peerId)).toEqual([addr.toString()]);
      advance(TEN_MIN_MS);
    }

    // The workaround did fire — and only after the address actually fell off,
    // not on every pass.
    expect(results).toContain('restamped');
    expect(results.filter((r) => r === 'restamped').length).toBeLessThan(results.length);
    expect(results.every((r) => r === 'merged' || r === 'restamped')).toBe(true);
    // The bug the workaround exists for: re-merging never revives the address.
    expect(await storedAddrs(store, plainPeerId)).toEqual([]);
  });

  it('a restamp carries protocols, metadata, tags and the peer-record envelope forward', async () => {
    const { host, store, peerId } = await fixture();
    const addr = multiaddr('/ip4/1.2.3.4/tcp/1234');
    const envelope = Uint8Array.from([1, 2, 3, 4]);
    await store.merge(peerId, {
      multiaddrs: [addr],
      protocols: ['/optimystic/control-p/cluster/1.0.0'],
      metadata: new Map([['agent', Uint8Array.from([9])]]),
      tags: new Map([['keep-alive', { value: 42 }]]),
      peerRecordEnvelope: envelope
    });

    // Past MAX_ADDRESS_AGE, so the merge alone reads back empty and the helper
    // takes the `save` path — which drops every field it is not handed.
    advance(HOUR_MS + 60_000);
    await expect(mergePeerAddrs(host, peerId, [addr])).resolves.toBe('restamped');

    const peer = await store.get(peerId);
    expect(peer.addresses.map((a) => a.multiaddr.toString())).toEqual([addr.toString()]);
    expect(peer.protocols).toEqual(['/optimystic/control-p/cluster/1.0.0']);
    expect(peer.metadata.get('agent')).toEqual(Uint8Array.from([9]));
    expect(peer.tags.get('keep-alive')?.value).toBe(42);
    expect(peer.peerRecordEnvelope).toEqual(envelope);
  });

  it('a restamp revives every address it is handed, including one merged after the freeze', async () => {
    const { host, store, peerId } = await fixture();
    const aged = multiaddr('/ip4/1.2.3.4/tcp/1234');
    const added = multiaddr('/ip4/5.6.7.8/tcp/5678');
    await store.merge(peerId, { multiaddrs: [aged] });

    advance(HOUR_MS + 60_000);
    // A brand-new address inherits the frozen timestamp too, so it is invisible
    // the moment it lands — the helper must revive both.
    await expect(mergePeerAddrs(host, peerId, [aged, added])).resolves.toBe('restamped');

    expect(new Set(await storedAddrs(store, peerId)))
      .toEqual(new Set([aged.toString(), added.toString()]));
  });

  it('folds a failing merge into "failed" rather than throwing', async () => {
    const host = {
      peerStore: { merge: async () => { throw new Error('datastore boom'); } }
    } as unknown as PeerAddrBookHost;

    await expect(mergePeerAddrs(host, await freshPeerId(), [multiaddr('/ip4/1.2.3.4/tcp/1234')]))
      .resolves.toBe('failed');
  });

  it('folds a failing restamp into "failed" rather than throwing', async () => {
    // A peerStore double that merges but cannot save — also the shape of a
    // partial test double that never implemented `save` at all.
    const host = {
      peerStore: {
        merge: async () => ({ addresses: [], protocols: [], metadata: new Map(), tags: new Map() }),
        save: async () => { throw new Error('datastore boom'); }
      }
    } as unknown as PeerAddrBookHost;

    await expect(mergePeerAddrs(host, await freshPeerId(), [multiaddr('/ip4/1.2.3.4/tcp/1234')]))
      .resolves.toBe('failed');
  });
});
