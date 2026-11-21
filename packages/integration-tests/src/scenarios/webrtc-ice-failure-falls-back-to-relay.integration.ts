/**
 * Two relay-only parties — the shape of two phones — each also listening on `/webrtc`, so every
 * address either one publishes comes in a pair: the plain relayed one and a WebRTC one signalled
 * through the same relay. One file, two arms, differing ONLY in whether ICE (WebRTC's
 * connectivity check) can connect:
 *
 *   - **ICE can never connect** ({@link iceCannotConnect}): the join must still work, over the
 *     relay, at relay speed. This is gotchoices/sereus#61 end to end. Before the fix, `formStrand`
 *     spent its whole 25 s dial budget on A's `/p2p-circuit/webrtc` address and failed with
 *     `FormationUnreachableError`, never trying the plain relayed address beside it — so enabling
 *     WebRTC made a join fail outright wherever ICE could not connect, instead of just staying
 *     relayed. The ordering could not be fixed by sorting the list, because libp2p re-sorts
 *     whatever list a dial is given and its `circuitRelayAddressesLast` counts only an exact
 *     `Circuit` match as relayed, which a `/p2p-circuit/webrtc` address is not.
 *   - **ICE can connect** ({@link iceCanConnect}): the relayed strand connections must not stay
 *     relayed. Nothing in libp2p upgrades a relayed connection to WebRTC, and since the fix above
 *     no dial tries the WebRTC address first either, so the upgrade is cadre-core's own
 *     (`webrtc-upgrade.ts`): one background dial per peer, triggered by `peer:identify` over a
 *     relayed connection.
 *
 * What the first arm asserts:
 *
 *   1. A's invitation really carries a `/p2p-circuit/webrtc` address next to the relayed one —
 *      without that the scenario would be vacuous.
 *   2. B's control node really would dial that address over WebRTC: its transport manager routes
 *      it to `@libp2p/webrtc`. This is the anti-vacuity guard that matters most. With the WebRTC
 *      transport absent, libp2p would filter the address out of any dial by itself and the join
 *      would succeed for a reason this scenario is not about.
 *   3. `formStrand` succeeds, and inside {@link FORMATION_MS} — well under the 23 s a failing ICE
 *      negotiation takes to give up, so a fallback that happens only after paying that cost fails
 *      here too.
 *   4. B's strand becomes writable and a row B writes is readable at A: the strand nodes, which
 *      publish the same address pair, carry real data over the relay.
 *   5. Nothing anywhere ended up on a WebRTC connection — the fixture's ICE really cannot connect,
 *      so every success above was relayed. The upgrade service's own failed attempts, which this
 *      arm now also runs in the background, must not change that.
 *
 * And the second arm, on top of the same steps 1-4:
 *
 *   6. Each party's strand node ends up holding a connection to the other that
 *      `classifyTransport` labels `webrtc`, within {@link GATE}.
 *   7. The relayed connection is still open beside it — the upgrade does not close it, because
 *      closing it would race the streams already on it.
 *   8. A write still replicates afterwards.
 *
 * Each step's duration is logged. `@optimystic/db-p2p` dials strand peers by peer id
 * (`open-protocol-stream.ts`) and forwards libp2p no address sorter, so ITS dials still see the
 * WebRTC address first; the strand-step timings are the measurement of whether that costs
 * anything.
 *
 * ── Out of scope, deliberately ──
 * Link delay: the claims are about which address is dialed and which connection ends up carrying
 * traffic, not about speed. A capped (limited) relay: the upgrade is attempted over one on the
 * same terms, but the dedicated relay fixture runs with libp2p's limit off, as a party-run relay
 * does. The backoff after a failed attempt, and the tie-break that picks the dialing side, are
 * table tests over the pure decision function (`cadre-core/test/webrtc-upgrade.spec.ts`).
 */

import { describe, it, expect } from 'vitest';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { webRTC } from '@libp2p/webrtc';
import { multiaddr, type Multiaddr } from '@multiformats/multiaddr';
import type { Libp2p } from 'libp2p';
import { CadreNode, generateStrandMemberKey, summarizeConnectionPaths } from '@serfab/cadre-core';
import type { StrandRow } from '@serfab/cadre-core';
import type { Database } from '@quereus/quereus';
import {
  waitUntil,
  controlNodeConfig,
  createSignedSAppConfig,
  makeOwnOwner,
  controlAddrs,
  startDedicatedRelay,
  wsTransports,
  type DedicatedRelay,
} from '../harness/index.js';

/** Minimal one-table sApp schema (the shape several strand scenarios share). */
const SIMPLE_SCHEMA = `
table Data (
    Key text primary key,
    Val text
);
`;

const SAPP_ID = 'sapp-webrtc-ice-failure';
const YEAR_MS = 365 * 24 * 3600_000;

/** Budget for every convergence gate. Circuit setup is slower than loopback — headroom, not an expectation. */
const GATE = { timeoutMs: 60_000, intervalMs: 250 } as const;

/**
 * Ceiling on `formStrand`. The formation dial's own budget is 25 s at the default declared link
 * (`formationDeadlines().dialMs`) and a failing ICE negotiation gives up after about 23 s, so this
 * has to sit below both: a join that pays the ICE timeout first and only then falls back is still
 * the bug this scenario exists for, even though it would eventually succeed. Loopback formation
 * over a relay measures about 1-2 s, so the margin is wide. Asserted in BOTH arms: formation must
 * leave the WebRTC address out whether or not ICE would have worked.
 */
const FORMATION_MS = 15_000;

/**
 * The WebRTC transport with ICE that can never connect: no ICE servers at all, and
 * `iceTransportPolicy: 'relay'`, which tells the browser/node WebRTC stack to use ONLY candidates
 * learned from a TURN server — of which there are none. Signalling over the circuit relay still
 * works, so the dial gets as far as exchanging an offer, an answer and candidates, and then never
 * connects. That is exactly what two phones on different home networks see, with the uncertainty
 * taken out of it.
 *
 * NOTE: `@libp2p/webrtc`'s Node entry point re-exports `node-datachannel`'s polyfill, a NATIVE
 * module. On a platform with no prebuilt binary it is compiled at install time, and on one where
 * the binding cannot load the import at the top of this file fails the WHOLE file. If that happens
 * in CI the fix is a prebuild/toolchain one — do not delete the coverage.
 */
const iceCannotConnect = () => [
  ...wsTransports(),
  webRTC({ rtcConfiguration: { iceServers: [], iceTransportPolicy: 'relay' } }),
];

/**
 * The same transport with ICE that CAN connect: no ICE servers either — none is needed, since
 * both nodes are in this process and their host candidates reach each other — and no
 * `iceTransportPolicy`, so those host candidates are used. The stand-in for a phone and a node on
 * one LAN, which opened directly in about 0.5 s (gotchoices/sereus#61).
 */
const iceCanConnect = () => [...wsTransports(), webRTC({ rtcConfiguration: { iceServers: [] } })];

const isCircuit = (addr: string): boolean => addr.includes('/p2p-circuit');
const isWebrtc = (addr: string): boolean => addr.includes('/webrtc');

/** Every App.Data row visible on one strand DB, via an unfiltered scan. */
async function readDataRows(db: Database): Promise<Map<string, string>> {
  const rows = new Map<string, string>();
  for await (const row of db.eval('select Key, Val from App.Data')) {
    rows.set(row.Key as string, row.Val as string);
  }
  return rows;
}

/**
 * The transport libp2p would dial `addr` with, by its `Symbol.toStringTag` — `@libp2p/webrtc`,
 * `@libp2p/websockets`, … — or null when no configured transport claims it, in which case libp2p
 * drops the address from a dial entirely.
 *
 * `components` is not on the public `Libp2p` interface, so this peeks at the node the same way
 * `cadre-core`'s own `dialAddr` does, and types `dialTransportForMultiaddr` structurally rather
 * than pulling in `@libp2p/interface-internal` for one call.
 */
function dialTransportTag(node: Libp2p, addr: Multiaddr): string | null {
  const transport = (node as unknown as {
    components: {
      transportManager: {
        dialTransportForMultiaddr(ma: Multiaddr): { readonly [Symbol.toStringTag]: string } | undefined;
      };
    };
  }).components.transportManager.dialTransportForMultiaddr(addr);
  return transport ? String(transport[Symbol.toStringTag]) : null;
}

/** Assert no connection `node` holds runs over WebRTC — the proof the fixture's ICE never connected. */
function expectNothingOverWebrtc(node: Libp2p, label: string): void {
  for (const path of summarizeConnectionPaths(node.getConnections()).paths) {
    expect(path.transport, `${label}: ${path.remoteAddr}`).not.toBe('webrtc');
  }
}

/**
 * Whether `node` holds a connection to `remotePeerId` whose data path is WebRTC. Read through
 * `summarizeConnectionPaths`, so the classification is cadre-core's own: a successful upgrade
 * keeps the relay's signalling prefix in the connection's remote address
 * (`…/p2p-circuit/webrtc/p2p/…`) and is nevertheless direct.
 */
function hasWebrtcTo(node: Libp2p, remotePeerId: string): boolean {
  return summarizeConnectionPaths(node.getConnections()).paths
    .some((path) => path.peerId === remotePeerId && path.transport === 'webrtc');
}

/** Whether `node` still holds a relay-carried connection to `remotePeerId`. */
function hasRelayedTo(node: Libp2p, remotePeerId: string): boolean {
  return summarizeConnectionPaths(node.getConnections()).paths
    .some((path) => path.peerId === remotePeerId && path.transport === 'circuit-relay');
}

/** Every connection `node` holds, as `<transport> <addr>` lines, for an assertion message. */
function describeConnections(node: Libp2p): string {
  return summarizeConnectionPaths(node.getConnections()).paths
    .map((path) => `${path.transport} ${path.remoteAddr}`)
    .join(', ');
}

/** Run `step`, print how long it took under `label`, and hand back its result. */
async function timed<T>(label: string, step: () => Promise<T>): Promise<T> {
  const started = Date.now();
  try {
    return await step();
  } finally {
    console.log('[webrtc-ice] %s: %d ms', label, Date.now() - started);
  }
}

/** What each arm starts, in start order, so a failure part-way through still tears everything down. */
interface Running {
  relay?: DedicatedRelay;
  readonly nodes: CadreNode[];
}

async function stopRunning(running: Running): Promise<void> {
  await Promise.allSettled([...running.nodes].reverse().map((node) => node.stop()));
  await running.relay?.stop();
}

/** The two parties, sharing one strand through one relay, with both arms' shared assertions done. */
interface FormedPair {
  readonly A: CadreNode;
  readonly B: CadreNode;
  readonly strandId: string;
  readonly aStrandNode: Libp2p;
  readonly bStrandNode: Libp2p;
  readonly aDb: Database;
  readonly bDb: Database;
}

/**
 * Bring up the relay and both relay-only parties on `transports`, found the strand on A, join it
 * from B over an invitation, and launch it on B — asserting along the way that the setup really is
 * the one the arms are about: both address shapes published, the invitation carrying both, and B's
 * node really routing the WebRTC one to `@libp2p/webrtc`.
 *
 * Registers each node in `running` as it starts, so the caller's `finally` tears down whatever
 * came up even when a step below throws.
 */
async function formRelayOnlyPair(running: Running, transports: () => ReturnType<typeof iceCanConnect>): Promise<FormedPair> {
  const runTag = Date.now();
  const strandId = `strand-webrtc-${runTag}`;
  const sApp = createSignedSAppConfig(SIMPLE_SCHEMA, '0.1.0');
  running.relay = await startDedicatedRelay();

  // ── Both parties: relay-only, and listening on /webrtc as a phone with the
  //    transport does. `enableRelay: false` because a phone relays for nobody.
  const phone = (partyId: string) => ({
    partyId,
    profile: 'storage' as const,
    enableRelay: false,
    listenAddrs: ['/webrtc'],
    relayAddrs: [running.relay!.dialAddr],
    transports: transports(),
  });

  const A = new CadreNode(controlNodeConfig({ ...phone(`webrtc-a-${runTag}`), privateKey: await generateKeyPair('Ed25519') }));
  running.nodes.push(A);
  await timed("A's start", () => A.start());
  await makeOwnOwner(A);
  const aPeerId = A.peerId!.toString();

  // A publishes BOTH shapes through its one relay: the plain relayed address and the WebRTC
  // one. The pair is what the bug needed, so it is asserted rather than assumed.
  const aAddrs = controlAddrs(A);
  expect(aAddrs.filter((addr) => isCircuit(addr) && !isWebrtc(addr)).length).toBeGreaterThan(0);
  expect(aAddrs.filter((addr) => isCircuit(addr) && isWebrtc(addr)).length).toBeGreaterThan(0);
  expect(A.getRelayReservationState().status).toBe('reserved');

  // ── A founds the strand and publishes a bound invitation ──────────────
  const memberPrivateKey = await generateStrandMemberKey();
  const founded = await timed('A founds the strand', () => A.foundStrand({
    strandId, type: 'c', memberPrivateKey, sAppConfig: sApp,
  }));
  const aStrandNode = founded.instance.libp2pNode!;
  const invitation = await A.createOpenInvitation(SAPP_ID, YEAR_MS);
  await A.publishFormationInvite(invitation.token, SAPP_ID, {
    strandId, expiresAtMs: Date.now() + YEAR_MS, totalUses: 1,
  });
  // The invitation is B's only knowledge of A, and it carries the WebRTC address — the
  // address list that made the join fail.
  const webrtcBootstrap = invitation.bootstrap.filter(isWebrtc);
  expect(webrtcBootstrap.length, `invitation bootstrap: ${invitation.bootstrap.join(', ')}`).toBeGreaterThan(0);
  expect(invitation.bootstrap.filter((addr) => isCircuit(addr) && !isWebrtc(addr)).length).toBeGreaterThan(0);
  for (const addr of invitation.bootstrap) {
    expect(addr).toContain(aPeerId);
  }

  // ── Party B ───────────────────────────────────────────────────────────
  const B = new CadreNode(controlNodeConfig({ ...phone(`webrtc-b-${runTag}`), privateKey: await generateKeyPair('Ed25519') }));
  running.nodes.push(B);
  await timed("B's start", () => B.start());
  await makeOwnOwner(B);

  // Anti-vacuity: B's control node would really dial A's WebRTC address over WebRTC. Without
  // this, a build that dropped the transport would pass the whole scenario for the wrong
  // reason — libp2p silently filters an address no configured transport claims.
  expect(dialTransportTag(B.getControlNode()!, multiaddr(webrtcBootstrap[0]))).toBe('@libp2p/webrtc');

  // ── B forms, over the relay, inside the budget ─────────────────────────
  const decoded = B.decodeInvitation(A.encodeInvitation(invitation));
  const formStarted = Date.now();
  const formResult = await timed('B forms the strand', () => B.formStrand(decoded, {
    partyId: `webrtc-b-${runTag}`,
    purpose: 'webrtc ICE and the relay',
  }));
  const formMs = Date.now() - formStarted;
  expect(formResult.strandId).toBe(strandId);
  expect(formResult.memberPrivateKey).toBe(memberPrivateKey);
  expect(formMs, `formStrand took ${formMs} ms — a failing ICE negotiation was paid for`)
    .toBeLessThan(FORMATION_MS);

  // ── B launches the strand from the carried seed ────────────────────────
  const bStrandRow: StrandRow = {
    Id: strandId,
    MemberPrivateKey: formResult.memberPrivateKey ?? null,
    Type: 'c',
    FounderOwnerKey: null,
    FounderPeerId: null,
  };
  const bStrand = await timed("B's addStrand", () => B.addStrand({
    strandRow: bStrandRow, sAppConfig: sApp, awaitFirstSync: false,
  }));
  const bStrandNode = bStrand.libp2pNode!;
  expect(bStrandNode.getMultiaddrs().map(String).some(isCircuit)).toBe(true);
  // The strand nodes publish the same address pair as the control nodes, which is what makes an
  // upgrade of a strand connection possible at all.
  expect(bStrandNode.getMultiaddrs().map(String).some((addr) => isCircuit(addr) && isWebrtc(addr))).toBe(true);

  await timed("B's strand becomes writable", () => B.whenStrandWritable(strandId, { timeoutMs: GATE.timeoutMs }));

  return {
    A, B, strandId, aStrandNode, bStrandNode,
    aDb: founded.instance.database!.getDatabase(),
    bDb: bStrand.database!.getDatabase(),
  };
}

/** Write one row on `from` and wait for it to be readable on `to`. */
async function expectRowReplicates(from: Database, to: Database, key: string, value: string, label: string): Promise<void> {
  await timed(label, async () => {
    await from.exec(`insert into App.Data (Key, Val) values ('${key}', '${value}')`);
    await waitUntil(
      async () => (await readDataRows(to)).get(key) === value,
      { ...GATE, description: `the row ${key} is readable on the other party` },
    );
  });
}

describe('E2E two relay-only parties listening on /webrtc (gotchoices/sereus#61)', () => {
  it('forms the strand over the relay and replicates, with ICE that can never connect', async () => {
    const running: Running = { nodes: [] };
    try {
      const pair = await formRelayOnlyPair(running, iceCannotConnect);

      // A row B writes reaches A: real strand data over the relay, from the joiner's side.
      await expectRowReplicates(pair.bDb, pair.aDb, 'from-b', 'written-on-B', "B's row reaches A");

      // ── Every success above was relayed ───────────────────────────────────
      // The fixture's ICE cannot connect, so a WebRTC connection anywhere would mean the
      // rtcConfiguration above stopped doing its job and the scenario proved nothing. The
      // background upgrade attempts cadre-core now makes are included in that: each one fails,
      // and a failed attempt must leave the relayed connection carrying everything.
      for (const [node, label] of [
        [pair.A.getControlNode()!, 'A control'], [pair.B.getControlNode()!, 'B control'],
        [pair.aStrandNode, 'A strand'], [pair.bStrandNode, 'B strand'],
      ] as const) {
        expectNothingOverWebrtc(node, label);
      }
    } finally {
      await stopRunning(running);
    }
  }, 300_000);

  it('upgrades the relayed strand connections to WebRTC once ICE can connect', async () => {
    const running: Running = { nodes: [] };
    try {
      const pair = await formRelayOnlyPair(running, iceCanConnect);
      const aStrandPeerId = pair.aStrandNode.peerId.toString();
      const bStrandPeerId = pair.bStrandNode.peerId.toString();

      // ── The upgrade ───────────────────────────────────────────────────────
      // Nothing in the join above dialed a WebRTC address: formation leaves them out and every
      // strand dial goes relayed-first. So a WebRTC connection here can only have come from
      // cadre-core's own background upgrade.
      await timed('the strand connections upgrade to WebRTC', () => waitUntil(
        () => hasWebrtcTo(pair.aStrandNode, bStrandPeerId) && hasWebrtcTo(pair.bStrandNode, aStrandPeerId),
        { ...GATE, description: "each party's strand node holds a WebRTC connection to the other" },
      ));

      // The relayed connection is left open beside it, deliberately: closing it would race the
      // streams already on it, and new streams prefer the direct connection by themselves.
      expect(hasRelayedTo(pair.aStrandNode, bStrandPeerId), `A strand: ${describeConnections(pair.aStrandNode)}`).toBe(true);
      expect(hasRelayedTo(pair.bStrandNode, aStrandPeerId), `B strand: ${describeConnections(pair.bStrandNode)}`).toBe(true);

      // ── The strand still works with the direct connection in place ────────
      await expectRowReplicates(pair.bDb, pair.aDb, 'from-b', 'written-on-B', "B's row reaches A after the upgrade");
      await expectRowReplicates(pair.aDb, pair.bDb, 'from-a', 'written-on-A', "A's row reaches B after the upgrade");
    } finally {
      await stopRunning(running);
    }
  }, 300_000);
});
