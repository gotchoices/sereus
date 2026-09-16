import { describe, it, expect, afterEach } from 'vitest';
import { createLibp2p, type Libp2p } from 'libp2p';
import { tcp } from '@libp2p/tcp';
import { noise } from '@chainsafe/libp2p-noise';
import { yamux } from '@chainsafe/libp2p-yamux';
import { identify } from '@libp2p/identify';
import { circuitRelayServer } from '@libp2p/circuit-relay-v2';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import type { PrivateKey } from '@libp2p/interface';
import { MemoryRawStorage } from '@optimystic/db-p2p';
import { CadreNode } from '../src/cadre-node.js';
import { deadRelayAddr, freePort } from './relay-test-addrs.js';

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
  const relays: Libp2p[] = [];

  afterEach(async () => {
    await Promise.all(relays.map(async (relay) => {
      try {
        await relay.stop();
      } catch {
        // A relay a test already stopped is not a teardown failure.
      }
    }));
    relays.length = 0;
  });

  /** The tolerant posture over whatever relay list the case is about. */
  async function nodeWithRelays(relayAddrs: string[]): Promise<CadreNode> {
    return new CadreNode({
      controlNetwork: { partyId: 'relay-optional-' + Math.random().toString(36).slice(2), bootstrapNodes: [] },
      privateKey: await generateKeyPair('Ed25519'),
      profile: 'transaction',
      strandFilter: { mode: 'none' },
      storage: { provider: () => new MemoryRawStorage() },
      network: { listenAddrs: [], relayAddrs, requireRelay: false }
    });
  }

  it('starts despite a dead relay, leaving the retry supervisor driving in the background', async () => {
    const node = await nodeWithRelays([await deadRelayAddr()]);

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
    const node = await nodeWithRelays([await deadRelayAddr()]);
    await node.start();

    await expect(node.stop()).resolves.toBeUndefined();

    expect(node.isRunning).toBe(false);
    // `none`, not `retrying`: a stopped node must leave nothing still dialing the
    // relay in the background.
    expect(node.getRelayReservationState().status).toBe('none');
  }, 60_000);

  it('still throws on a malformed relayAddrs entry — the validation half is not softened', async () => {
    const node = await nodeWithRelays(['/ip4/1.2.3.4/tcp/4001']);

    await expect(node.start()).rejects.toThrow(/network\.relayAddrs entry names no relay peerId/);
    expect(node.isRunning).toBe(false);
  }, 60_000);

  /**
   * The point of the posture, and the half a tolerated start cannot prove on its
   * own: the supervisor `driveControlRelayReservation` left running is the LIVE one,
   * so a node that booted with its relay down becomes dialable the moment the relay
   * appears — with nobody calling `reserveRelays()`.
   *
   * The relay is started at a pre-reserved port under a pre-generated key, so the
   * node can name it in config before anything listens there
   * (`relay-reservation.spec.ts` does the same for its supervisor-level specs; that
   * file proves recovery over the free-function seam, this one over `CadreNode`'s).
   */
  it('reserves on its own once the relay it named finally comes up', async () => {
    const relayKey = await generateKeyPair('Ed25519');
    const port = await freePort();
    const relayAddr = `/ip4/127.0.0.1/tcp/${port}/p2p/${peerIdFromPrivateKey(relayKey).toString()}`;
    const node = await nodeWithRelays([relayAddr]);

    await node.start();
    try {
      expect(node.getRelayReservationState().status).toBe('retrying');

      // The only thing this test does from here: the reservation must come back on
      // the supervisor's own backoff (2 s doubling, `relay-reservation.ts`).
      await startRelay(relayKey, port);
      await waitFor(
        () => node.getRelayReservationState().status === 'reserved',
        'the tolerated node to reserve once its relay came up',
        30_000
      );

      const circuitAddrs = (node.getControlNode()?.getMultiaddrs() ?? [])
        .map((addr) => addr.toString())
        .filter((addr) => addr.includes('/p2p-circuit'));
      expect(circuitAddrs.length).toBeGreaterThan(0);
    } finally {
      await node.stop();
    }
  }, 90_000);

  /**
   * The other half of "the supervisor is live": a tolerated start leaves one running,
   * and a later `reserveRelays()` — the runtime-discovery route — must REPLACE it
   * rather than leave two loops fighting over the node's single pending reservation
   * slot (`CadreNode.reserveRelays` stops first, unconditionally).
   */
  it('hands the reservation over to a later reserveRelays() call', async () => {
    const node = await nodeWithRelays([await deadRelayAddr()]);

    await node.start();
    try {
      const relayKey = await generateKeyPair('Ed25519');
      const port = await freePort();
      const relay = await startRelay(relayKey, port);
      const relayAddr = relay.getMultiaddrs()[0].toString();

      const state = await node.reserveRelays([relayAddr]);

      expect(state.status).toBe('reserved');
      // The boot list is gone, not merged: the posture is about the newest list only.
      expect(state.addrs).toEqual([relayAddr]);
      // Still reserved a beat later — nothing from the boot supervisor re-drove over it.
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      expect(node.getRelayReservationState().status).toBe('reserved');
    } finally {
      await node.stop();
    }
  }, 90_000);

  /** A relay at an exact peer id and port, so it can be named before it exists. */
  async function startRelay(privateKey: PrivateKey, port: number): Promise<Libp2p> {
    const relay = await createLibp2p({
      addresses: { listen: [`/ip4/127.0.0.1/tcp/${port}`] },
      privateKey,
      transports: [tcp()],
      connectionEncrypters: [noise()],
      streamMuxers: [yamux()],
      services: { identify: identify(), relay: circuitRelayServer() }
    });
    relays.push(relay);
    return relay;
  }
});

async function waitFor(cond: () => boolean, what: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
