/**
 * WebSocket Chat smoke test.
 *
 * Two CadreNode instances in one process:
 *   • Drone  — storage profile, WebSocket listener on 127.0.0.1
 *   • Phone  — transaction profile, WebSocket dialer, no listener
 *
 * Exercises the exact path the React Native app will take:
 *   1. Start both nodes (drone first, phone bootstraps from drone)
 *   2. Create the chat strand on both nodes
 *   3. Insert a message on the drone
 *   4. Verify the message replicates to the phone
 */

import { describe, it, expect, afterAll } from 'vitest';
import { webSockets } from '@libp2p/websockets';
import { circuitRelayTransport } from '@libp2p/circuit-relay-v2';
import { MemoryRawStorage } from '@optimystic/db-p2p';
import { CadreNode, signSchema } from '@serfab/cadre-core';
import type { CadreNodeConfig, StrandRow, StrandInstance, SAppConfig } from '@serfab/cadre-core';
import { generatePrivateKey, getPublicKey } from '@optimystic/quereus-plugin-crypto';
import { waitUntil, sleep } from '../harness/wait-utils.js';

// ── Chat schema (mirrors reference-app-rn/src/chat-strand.ts) ──────────────

const CHAT_SCHEMA = `
table Member (
    Id text primary key,
    Name text not null check (length(Name) between 1 and 100)
);

table Message (
    Id integer primary key,
    MemberId text not null,
    Content text not null,
    Timestamp datetime not null,
    foreign key (MemberId) references Member(Id)
);
`;

const chatAuthorPrivateKey = generatePrivateKey('ed25519', 'base64url') as string;
const chatAuthorPublicKey = getPublicKey(chatAuthorPrivateKey, 'ed25519', 'base64url', 'base64url') as string;

const CHAT_SAPP_CONFIG: SAppConfig = {
  id: chatAuthorPublicKey,
  version: '0.1.0',
  schema: CHAT_SCHEMA,
  signature: signSchema(CHAT_SCHEMA, '0.1.0', chatAuthorPrivateKey),
  latencyHint: 'interactive' as const,
};

// ── Helpers ─────────────────────────────────────────────────────────────────

function wsTransports() {
  return [webSockets(), circuitRelayTransport()];
}

const STRAND_ID = `smoke-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const PARTY_ID = `ws-chat-${Date.now()}`;

// ── Test ────────────────────────────────────────────────────────────────────

describe('WebSocket Chat (server-to-server)', () => {
  let drone: CadreNode | undefined;
  let phone: CadreNode | undefined;

  afterAll(async () => {
    // Shut down in reverse order
    await phone?.stop();
    await drone?.stop();
  });

  it('should replicate a chat message over WebSocket', async () => {
    // ── 1. Start the drone (storage profile, WS listener) ──────────────

    const droneConfig: CadreNodeConfig = {
      controlNetwork: { partyId: PARTY_ID, bootstrapNodes: [] },
      profile: 'storage',
      strandFilter: { mode: 'all' },
      storage: { provider: () => new MemoryRawStorage() },
      network: {
        transports: wsTransports(),
        listenAddrs: ['/ip4/127.0.0.1/tcp/0/ws'],
        enableRelay: true,
      },
      hibernation: { enabled: false },
    };

    drone = new CadreNode(droneConfig);
    await drone.start();

    // Extract the drone's actual multiaddr (with peer ID)
    const droneNode = drone.getControlNode()!;
    const droneAddrs = droneNode.getMultiaddrs().map(ma => ma.toString());
    expect(droneAddrs.length).toBeGreaterThan(0);
    console.log('Drone listening on:', droneAddrs);

    // ── 2. Start the phone (transaction profile, WS dialer) ────────────

    const phoneConfig: CadreNodeConfig = {
      controlNetwork: { partyId: PARTY_ID, bootstrapNodes: droneAddrs },
      profile: 'transaction',
      strandFilter: { mode: 'all' },
      storage: { provider: () => new MemoryRawStorage() },
      network: {
        transports: wsTransports(),
        listenAddrs: [],  // client-only
      },
      hibernation: { enabled: false },
    };

    phone = new CadreNode(phoneConfig);
    await phone.start();

    // Wait for the phone to connect to the drone
    const phoneNode = phone.getControlNode()!;
    await waitUntil(
      () => phoneNode.getConnections().length > 0,
      { timeoutMs: 10_000, description: 'phone connects to drone' },
    );
    console.log('Phone connected, peers:', phoneNode.getConnections().length);

    // ── 3. Create the chat strand on both nodes ────────────────────────

    const strandRow: StrandRow = { Id: STRAND_ID, MemberPrivateKey: null, Type: 'o' };

    const droneStrand = await drone.addStrand({ strandRow, sAppConfig: CHAT_SAPP_CONFIG, mode: 'networked' });
    expect(droneStrand.status).toBe('active');

    const phoneStrand = await phone.addStrand({ strandRow, sAppConfig: CHAT_SAPP_CONFIG, mode: 'networked' });
    expect(phoneStrand.status).toBe('active');

    // Connect the strand-level libp2p nodes.
    // Each strand spins up its own libp2p instance with bootstrapNodes: []
    // (strand peer discovery via control network is not yet wired up).
    // For now, manually dial the drone's strand node from the phone's strand node.
    const droneStrandAddrs = droneStrand.libp2pNode!.getMultiaddrs();
    expect(droneStrandAddrs.length).toBeGreaterThan(0);
    console.log('Drone strand addrs:', droneStrandAddrs.map(a => a.toString()));

    await phoneStrand.libp2pNode!.dial(droneStrandAddrs[0]);
    await waitUntil(
      () => phoneStrand.libp2pNode!.getConnections().length > 0,
      { timeoutMs: 10_000, description: 'phone strand node connects to drone strand node' },
    );
    console.log('Strand nodes connected');

    // ── 4. Insert a member + message on the drone ──────────────────────

    const droneDb = droneStrand.database!.getDatabase();
    await droneDb.exec(
      "insert into App.Member (Id, Name) values ('drone-1', 'Drone')",
    );
    // Quereus DATETIME expects 'YYYY-MM-DD HH:MM:SS' — NOT ISO 8601 with 'Z'.
    // (Note: reference-app-rn chat-operations.ts has the same bug — uses toISOString())
    const now = new Date().toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '');
    await droneDb.exec(
      `insert into App.Message (Id, MemberId, Content, Timestamp)
       values (1, 'drone-1', 'Hello from drone', '${now}')`,
    );

    // Verify local write succeeded
    const localRow = await droneDb.get('select Content from App.Message where Id = 1');
    expect(localRow?.Content).toBe('Hello from drone');

    // ── 5. Verify the message replicates to the phone ──────────────────

    const phoneDb = phoneStrand.database!.getDatabase();

    await waitUntil(
      async () => {
        const row = await phoneDb.get('select Content from App.Message where Id = 1');
        return row?.Content === 'Hello from drone';
      },
      { timeoutMs: 15_000, intervalMs: 250, description: 'message replicates to phone' },
    );

    const replicated = await phoneDb.get('select Content from App.Message where Id = 1');
    expect(replicated?.Content).toBe('Hello from drone');

    console.log('✓ Message replicated over WebSocket successfully');
  });
});

