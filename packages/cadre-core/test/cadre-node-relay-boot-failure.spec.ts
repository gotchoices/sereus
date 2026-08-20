import { describe, it, expect } from 'vitest';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { MemoryRawStorage } from '@optimystic/db-p2p';
import { CadreNode } from '../src/cadre-node.js';
import { RelayReservationFailedError } from '../src/relay-addrs.js';
import type { CadreNodeEvents } from '../src/types.js';

/**
 * `network.relayAddrs` is fail-fast: `CadreNode.start()` drives the reservation at the
 * very end of bring-up and throws {@link RelayReservationFailedError} when the first
 * attempt lands no `/p2p-circuit` address (`driveControlRelayReservation`).
 *
 * That throw is the FIRST one in `start()` that happens after `_running` is set and
 * `control:connected` is emitted, which makes it the case that pins what a failed start
 * has to leave behind: nothing. Before this was pinned, `cleanup()` did not own the whole
 * teardown — `stop()` held the relay-supervisor half and the `_running` reset — so a node
 * whose relay was down reported `isRunning === true` over a torn-down libp2p node (making
 * an embedder's retry a silent no-op, since `start()` early-returns when running) and left
 * a reservation retry loop dialing a stopped node forever.
 */
describe('CadreNode start() failing on its relay reservation', () => {
  /** A relay peerId nothing is listening for, on a port that refuses immediately. */
  async function deadRelayAddr(): Promise<string> {
    const relayKey = await generateKeyPair('Ed25519');
    return `/ip4/127.0.0.1/tcp/1/p2p/${peerIdFromPrivateKey(relayKey).toString()}`;
  }

  async function nodeWithDeadRelay(): Promise<CadreNode> {
    return new CadreNode({
      controlNetwork: { partyId: 'relay-boot-failure-' + Math.random().toString(36).slice(2), bootstrapNodes: [] },
      privateKey: await generateKeyPair('Ed25519'),
      profile: 'transaction',
      strandFilter: { mode: 'none' },
      storage: { provider: () => new MemoryRawStorage() },
      // No direct listener either, so the reservation is the node's only reachability —
      // the shape an operator who names a relay is actually describing.
      network: { listenAddrs: [], relayAddrs: [await deadRelayAddr()] }
    });
  }

  it('rejects, and leaves the node stopped with its reservation posture cleared', async () => {
    const node = await nodeWithDeadRelay();
    const events: (keyof CadreNodeEvents)[] = [];
    node.on('control:connected', () => { events.push('control:connected'); });
    node.on('control:disconnected', () => { events.push('control:disconnected'); });

    await expect(node.start()).rejects.toThrow(RelayReservationFailedError);

    expect(node.isRunning).toBe(false);
    // `none`, not `error`/`retrying`: the supervisor is stopped and the addrs dropped,
    // so nothing is still dialing and no caller reads a posture for a node that is gone.
    expect(node.getRelayReservationState().status).toBe('none');
    expect(node.getControlDatabase()).toBeNull();
    // The connected edge was emitted before the drive, so its partner must follow —
    // an embedder driving UI off these events cannot be left showing "connected".
    expect(events).toEqual(['control:connected', 'control:disconnected']);
  }, 60_000);

  it('can be started again — the failure is not sticky', async () => {
    const node = await nodeWithDeadRelay();

    await expect(node.start()).rejects.toThrow(RelayReservationFailedError);
    // The second call must REACH the relay again rather than early-returning "already
    // running" and resolving as if the node had come up.
    await expect(node.start()).rejects.toThrow(RelayReservationFailedError);
    expect(node.isRunning).toBe(false);
  }, 120_000);
});
