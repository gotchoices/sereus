import { describe, it, expect, afterEach } from 'vitest';
import { createLibp2p, type Libp2p } from 'libp2p';
import { tcp } from '@libp2p/tcp';
import { noise } from '@chainsafe/libp2p-noise';
import { yamux } from '@chainsafe/libp2p-yamux';
import { identify } from '@libp2p/identify';
import { circuitRelayServer, circuitRelayTransport } from '@libp2p/circuit-relay-v2';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { multiaddr } from '@multiformats/multiaddr';
import { CadreNode } from '../src/cadre-node.js';
import type { CadreNodeConfig } from '../src/types.js';
import {
  circuitMultiaddrs,
  driveRelayReservation,
  resolveRelayReservationState
} from '../src/relay-reservation.js';

/**
 * Relay reservation through the bare `/p2p-circuit` SEARCH listener: the status
 * precedence (pure), the loopback drive (real relay), and the regression this
 * module exists for — a reservation lost after a successful drive must stop
 * reporting `reserved`, because the status is derived from the node's LIVE
 * multiaddrs rather than a snapshot taken at drive time.
 */

const CIRCUIT_ADDR =
  '/ip4/127.0.0.1/tcp/4001/p2p/12D3KooWSHj3RRbBjD15g6wekV8y3mdevbrifQRQXMhQdgTrZQqR/p2p-circuit/p2p/12D3KooWLbtPS3XvCFCJmYQAKtsUJ9jSmMGH6HXsRXKA1JgTQZ8h';

/** A stand-in libp2p node that advertises exactly the given multiaddrs. */
function fakeNode(addrs: readonly string[]): Libp2p {
  return { getMultiaddrs: () => addrs.map((addr) => multiaddr(addr)) } as unknown as Libp2p;
}

describe('resolveRelayReservationState (precedence)', () => {
  it('reports none when no relay addrs were supplied, whatever else is true', () => {
    // Empty addrs beats everything: a live circuit addr, a stale error, and an
    // in-flight drive all lose to "nobody asked for a reservation".
    const state = resolveRelayReservationState(fakeNode([CIRCUIT_ADDR]), [], 'boom', true);
    expect(state).toEqual({ status: 'none', addrs: [], circuitAddrs: [], error: null });
  });

  it('reports reserved when circuit addrs are held', () => {
    const state = resolveRelayReservationState(fakeNode([CIRCUIT_ADDR]), ['/relay'], null, false);
    expect(state.status).toBe('reserved');
    expect(state.circuitAddrs).toEqual([CIRCUIT_ADDR]);
    expect(state.addrs).toEqual(['/relay']);
    expect(state.error).toBeNull();
  });

  it('lets a live reservation supersede a stale error', () => {
    const state = resolveRelayReservationState(
      fakeNode([CIRCUIT_ADDR]),
      ['/relay'],
      'no circuit reservation within 10000ms',
      false
    );
    expect(state.status).toBe('reserved');
    expect(state.error).toBeNull();
  });

  it('reports dialing while a drive is in flight and nothing is reserved', () => {
    const state = resolveRelayReservationState(fakeNode([]), ['/relay'], null, true);
    expect(state.status).toBe('dialing');
    expect(state.circuitAddrs).toEqual([]);
  });

  it('prefers reserved over dialing when both could apply', () => {
    const state = resolveRelayReservationState(fakeNode([CIRCUIT_ADDR]), ['/relay'], null, true);
    expect(state.status).toBe('reserved');
  });

  it('reports error with the last failure when no drive is in flight', () => {
    const state = resolveRelayReservationState(fakeNode([]), ['/relay'], 'dial refused', false);
    expect(state).toEqual({
      status: 'error',
      addrs: ['/relay'],
      circuitAddrs: [],
      error: 'dial refused'
    });
  });

  it('reports error with a fallback reason when no failure was recorded', () => {
    const state = resolveRelayReservationState(fakeNode([]), ['/relay'], null, false);
    expect(state.status).toBe('error');
    expect(state.error).toBeTruthy();
  });

  it('reports error when there is no node at all', () => {
    const state = resolveRelayReservationState(null, ['/relay'], 'control node unavailable', false);
    expect(state.status).toBe('error');
    expect(state.error).toBe('control node unavailable');
  });

  it('ignores non-circuit multiaddrs when deciding reserved', () => {
    const state = resolveRelayReservationState(
      fakeNode(['/ip4/127.0.0.1/tcp/4001']),
      ['/relay'],
      null,
      false
    );
    expect(state.status).toBe('error');
    expect(state.circuitAddrs).toEqual([]);
  });
});

describe('CadreNode.reserveRelays before start', () => {
  it('is fail-soft when there is no control node', async () => {
    const config: CadreNodeConfig = {
      controlNetwork: { partyId: 'relay-reservation-test', bootstrapNodes: [] },
      profile: 'transaction'
    };
    const node = new CadreNode(config);
    const state = await node.reserveRelays(['/ip4/127.0.0.1/tcp/1/p2p/anything']);
    expect(state.status).toBe('error');
    expect(state.error).toBe('control node unavailable');
    // And resetting to an empty list clears the posture rather than sticking.
    expect((await node.reserveRelays([])).status).toBe('none');
  });

  it('treats an empty relay list as none without dialing or waiting', async () => {
    const config: CadreNodeConfig = {
      controlNetwork: { partyId: 'relay-reservation-test-empty', bootstrapNodes: [] },
      profile: 'transaction'
    };
    const node = new CadreNode(config);
    const started = Date.now();
    const state = await node.reserveRelays([]);
    expect(state).toEqual({ status: 'none', addrs: [], circuitAddrs: [], error: null });
    // The solo browser tab takes this path on every boot — it must be instant, not
    // a walk to the reservation timeout.
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});

describe('driveRelayReservation over a loopback relay', () => {
  const nodes: Libp2p[] = [];

  afterEach(async () => {
    // A relay stopped mid-test is already down; swallow the second stop.
    await Promise.all(
      nodes.map(async (node) => {
        try {
          await node.stop();
        } catch {
          /* already stopped */
        }
      })
    );
    nodes.length = 0;
  });

  async function startRelay(): Promise<Libp2p> {
    const relay = await createLibp2p({
      addresses: { listen: ['/ip4/127.0.0.1/tcp/0'] },
      transports: [tcp()],
      connectionEncrypters: [noise()],
      streamMuxers: [yamux()],
      services: { identify: identify(), relay: circuitRelayServer() }
    });
    nodes.push(relay);
    return relay;
  }

  /**
   * A browser-shaped client: listens on the BARE `/p2p-circuit` search addr, so
   * it never fails to start when a relay is unreachable and it only reserves once
   * something dials a relay into its peer store — which is what
   * {@link driveRelayReservation} does.
   */
  async function startSearchClient(): Promise<Libp2p> {
    const node = await createLibp2p({
      addresses: { listen: ['/p2p-circuit'] },
      transports: [tcp(), circuitRelayTransport()],
      connectionEncrypters: [noise()],
      streamMuxers: [yamux()],
      services: { identify: identify() }
    });
    nodes.push(node);
    return node;
  }

  /** A syntactically valid relay addr with nothing listening behind it. */
  async function deadRelayAddr(): Promise<string> {
    const key = await generateKeyPair('Ed25519');
    return `/ip4/127.0.0.1/tcp/1/p2p/${peerIdFromPrivateKey(key).toString()}`;
  }

  async function waitFor(cond: () => boolean, what: string, timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!cond()) {
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  it('reserves through a live relay and reports it live', async () => {
    const relay = await startRelay();
    const client = await startSearchClient();

    const { error } = await driveRelayReservation(
      client,
      [relay.getMultiaddrs()[0].toString()],
      { timeoutMs: 10_000, pollMs: 100 }
    );
    expect(error).toBeNull();
    expect(circuitMultiaddrs(client).length).toBeGreaterThan(0);
    expect(resolveRelayReservationState(client, ['relay'], null, false).status).toBe('reserved');
  });

  it('stops reporting reserved once the reservation is lost', async () => {
    // The finding-3 regression: status used to be computed once at drive time, so a
    // relay that went away left the node claiming `reserved` forever — and minting
    // invitations carrying circuit addresses that no longer route.
    const relay = await startRelay();
    const client = await startSearchClient();
    const relayAddr = relay.getMultiaddrs()[0].toString();

    await driveRelayReservation(client, [relayAddr], { timeoutMs: 10_000, pollMs: 100 });
    expect(resolveRelayReservationState(client, [relayAddr], null, false).status).toBe('reserved');

    await relay.stop();
    await waitFor(() => circuitMultiaddrs(client).length === 0, 'circuit addrs to drain');

    const after = resolveRelayReservationState(client, [relayAddr], null, false);
    expect(after.status).toBe('error');
    expect(after.circuitAddrs).toEqual([]);
  });

  it('fails soft against an unreachable relay and leaves the node running', async () => {
    const client = await startSearchClient();

    const started = Date.now();
    const { error } = await driveRelayReservation(client, [await deadRelayAddr()], {
      timeoutMs: 2_000,
      pollMs: 100
    });
    expect(error).not.toBeNull();
    expect(Date.now() - started).toBeLessThan(20_000);
    // Fail-soft is the whole point: the node must still be up afterwards.
    expect(client.status).toBe('started');
    expect(circuitMultiaddrs(client)).toEqual([]);
  });

  it('still reserves on a live relay when another relay in the list is dead', async () => {
    // Guards against an early return/throw in the dial loop: one dead relay must
    // not cost the reservation on the live one.
    const relay = await startRelay();
    const client = await startSearchClient();

    const { error } = await driveRelayReservation(
      client,
      [await deadRelayAddr(), relay.getMultiaddrs()[0].toString()],
      { timeoutMs: 10_000, pollMs: 100 }
    );
    expect(error).toBeNull();
    expect(circuitMultiaddrs(client).length).toBeGreaterThan(0);
  });
});
