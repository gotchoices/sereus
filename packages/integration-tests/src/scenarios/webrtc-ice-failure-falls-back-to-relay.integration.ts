/**
 * Turning WebRTC on must not be able to break a join. Two relay-only parties — the shape of two
 * phones — each listen on `/webrtc` as well as through their relay, so every address either one
 * publishes comes in a pair: the plain relayed one and a WebRTC one signalled through the same
 * relay. The WebRTC transport here is configured so ICE (WebRTC's connectivity check) can NEVER
 * connect: no ICE servers and `iceTransportPolicy: 'relay'`, which is the deterministic stand-in
 * for the real case of two phones on different home networks with no TURN server between them.
 * A join must still work, over the relay, at relay speed.
 *
 * This is gotchoices/sereus#61 end to end. Before the fix, `formStrand` spent its whole 25 s
 * dial budget on A's `/p2p-circuit/webrtc` address and failed with `FormationUnreachableError`,
 * never trying the plain relayed address beside it — so enabling WebRTC made a join fail outright
 * wherever ICE could not connect, instead of just staying relayed. The ordering could not be
 * fixed by sorting the list, because libp2p re-sorts whatever list a dial is given and its
 * `circuitRelayAddressesLast` counts only an exact `Circuit` match as relayed, which a
 * `/p2p-circuit/webrtc` address is not.
 *
 * What it asserts:
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
 *      so every success above was relayed.
 *
 * Each step's duration is logged. `@optimystic/db-p2p` dials strand peers by peer id
 * (`open-protocol-stream.ts`) and forwards libp2p no address sorter, so ITS dials still see the
 * WebRTC address first; the strand-step timings are the measurement of whether that costs
 * anything. The ticket that landed this says to ask Optimystic for an address sorter rather than
 * work around it here if the writes stall.
 *
 * ── Out of scope, deliberately ──
 * A WebRTC connection that WORKS (`relayed-connections-try-a-webrtc-upgrade` owns the upgrade and
 * its scenario). Link delay: the claim is about which address is dialed, not about speed.
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
 * over a relay measures about 1-2 s, so the margin is wide.
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

/** Run `step`, print how long it took under `label`, and hand back its result. */
async function timed<T>(label: string, step: () => Promise<T>): Promise<T> {
  const started = Date.now();
  try {
    return await step();
  } finally {
    console.log('[webrtc-ice-failure] %s: %d ms', label, Date.now() - started);
  }
}

describe('E2E a WebRTC address whose ICE cannot connect never costs a join (gotchoices/sereus#61)', () => {
  it('forms the strand over the relay and replicates, with both parties listening on /webrtc', async () => {
    let relay: DedicatedRelay | undefined;
    let A: CadreNode | undefined; // party A: founder/owner, one phone
    let B: CadreNode | undefined; // party B: joiner, one phone, a stranger to A
    try {
      const runTag = Date.now();
      const strandId = `strand-webrtc-${runTag}`;
      const sApp = createSignedSAppConfig(SIMPLE_SCHEMA, '0.1.0');
      relay = await startDedicatedRelay();

      // ── Both parties: relay-only, and listening on /webrtc as a phone with the
      //    transport does. `enableRelay: false` because a phone relays for nobody.
      const phone = (partyId: string) => ({
        partyId,
        profile: 'storage' as const,
        enableRelay: false,
        listenAddrs: ['/webrtc'],
        relayAddrs: [relay!.dialAddr],
        transports: iceCannotConnect(),
      });

      A = new CadreNode(controlNodeConfig({ ...phone(`webrtc-a-${runTag}`), privateKey: await generateKeyPair('Ed25519') }));
      await timed("A's start", () => A!.start());
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
      const founded = await timed('A founds the strand', () => A!.foundStrand({
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
      B = new CadreNode(controlNodeConfig({ ...phone(`webrtc-b-${runTag}`), privateKey: await generateKeyPair('Ed25519') }));
      await timed("B's start", () => B!.start());
      await makeOwnOwner(B);

      // Anti-vacuity: B's control node would really dial A's WebRTC address over WebRTC. Without
      // this, a build that dropped the transport would pass the whole scenario for the wrong
      // reason — libp2p silently filters an address no configured transport claims.
      expect(dialTransportTag(B.getControlNode()!, multiaddr(webrtcBootstrap[0]))).toBe('@libp2p/webrtc');

      // ── B forms, over the relay, inside the budget ─────────────────────────
      const decoded = B.decodeInvitation(A.encodeInvitation(invitation));
      const formStarted = Date.now();
      const formResult = await timed('B forms the strand', () => B!.formStrand(decoded, {
        partyId: `webrtc-b-${runTag}`,
        purpose: 'webrtc ICE failure falls back to relay',
      }));
      const formMs = Date.now() - formStarted;
      expect(formResult.strandId).toBe(strandId);
      expect(formResult.memberPrivateKey).toBe(memberPrivateKey);
      expect(formMs, `formStrand took ${formMs} ms — a failing ICE negotiation was paid for`)
        .toBeLessThan(FORMATION_MS);

      // ── B launches the strand from the carried seed and writes ─────────────
      const bStrandRow: StrandRow = {
        Id: strandId,
        MemberPrivateKey: formResult.memberPrivateKey ?? null,
        Type: 'c',
        FounderOwnerKey: null,
        FounderPeerId: null,
      };
      const bStrand = await timed("B's addStrand", () => B!.addStrand({
        strandRow: bStrandRow, sAppConfig: sApp, awaitFirstSync: false,
      }));
      const bStrandNode = bStrand.libp2pNode!;
      expect(bStrandNode.getMultiaddrs().map(String).some(isCircuit)).toBe(true);

      await timed("B's strand becomes writable", () => B!.whenStrandWritable(strandId, { timeoutMs: GATE.timeoutMs }));
      const bDb = bStrand.database!.getDatabase();
      const aDb = founded.instance.database!.getDatabase();

      // A row B writes reaches A: real strand data over the relay, from the joiner's side.
      await timed("B's row reaches A", async () => {
        await bDb.exec("insert into App.Data (Key, Val) values ('from-b', 'written-on-B')");
        await waitUntil(
          async () => (await readDataRows(aDb)).get('from-b') === 'written-on-B',
          { ...GATE, description: 'the row written on B is readable on A over the relay' },
        );
      });

      // ── Every success above was relayed ───────────────────────────────────
      // The fixture's ICE cannot connect, so a WebRTC connection anywhere would mean the
      // rtcConfiguration above stopped doing its job and the scenario proved nothing.
      for (const [node, label] of [
        [A.getControlNode()!, 'A control'], [B.getControlNode()!, 'B control'],
        [aStrandNode, 'A strand'], [bStrandNode, 'B strand'],
      ] as const) {
        expectNothingOverWebrtc(node, label);
      }
    } finally {
      await Promise.allSettled([B?.stop(), A?.stop()]);
      await relay?.stop();
    }
  }, 300_000);
});
