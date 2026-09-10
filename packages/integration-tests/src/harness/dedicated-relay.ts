/**
 * A DEDICATED, ungated circuit-relay server for scenarios — the loopback stand-in
 * for the standalone relay container `ops/docker/libp2p-infra` deploys
 * (`src/main.ts`, `SEREUS_ROLE=relay`). Distinct from the relay every
 * storage-profile `CadreNode` runs: this one is a bare libp2p node with NO
 * membership gate and NO cadre protocols, so it relays for anyone and answers no
 * strand-addr RPC — exactly the posture of the deployed infrastructure relay.
 *
 * CONFIG PARITY WITH THE OPS CONTAINER IS THE FIXTURE'S CONTRACT. The scenarios
 * built on it (`strand-circuit-same-party-e2e` first) exist to prove that cadre
 * traffic survives the relay the ops stack actually deploys, so the load-bearing
 * settings here must track `ops/docker/libp2p-infra/src/main.ts`:
 *
 * - `applyDefaultLimit: false` — WITHOUT this every reservation carries libp2p's
 *   default ~128 KiB / 2 min `Limit`, the relayed connection is marked "limited",
 *   and `@optimystic/db-p2p`'s database protocols (which do not set
 *   `runOnLimitedConnection`) are refused on it — no strand data could ever cross
 *   the circuit. The ops container ships the same `false`
 *   (`RELAY_APPLY_DEFAULT_LIMIT`).
 * - `maxReservations` raised past libp2p's default of 15 (ops default 500) — one
 *   machine costs one slot per strand it serves PLUS one for its control node,
 *   so the default exhausts fast.
 * - stock `identify()` — the deployed relay runs un-namespaced identify, which a
 *   cadre node (namespaced identify) can never speak; scenarios must not depend
 *   on identify between a cadre node and this relay working.
 * - WebSocket listener — what phones (and this suite's control nodes) dial.
 *
 * Deliberate divergences from the container, none load-bearing for relaying:
 * no raw-TCP listener (every harness node dials WebSockets), no `ping()` service
 * (keepalive diagnostics; not part of the reservation or hop path, and not a
 * workspace dependency), no on-disk identity key (`restart()` keeps the key in
 * memory instead).
 */

import { createLibp2p, type Libp2p } from 'libp2p';
import { webSockets } from '@libp2p/websockets';
import { noise } from '@chainsafe/libp2p-noise';
import { yamux } from '@chainsafe/libp2p-yamux';
import { identify } from '@libp2p/identify';
import { circuitRelayServer, type CircuitRelayService } from '@libp2p/circuit-relay-v2';
import { generateKeyPair } from '@libp2p/crypto/keys';
import type { PrivateKey } from '@libp2p/interface';

/** Generous slot cap, mirroring the ops container's raised default (500). */
const DEFAULT_MAX_RESERVATIONS = 100;

export interface DedicatedRelayOptions {
  /** Concurrent reservation cap (default {@link DEFAULT_MAX_RESERVATIONS}). */
  maxReservations?: number;
}

export interface DedicatedRelay {
  /** The live relay libp2p node (rebuilt by {@link DedicatedRelay.restart}). */
  readonly node: Libp2p;
  /** The relay's peerId — stable across {@link DedicatedRelay.restart}. */
  readonly peerId: string;
  /**
   * The WebSocket dial addr INCLUDING the trailing `/p2p/<relayPeerId>` — the
   * exact string a scenario puts in `network.relayAddrs`. Stable across
   * {@link restart} (same key, same port).
   */
  readonly dialAddr: string;
  /**
   * Reservations currently held at this relay — one per reserving peerId. The
   * per-strand relay-slot cost measurement: every machine costs one slot for its
   * control node plus one per strand it serves through this relay.
   */
  reservationCount(): number;
  /**
   * Stop and re-create the relay with the SAME identity key on the SAME port —
   * the "relay restarted" fault, from a client's point of view: every held
   * reservation and every relayed connection is gone, but the address that named
   * the relay still works. Loopback-only trick: the freed port is re-bound
   * immediately, which a real deployment's supervisor does too.
   */
  restart(): Promise<void>;
  stop(): Promise<void>;
}

/** The relay's circuit-relay service, for the reservation store. */
function relayService(node: Libp2p): CircuitRelayService {
  return (node.services as { relay: CircuitRelayService }).relay;
}

async function createRelayNode(
  privateKey: PrivateKey,
  listenAddr: string,
  maxReservations: number
): Promise<Libp2p> {
  return await createLibp2p({
    privateKey,
    addresses: { listen: [listenAddr] },
    transports: [webSockets()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    services: {
      identify: identify(),
      relay: circuitRelayServer({
        reservations: {
          applyDefaultLimit: false,
          maxReservations
        }
      })
    }
  });
}

/**
 * Start a dedicated relay on an ephemeral loopback WebSocket port. Caller owns
 * shutdown (`relay.stop()`).
 */
export async function startDedicatedRelay(opts: DedicatedRelayOptions = {}): Promise<DedicatedRelay> {
  const maxReservations = opts.maxReservations ?? DEFAULT_MAX_RESERVATIONS;
  const privateKey = await generateKeyPair('Ed25519');

  let node = await createRelayNode(privateKey, '/ip4/127.0.0.1/tcp/0/ws', maxReservations);
  const dialAddr = node.getMultiaddrs().map(String).find((a) => a.includes('/ws'));
  if (dialAddr === undefined) {
    await node.stop();
    throw new Error('dedicated relay bound no WebSocket listener');
  }
  // The OS-assigned listen entry, re-bound verbatim by restart() so dialAddr
  // stays true. dialAddr is `<listen>/p2p/<peerId>`; strip the p2p suffix.
  const listenAddr = dialAddr.slice(0, dialAddr.indexOf('/p2p/'));

  return {
    get node() {
      return node;
    },
    peerId: node.peerId.toString(),
    dialAddr,
    reservationCount() {
      return relayService(node).reservations.size;
    },
    async restart() {
      await node.stop();
      node = await createRelayNode(privateKey, listenAddr, maxReservations);
    },
    async stop() {
      await node.stop();
    }
  };
}
