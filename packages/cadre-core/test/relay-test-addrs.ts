import { createServer } from 'node:net';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';

/**
 * The relay addresses and ports the relay specs are written against, in one place:
 * `relay-reservation.spec.ts` (the drive and supervisor seams),
 * `cadre-node-relay-boot-failure.spec.ts` (the fail-fast boot) and
 * `cadre-node-relay-optional.spec.ts` (the `requireRelay: false` boot) all need the
 * same "a relay that is not there" and "a port nothing holds yet" primitives, and
 * they have to agree on WHICH not-there they mean — refused fast versus hanging is
 * the difference between exercising the error path and exercising the deadline.
 */

/** A syntactically valid relay addr with nothing listening behind it (refused fast). */
export async function deadRelayAddr(): Promise<string> {
  const key = await generateKeyPair('Ed25519');
  return `/ip4/127.0.0.1/tcp/1/p2p/${peerIdFromPrivateKey(key).toString()}`;
}

/**
 * A relay addr in RFC 5737 TEST-NET-1, which is routed nowhere: a dial to it
 * HANGS rather than being refused, so it exercises the deadline instead of the
 * connection-refused path {@link deadRelayAddr} takes.
 */
export async function blackholeRelayAddr(port: number): Promise<string> {
  const key = await generateKeyPair('Ed25519');
  return `/ip4/192.0.2.1/tcp/${port}/p2p/${peerIdFromPrivateKey(key).toString()}`;
}

/**
 * A TCP port nothing is listening on: bind `:0`, read what the OS assigned,
 * release it, hand it on. Deliberately NOT a hard-coded port — spec files run in
 * parallel and would collide on one.
 */
export function freePort(): Promise<number> {
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
