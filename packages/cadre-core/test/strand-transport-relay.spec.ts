import { describe, it, expect, afterEach } from 'vitest';
import { createLibp2p, type Libp2p } from 'libp2p';
import { tcp } from '@libp2p/tcp';
import { noise } from '@chainsafe/libp2p-noise';
import { yamux } from '@chainsafe/libp2p-yamux';
import { identify } from '@libp2p/identify';
import { circuitRelayServer, circuitRelayTransport } from '@libp2p/circuit-relay-v2';
import { generateKeyPair } from '@libp2p/crypto/keys';
import type { PrivateKey } from '@libp2p/interface';
import { multiaddr } from '@multiformats/multiaddr';
import { strandTransportKey } from '../src/strand-transport-key.js';

/**
 * Loopback regression test for github.com/gotchoices/sereus/issues/1: a
 * control node and a strand node sharing one private key (⇒ one peerId)
 * collide at a shared circuit relay — `@libp2p/circuit-relay-v2` keys
 * reservations and hop-connects by peerId, so relayed streams for one node
 * land on the other and its protocol fails to negotiate.
 *
 * Two halves so the test actually pins the bug:
 *  - shared key  ⇒ the two protocols can NOT both negotiate through one relay
 *  - derived key (`strandTransportKey`) ⇒ both negotiate
 */

const CONTROL_PROTOCOL = '/sereus-test/control/1.0.0';
const STRAND_PROTOCOL = '/sereus-test/strand/1.0.0';

const nodes: Libp2p[] = [];

afterEach(async () => {
  await Promise.all(nodes.map((node) => node.stop()));
  nodes.length = 0;
});

async function waitFor(cond: () => boolean, what: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function startRelay(): Promise<Libp2p> {
  const relay = await createLibp2p({
    addresses: { listen: ['/ip4/127.0.0.1/tcp/0'] },
    transports: [tcp()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    services: {
      identify: identify(),
      relay: circuitRelayServer()
    }
  });
  nodes.push(relay);
  return relay;
}

/**
 * A relay client standing in for a control/strand node: reserves on the given
 * relay (via the explicit `<relay>/p2p-circuit` listen addr) and answers one
 * protocol. `runOnLimitedConnection` because relayed connections are "limited".
 */
async function startClient(privateKey: PrivateKey, relayAddr: string, protocol: string): Promise<Libp2p> {
  const node = await createLibp2p({
    privateKey,
    addresses: { listen: [`${relayAddr}/p2p-circuit`] },
    transports: [tcp(), circuitRelayTransport()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    services: { identify: identify() }
  });
  nodes.push(node);
  await node.handle(protocol, (stream) => {
    void stream.close();
  }, { runOnLimitedConnection: true });
  await waitFor(
    () => node.getMultiaddrs().some((ma) => ma.toString().includes('/p2p-circuit')),
    `client relay reservation (${protocol})`
  );
  return node;
}

async function startDialer(): Promise<Libp2p> {
  const dialer = await createLibp2p({
    transports: [tcp(), circuitRelayTransport()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    services: { identify: identify() }
  });
  nodes.push(dialer);
  return dialer;
}

/** The client's advertised circuit multiaddr — what the strand-addr RPC would hand out. */
function circuitAddr(node: Libp2p): string {
  const addr = node.getMultiaddrs().find((ma) => ma.toString().includes('/p2p-circuit'));
  if (!addr) {
    throw new Error(`Node ${node.peerId} advertises no /p2p-circuit address`);
  }
  return addr.toString();
}

/** Dial `protocol` at `addr`; true iff protocol negotiation succeeds. */
async function canNegotiate(dialer: Libp2p, addr: string, protocol: string): Promise<boolean> {
  try {
    const stream = await dialer.dialProtocol(multiaddr(addr), protocol, { runOnLimitedConnection: true });
    await stream.close();
    return true;
  } catch (err) {
    console.warn(`dial ${protocol} failed: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

describe('strand transport identity over a shared circuit relay', () => {
  it('pins the bug: two nodes sharing one key are not both reachable', async () => {
    const relay = await startRelay();
    const relayAddr = relay.getMultiaddrs()[0].toString();

    const sharedKey = await generateKeyPair('Ed25519');
    const control = await startClient(sharedKey, relayAddr, CONTROL_PROTOCOL);
    const strand = await startClient(sharedKey, relayAddr, STRAND_PROTOCOL);

    // Both advertise the byte-identical circuit address — the RPC's answer is
    // indistinguishable from a control address.
    expect(circuitAddr(strand)).toBe(circuitAddr(control));

    const dialer = await startDialer();
    const controlOk = await canNegotiate(dialer, circuitAddr(control), CONTROL_PROTOCOL);
    const strandOk = await canNegotiate(dialer, circuitAddr(strand), STRAND_PROTOCOL);

    // The relay holds two connections under one peerId and always hands
    // relayed streams to one of them, so at most one protocol negotiates.
    expect(controlOk && strandOk).toBe(false);
  }, 30_000);

  it('derived per-strand keys make both nodes reachable through one relay', async () => {
    const relay = await startRelay();
    const relayAddr = relay.getMultiaddrs()[0].toString();

    const identityKey = await generateKeyPair('Ed25519');
    const derivedKey = await strandTransportKey(identityKey, 'strand-relay-regression');

    const control = await startClient(identityKey, relayAddr, CONTROL_PROTOCOL);
    const strand = await startClient(derivedKey, relayAddr, STRAND_PROTOCOL);

    // Distinct peerIds ⇒ distinct, genuinely-dialable circuit addresses.
    expect(circuitAddr(strand)).not.toBe(circuitAddr(control));

    const dialer = await startDialer();
    expect(await canNegotiate(dialer, circuitAddr(control), CONTROL_PROTOCOL)).toBe(true);
    expect(await canNegotiate(dialer, circuitAddr(strand), STRAND_PROTOCOL)).toBe(true);
  }, 30_000);
});
