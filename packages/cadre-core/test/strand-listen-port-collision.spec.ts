import { describe, it, expect, afterEach } from 'vitest';
import { createServer } from 'node:net';
import { createLibp2p, type Libp2p } from 'libp2p';
import { tcp } from '@libp2p/tcp';
import { noise } from '@chainsafe/libp2p-noise';
import { yamux } from '@chainsafe/libp2p-yamux';
import { multiaddr } from '@multiformats/multiaddr';
import { resolveListenAddrs } from '../src/relay-addrs.js';
import { strandNodeAddrs } from '../src/strand-network-config.js';
import type { NetworkConfig } from '../src/types.js';

/**
 * The claim `strand-network-config.ts` exists for, checked against a real TCP stack
 * rather than asserted: one machine, one operator `NetworkConfig` naming a FIXED
 * listen port, one control node plus two strand nodes.
 *
 * The first case is the failure mode itself — a second libp2p node handed the control
 * node's own resolved listen addrs cannot start. It is what made a fixed-port config
 * (`cadre-cli` ships `/ip4/0.0.0.0/tcp/4001` in its example) unable to run any strand
 * at all. The second is the fix: the strand-node derivation of the same config starts
 * both strands beside the control node, each on its own OS-assigned port.
 *
 * Deliberately plain libp2p nodes rather than `CadreNode`s — the contended resource is
 * a TCP socket, and a cadre node would drag a control database and a cohort into a
 * question that is entirely about bind().
 */

const nodes: Libp2p[] = [];

afterEach(async () => {
  await Promise.all(nodes.splice(0).map((node) => node.stop()));
});

describe('fixed-port listenAddrs across the nodes one machine runs', () => {
  it('cannot start a second node on the control node\'s own resolved listen addrs', async () => {
    const network = await fixedPortNetwork();
    const controlAddrs = resolveListenAddrs(network, 'search');

    await startNode(controlAddrs);

    // The pre-fix behaviour of every strand node on the machine, reproduced exactly:
    // the strand node used to receive this same list.
    await expect(startNode(controlAddrs)).rejects.toThrow(/EADDRINUSE|address already in use/i);
  });

  it('starts the control node and two strand nodes on one machine, each on its own port', async () => {
    const network = await fixedPortNetwork();
    const fixedPort = boundPorts(resolveListenAddrs(network, 'search') ?? [])[0]!;

    const control = await startNode(resolveListenAddrs(network, 'search'));
    const strandA = await startNode(strandNodeAddrs(network).listenAddrs);
    const strandB = await startNode(strandNodeAddrs(network).listenAddrs);

    // The control node still binds exactly what the operator configured — the
    // derivation changes the strand nodes and nothing else.
    expect(listeningPorts(control)).toEqual([fixedPort]);

    const [portA] = listeningPorts(strandA);
    const [portB] = listeningPorts(strandB);
    expect(portA).toBeGreaterThan(0);
    expect(portB).toBeGreaterThan(0);
    expect(portA).not.toBe(fixedPort);
    expect(portB).not.toBe(fixedPort);
    expect(portA).not.toBe(portB);
  });

  /**
   * A host that opts out of listening keeps that on every node it runs — the rewrite
   * must not hand a React Native strand node a listener the control node does not have.
   */
  it('starts strand nodes for a listen-nothing config without giving them a listener', async () => {
    const network: NetworkConfig = { listenAddrs: [] };

    const strand = await startNode(strandNodeAddrs(network).listenAddrs);

    expect(strand.getMultiaddrs()).toEqual([]);
  });
});

/** A `NetworkConfig` naming one fixed loopback TCP port, the way an operator would. */
async function fixedPortNetwork(): Promise<NetworkConfig> {
  return { listenAddrs: [`/ip4/127.0.0.1/tcp/${await freePort()}`] };
}

/** A started libp2p node listening on `listenAddrs`, registered for teardown. */
async function startNode(listenAddrs: string[] | undefined): Promise<Libp2p> {
  const node = await createLibp2p({
    addresses: { listen: listenAddrs ?? [] },
    transports: [tcp()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()]
  });
  nodes.push(node);
  return node;
}

/** The TCP ports `node` actually bound, read back off its live multiaddrs. */
function listeningPorts(node: Libp2p): number[] {
  return boundPorts(node.getMultiaddrs().map((addr) => addr.toString()));
}

/** The `tcp` port component of each address, in order. */
function boundPorts(addrs: readonly string[]): number[] {
  return addrs.flatMap((addr) =>
    multiaddr(addr).getComponents()
      .filter((component) => component.name === 'tcp' && component.value !== undefined)
      .map((component) => Number(component.value))
  );
}

/**
 * A TCP port nothing is listening on: bind `:0`, read what the OS assigned, release
 * it, hand it on. Deliberately NOT a hard-coded port — spec files run in parallel and
 * would collide on one.
 */
function freePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const probe = createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      if (address === null || typeof address === 'string') {
        probe.close(() => reject(new Error('no TCP port was assigned')));
        return;
      }
      const { port } = address;
      probe.close(() => resolve(port));
    });
  });
}
