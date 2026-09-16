import { describe, it, expect } from 'vitest';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { MemoryRawStorage } from '@optimystic/db-p2p';
import { CadreNode } from '../src/cadre-node.js';

/**
 * `network.requireRelay: false` softens `network.relayAddrs`'s boot-time fail-fast
 * contract (`RelayReservationFailedError`, pinned unmodified by
 * `cadre-node-relay-boot-failure.spec.ts`) for a node that must still boot with no
 * network — a phone or a browser tab that names its relay in config rather than
 * discovering it at runtime via `CadreNode.reserveRelays()`.
 *
 * See `driveControlRelayReservation` (`cadre-node.ts`) and the `requireRelay` doc
 * comment on `NetworkConfig` (`types.ts`).
 */
describe('CadreNode start() with network.requireRelay: false', () => {
  /** A relay peerId nothing is listening for, on a port that refuses immediately. */
  async function deadRelayAddr(): Promise<string> {
    const relayKey = await generateKeyPair('Ed25519');
    return `/ip4/127.0.0.1/tcp/1/p2p/${peerIdFromPrivateKey(relayKey).toString()}`;
  }

  async function nodeWithDeadRelay(): Promise<CadreNode> {
    return new CadreNode({
      controlNetwork: { partyId: 'relay-optional-' + Math.random().toString(36).slice(2), bootstrapNodes: [] },
      privateKey: await generateKeyPair('Ed25519'),
      profile: 'transaction',
      strandFilter: { mode: 'none' },
      storage: { provider: () => new MemoryRawStorage() },
      network: { listenAddrs: [], relayAddrs: [await deadRelayAddr()], requireRelay: false }
    });
  }

  it('starts despite a dead relay, leaving the retry supervisor driving in the background', async () => {
    const node = await nodeWithDeadRelay();

    await expect(node.start()).resolves.toBeUndefined();

    expect(node.isRunning).toBe(true);
    expect(node.getControlDatabase()).not.toBeNull();
    const state = node.getRelayReservationState();
    // Not `error`/`none`: the supervisor the failed first attempt started is still
    // scheduled to try again, which is what makes this posture recoverable rather
    // than merely non-fatal.
    expect(state.status).toBe('retrying');
    expect(state.retryAtMs).not.toBeNull();

    await node.stop();
  }, 60_000);

  it('stop() tears the retry supervisor down, clearing the posture to none', async () => {
    const node = await nodeWithDeadRelay();
    await node.start();

    await expect(node.stop()).resolves.toBeUndefined();

    expect(node.isRunning).toBe(false);
    // `none`, not `retrying`: a stopped node must leave nothing still dialing the
    // relay in the background.
    expect(node.getRelayReservationState().status).toBe('none');
  }, 60_000);

  it('still throws on a malformed relayAddrs entry — the validation half is not softened', async () => {
    const node = new CadreNode({
      controlNetwork: { partyId: 'relay-optional-malformed-' + Math.random().toString(36).slice(2), bootstrapNodes: [] },
      privateKey: await generateKeyPair('Ed25519'),
      profile: 'transaction',
      strandFilter: { mode: 'none' },
      storage: { provider: () => new MemoryRawStorage() },
      network: { listenAddrs: [], relayAddrs: ['/ip4/1.2.3.4/tcp/4001'], requireRelay: false }
    });

    await expect(node.start()).rejects.toThrow(/network\.relayAddrs entry names no relay peerId/);
    expect(node.isRunning).toBe(false);
  }, 60_000);
});
