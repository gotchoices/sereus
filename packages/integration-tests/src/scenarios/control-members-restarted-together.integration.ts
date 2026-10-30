/**
 * Two always-on members of one cadre restarted at the same moment (a host reboot, a power cut),
 * gotchoices/sereus#53 (`docs/architecture.md` → "Writes made while alone").
 *
 * Machines:
 * - **A**, the owner: phone-shaped (`listenAddrs: []`), founds the cadre and admits M1 and M2 the
 *   owner-online way. A stays up throughout, but a dial gate cuts it off from M1 and M2 while they
 *   restart, so neither restarted member can count A as a reachable sibling.
 * - **M1**, **M2**: `storage` profile on loopback WebSocket, pinning A's owner key, each on a
 *   raw store kept across the restart and restarted on the same listen address, as a cadre-cli
 *   node is.
 * - **M3**, the machine added after the restart.
 *
 * Why this shape. A restarted member writes its own `CadrePeer` row soon after it starts. Two
 * such updates committed while each member is alone take the `CadrePeer` block to the same
 * revision with different content, a fork nothing that runs afterwards heals
 * (`tickets/blocked/forked-control-collection-sync-livelocks.md`, "Sixth trigger"). So the
 * restarted members must not write their rows until they reach each other.
 *
 * How the alone window is made certain rather than likely. Each restarted member starts with a
 * dial gate refusing the other in both directions. A member's first control-cohort reconcile
 * pass runs only after its boot self-record publish has finished, and that pass dials the other
 * member, so a refused dial on a member's gate says its boot publish is over. Only then does the
 * scenario read the member's own row, and only then are the gates opened.
 */

import { describe, it, expect } from 'vitest';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { CadreNode, MemoryBootstrapPeerStore } from '@serfab/cadre-core';
import {
	controlNodeConfig, makeOwnOwner, waitUntil, captureRawStorage, hasOutboundTo, sameListenAddr,
	startPinningMember, admitMember, peerDialGate, type InviteMember, type PeerDialGate, type RawStorageCapture,
} from '../harness/index.js';

/** Bring-up, admission, replication and reconnect waits over loopback; each hides a CadreNode start or a reconcile pass. */
const STARTUP_MS = 60_000;

/** The `UpdatedAt` of `peerId`'s own `CadrePeer` row as `node`'s local database reads it. */
async function rowStamp(node: CadreNode, peerId: string): Promise<number | null> {
	return (await node.getControlDatabase()!.queryPeerRecord(peerId))?.updatedAt ?? null;
}

describe('Two cadre members restarted together', () => {
	it('neither writes its own row alone, both converge on each other\'s fresh record, and a third machine can be added', async () => {
		const partyId = `ctrl-restart-together-${Date.now()}`;
		const ownerGate = peerDialGate({ inbound: true });
		const captures: RawStorageCapture[] = [captureRawStorage(), captureRawStorage()];

		let A: CadreNode | undefined;
		let members: InviteMember[] = [];
		let M3: InviteMember | undefined;
		try {
			A = new CadreNode(controlNodeConfig({
				partyId, privateKey: await generateKeyPair('Ed25519'), profile: 'transaction', strandFilter: 'none', listenAddrs: [],
				bootstrapPeerStore: new MemoryBootstrapPeerStore(partyId), connectionGater: ownerGate.gater,
			}));
			await A.start();
			const owner = A;
			const { publicKey: ownerKey } = await makeOwnOwner(owner);

			// ── A admits M1 and M2; each learns the other's address record ──────────
			for (const capture of captures) {
				const member = await startPinningMember(partyId, ownerKey, { storageProvider: capture.provider });
				members.push(member);
				await admitMember(owner, member, STARTUP_MS);
			}
			const peerIds = members.map((member) => member.peerId);
			const [m1, m2] = peerIds as [string, string];
			await waitUntil(async () => (await members[0]!.node.resolvePeerAddrs(m2)).length > 0
				&& (await members[1]!.node.resolvePeerAddrs(m1)).length > 0, {
				timeoutMs: STARTUP_MS, intervalMs: 500, description: 'M1 and M2 resolve each other\'s address records',
			});
			// Each member's first publish must land before the stop (docs/testing.md: a background
			// `CadrePeer` write still committing at a stop tears).
			for (const member of members) {
				expect(await member.node.registerSelf()).not.toBe('skipped');
			}
			const stampsBefore = await Promise.all(members.map((member) => rowStamp(member.node, member.peerId)));

			// ── A is cut off; M1 and M2 stop and start again together, each refusing the other ──
			ownerGate.deny(m1);
			ownerGate.deny(m2);
			const gates: PeerDialGate[] = peerIds.map((_, i) => {
				const gate = peerDialGate({ inbound: true });
				gate.deny(peerIds[1 - i]!);
				return gate;
			});
			const restartShapes = members.map((member, i) => ({
				key: member.key, listenAddrs: [sameListenAddr(member.node)], storageProvider: captures[i]!.provider, connectionGater: gates[i]!.gater,
			}));
			await Promise.all(members.map((member) => member.node.stop()));
			members = [];
			members = await Promise.all(restartShapes.map((shape) => startPinningMember(partyId, ownerKey, shape)));
			const restartedAt = Date.now();
			const [n1, n2] = members.map((member) => member.node) as [CadreNode, CadreNode];

			// ── The invariant: a member that has no reachable sibling does not write its own row ──
			await waitUntil(() => gates.every((gate, i) => gate.deniedCount(peerIds[1 - i]!) > 0), {
				timeoutMs: STARTUP_MS, intervalMs: 100, description: 'each restarted member\'s first reconcile pass dials the other (its boot publish is over)',
			});
			const stampsAlone = await Promise.all(members.map((member) => rowStamp(member.node, member.peerId)));
			console.log('[restart-together] own-row stamps before the stop %o, once the boot publish was over (%d ms after the restart) %o',
				stampsBefore, Date.now() - restartedAt, stampsAlone);
			expect(members.map((member) => member.node.hasReachableControlSibling())).toEqual([false, false]);
			expect(stampsAlone).toEqual(stampsBefore);

			// ── The members find each other and each holds the other's fresh record ──
			gates.forEach((gate, i) => gate.allow(peerIds[1 - i]!));
			const reconnectAt = Date.now();
			await Promise.all([n1.reconcileControlCohort(), n2.reconcileControlCohort()]);
			await waitUntil(() => n1.hasReachableControlSibling() && n2.hasReachableControlSibling(), {
				timeoutMs: STARTUP_MS, intervalMs: 250, description: 'the restarted members reach each other',
			});
			await waitUntil(async () => {
				const [own1, own2, seen1, seen2] = await Promise.all([rowStamp(n1, m1), rowStamp(n2, m2), rowStamp(n2, m1), rowStamp(n1, m2)]);
				return own1 !== null && own2 !== null && own1 > stampsBefore[0]! && own2 > stampsBefore[1]! && seen1 === own1 && seen2 === own2;
			}, { timeoutMs: STARTUP_MS, intervalMs: 500, description: 'each restarted member publishes its record and holds the other\'s' });
			console.log('[restart-together] both members hold each other\'s fresh record %d ms after the gates opened', Date.now() - reconnectAt);

			// ── A returns and adds a third machine; both restarted members see it ───
			ownerGate.allow(m1);
			ownerGate.allow(m2);
			await owner.reconcileControlCohort();
			await waitUntil(() => hasOutboundTo(owner, m1) && hasOutboundTo(owner, m2), {
				timeoutMs: STARTUP_MS, intervalMs: 250, description: 'A reconnects to both restarted members',
			});
			M3 = await startPinningMember(partyId, ownerKey);
			const added = M3;
			await admitMember(owner, added, STARTUP_MS);
			await waitUntil(async () => (await n1.isMember(added.peerId)) && (await n2.isMember(added.peerId)), {
				timeoutMs: STARTUP_MS, intervalMs: 500, description: 'both restarted members list the third machine',
			});
		} finally {
			await Promise.allSettled([M3?.node.stop(), ...members.map((member) => member.node.stop()), A?.stop()]);
		}
	}, 8 * STARTUP_MS);
});
