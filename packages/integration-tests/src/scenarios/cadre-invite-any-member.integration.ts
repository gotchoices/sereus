/**
 * E2E: a cadre invitation is redeemed at a member while the owner that minted it is OFFLINE
 * (`docs/architecture.md` → "Enrollment Flow: Invitation Redeemed at Any Member").
 *
 * Machines:
 * - **A**, the owner: founds the cadre and listens on a loopback WebSocket port. Its control
 *   storage and node-local dial-target store are kept across a stop/start, the two things a
 *   machine carries across a process restart besides its identity key.
 * - **M** and **N**, always-on members: `storage` profile, listening on WebSocket, admitted by A
 *   through `addDrone` plus seed delivery (the owner-online path), pinning A's owner key as an
 *   operator would (`--pin-owner-key`).
 * - **P**, the new device: phone-shaped (`listenAddrs: []`), started with NO pinned key — it
 *   anchors A's key from the bundle — and redeems an untargeted, owner-granting invitation
 *   after A has stopped.
 * - **Q**, a second device, refused with `invite-spent` once A has withdrawn the invitation.
 *
 * Why this shape, and not the phone owner plus one member the feature is for. A member serves
 * a redemption with a control write, and a control write is offered to the member's FRET
 * cohort, which must have let the stopped owner go first:
 * - A member evicts a stopped peer only after repeated failed contacts, and a peer with no
 *   address cannot be contacted at all. An address-less (phone-shaped) owner stayed in the
 *   members' cohorts for over 300 s, alone and with a second member alike, and every write
 *   waited on it for the whole commit budget; with a listen address it was evicted in about
 *   5 s. Ticket `phone-owner-never-leaves-members-cohort`.
 * - A member left ENTIRELY alone tore its first write after the owner left (the usage row
 *   durable, the peer and owner rows not), and the owner that then restarted never listed the
 *   device within 60 s. Ticket `redemption-write-tears-on-a-member-whose-cohort-just-shrank`.
 * With two members the write has a live cohort and committed cleanly on every run here.
 *
 * The invitation names A's own address first and then the members'; A is stopped when P
 * redeems, so P's first dial fails and it moves on. The scenario waits until both members
 * hold the invitation's row before A stops: a member's connection gate admits a stranger
 * only while it holds a live row (`decide-cadre-invite-redeemed-before-the-row-replicates`).
 *
 * The withdrawal arm relies on the members running the circuit-relay server (the
 * storage-profile default): with no live invitation held, a member's gate admits Q's
 * connection for relay only and drops it at the not-reserving deadline, which is long enough
 * for the redemption exchange to be answered. On a member with the relay server off, Q would
 * be refused at the connection instead and this arm would see `CadreInviteUnreachableError`.
 */

import { describe, it, expect } from 'vitest';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import {
	CadreNode, CadreInviteRejectedError, CadreInviteUnreachableError, MemoryBootstrapPeerStore, ed25519KeyPairFromLibp2p,
	type CadreInvitation, type RedeemCadreInvitationResult,
} from '@serfab/cadre-core';
import type { PrivateKey } from '@libp2p/interface';
import {
	controlNodeConfig, makeOwnOwner, controlAddrs, hasOutboundTo, waitUntil, captureRawStorage, readCohort,
} from '../harness/index.js';

/** Bring-up, enrollment, replication and reconnect waits over loopback — each hides a CadreNode start or a reconcile pass. */
const STARTUP_MS = 60_000;
/** One request and its reply, or one row crossing an already-open connection. */
const OP_MS = 30_000;
/** How long FRET may take to evict a stopped, addressable peer from a member's cohort (about 5 s measured). */
const COHORT_EVICTION_MS = 60_000;
/** Pause between a device's redemption attempts while the member answers retryably. */
const REDEEM_RETRY_PAUSE_MS = 2_000;

interface Member { node: CadreNode; peerId: string }

/**
 * What a device does with a retryable outcome: try again after a pause, until `budgetMs` is
 * spent. A member answers retryably while Optimystic keeps it from electing itself
 * coordinator in the 30 s after its last connection dropped (`Self-coordination blocked:
 * grace-period-not-elapsed`, see `docs/architecture.md` → "Schema initialization uses a wider
 * policy"), which a device that redeems right after the owner left can land in. Returns the
 * attempts made with the result, so the scenario reports whether that window was hit.
 */
async function redeemWithRetry(device: CadreNode, invitation: CadreInvitation, budgetMs: number): Promise<{ joined: RedeemCadreInvitationResult; attempts: number }> {
	const deadline = Date.now() + budgetMs;
	for (let attempts = 1; ; attempts++) {
		try {
			return { joined: await device.redeemCadreInvitation(invitation), attempts };
		} catch (err) {
			if (!(err instanceof CadreInviteUnreachableError) || Date.now() + REDEEM_RETRY_PAUSE_MS > deadline) throw err;
			await new Promise<void>((resolve) => setTimeout(resolve, REDEEM_RETRY_PAUSE_MS));
		}
	}
}

describe('E2E cadre invitation redeemed at a member while the owner is offline', () => {
	it('A mints, stops; P joins at a member as an owner; A returns and sees P; a withdrawn invitation refuses Q', async () => {
		const partyId = `cadre-invite-any-member-${Date.now()}`;
		const aKey = await generateKeyPair('Ed25519');
		const aPeerId = peerIdFromPrivateKey(aKey).toString();
		const captureA = captureRawStorage();
		const aPeerStore = new MemoryBootstrapPeerStore(partyId);

		/** A's shape, the same for both incarnations: the restart reopens the same stores. */
		function buildA(): CadreNode {
			return new CadreNode(controlNodeConfig({
				partyId, privateKey: aKey, profile: 'transaction', strandFilter: 'none',
				storageProvider: captureA.provider, bootstrapPeerStore: aPeerStore,
			}));
		}
		function buildDevice(key: PrivateKey): CadreNode {
			return new CadreNode(controlNodeConfig({ partyId, privateKey: key, profile: 'transaction', listenAddrs: [], strandFilter: 'none' }));
		}
		/** An always-on member, pinning A's key, with the seed handler `cadre start --listen-for-seeds` registers. */
		async function startMember(aOwnerKey: string): Promise<Member> {
			const key = await generateKeyPair('Ed25519');
			const node = new CadreNode(controlNodeConfig({
				partyId, privateKey: key, profile: 'storage', strandFilter: 'none', pinnedOwnerKeys: [aOwnerKey],
			}));
			await node.start();
			await node.enableSeedListener();
			return { node, peerId: peerIdFromPrivateKey(key).toString() };
		}
		/** The owner-online path: A vouches the member, delivers the seed, and dials it from the retained address. */
		async function admitMember(owner: CadreNode, member: Member): Promise<void> {
			const addrs = controlAddrs(member.node);
			const { seed } = await owner.addDrone({ dronePeerId: member.peerId, droneMultiaddrs: addrs });
			expect((await owner.deliverSeed(addrs[0]!, seed)).accepted).toBe(true);
			await owner.reconcileControlCohort();
			await waitUntil(() => hasOutboundTo(owner, member.peerId), {
				timeoutMs: STARTUP_MS, intervalMs: 250, description: `A holds an outbound control connection to ${member.peerId}`,
			});
		}

		let A: CadreNode | undefined;
		let P: CadreNode | undefined;
		let Q: CadreNode | undefined;
		const members: Member[] = [];
		try {
			// ── A founds the cadre; M and N are admitted the owner-online way ───────
			A = buildA();
			await A.start();
			const aOwnerKey = await makeOwnOwner(A, aKey);

			members.push(await startMember(aOwnerKey), await startMember(aOwnerKey));
			for (const member of members) {
				await admitMember(A, member);
			}
			// The members' signed address records have to reach A before they can be named in the invitation.
			for (const member of members) {
				await waitUntil(async () => (await A!.resolvePeerAddrs(member.peerId)).length > 0, {
					timeoutMs: STARTUP_MS, intervalMs: 500, description: `${member.peerId}'s signed address record reaches A`,
				});
			}

			// ── A mints an untargeted owner-granting invitation, the members receive its row, A stops ──
			const { invitation } = await A.createCadreInvitation({ grantsOwner: true });
			expect(invitation.invite.peerId).toBeNull();
			expect(invitation.members[0]).toBe(A.getMultiaddrs()[0]);
			for (const member of members) {
				expect(invitation.members.some((addr) => addr.endsWith(`/p2p/${member.peerId}`))).toBe(true);
			}
			expect(invitation.ownerKeys).toEqual([aOwnerKey]);
			const key = invitation.invite.key;
			for (const member of members) {
				await waitUntil(async () => (await member.node.listCadreInvitations()).some((status) => status.invite.key === key && status.live), {
					timeoutMs: OP_MS, intervalMs: 500, description: `${member.peerId} holds the live invitation row`,
				});
			}
			await A.stop();
			A = undefined;
			// "Offline" from the members' side means A has left their CONTROL COHORT, not merely
			// their connection lists (see the file header).
			const ownerLeftAt = Date.now();
			for (const member of members) {
				await waitUntil(async () => !(await readCohort(member.node.getControlNode()!, member.peerId)).includes(aPeerId), {
					timeoutMs: COHORT_EVICTION_MS, intervalMs: 1_000, description: `the stopped owner leaves ${member.peerId}'s control cohort`,
				});
			}
			console.log('[any-member] the stopped owner left both members\' control cohorts after %d ms', Date.now() - ownerLeftAt);

			// ── P redeems at a member with the owner offline ───────────────────────
			const pKey = await generateKeyPair('Ed25519');
			const pPeerId = peerIdFromPrivateKey(pKey).toString();
			P = buildDevice(pKey);
			await P.start();
			expect(P.getTrustedOwnerStore()!.has(aOwnerKey)).toBe(false);
			const redeemStartedAt = Date.now();
			const { joined, attempts } = await redeemWithRetry(P, invitation, STARTUP_MS);
			console.log('[any-member] P was admitted on attempt %d, %d ms after it first asked', attempts, Date.now() - redeemStartedAt);
			const admitter = members.find((member) => member.peerId === joined.peerId);
			expect(admitter).toBeDefined();
			const other = members.find((member) => member !== admitter)!;
			expect(joined.grantsOwner).toBe(true);
			expect(P.getTrustedOwnerStore()!.has(aOwnerKey)).toBe(true);

			// The admitting member wrote P's rows on the chain its own database holds: P is an
			// authorized member and an owner there, and the other member sees the same by replication.
			expect(await admitter!.node.isAuthorizedMember(pPeerId)).toBe(true);
			expect((await admitter!.node.listAuthorizedMembers()).map((row) => row.peerId)).toContain(pPeerId);
			expect((await admitter!.node.getControlDatabase()!.getOwnerKeys()).has(ed25519KeyPairFromLibp2p(pKey).publicKeyB64)).toBe(true);
			await waitUntil(async () => await other.node.isAuthorizedMember(pPeerId), {
				timeoutMs: STARTUP_MS, intervalMs: 500, description: 'the other member lists P once the rows replicate',
			});
			// P's control streams are admitted at the member: the rows that make the members
			// members in P's eyes (A's vouches, judged against the key P just pinned) cross that
			// connection.
			await waitUntil(async () => (await P!.listAuthorizedMembers()).some((row) => row.peerId === admitter!.peerId), {
				timeoutMs: STARTUP_MS, intervalMs: 500, description: 'P lists the admitting member as authorized once the rows replicate',
			});
			expect(hasOutboundTo(P, admitter!.peerId)).toBe(true);

			// ── A returns, syncs, and sees the member it never vouched for ──────────
			A = buildA();
			await A.start();
			await A.initializeSeedBootstrap(ed25519KeyPairFromLibp2p(aKey).privateKeyB64);
			await A.reconcileControlCohort();
			await waitUntil(() => members.some((member) => hasOutboundTo(A!, member.peerId)), {
				timeoutMs: STARTUP_MS, intervalMs: 250, description: 'the restarted A reconnects to a member',
			});
			// A is the issuer, so the chain P's row carries resolves against A's own anchored key.
			await waitUntil(async () => (await A!.listAuthorizedMembers()).some((row) => row.peerId === pPeerId), {
				timeoutMs: STARTUP_MS, intervalMs: 500, description: 'A lists P as an authorized member after syncing',
			});

			// ── A withdraws; once the members hold the tombstone, Q is refused with invite-spent ──
			expect(await A.withdrawCadreInvitation(key)).toBe(true);
			for (const member of members) {
				await waitUntil(async () => (await member.node.listCadreInvitations()).find((status) => status.invite.key === key)?.withdrawn === true, {
					timeoutMs: OP_MS, intervalMs: 500, description: `${member.peerId} holds the withdrawal tombstone`,
				});
			}
			Q = buildDevice(await generateKeyPair('Ed25519'));
			await Q.start();
			const refusal: unknown = await Q.redeemCadreInvitation(invitation).catch((err: unknown) => err);
			expect(refusal).toBeInstanceOf(CadreInviteRejectedError);
			expect(refusal).toMatchObject({ code: 'invite-spent', retryable: false });
			for (const member of members) {
				expect(await member.node.isAuthorizedMember(Q.peerId!.toString())).toBe(false);
			}
		} finally {
			await Promise.allSettled([Q?.stop(), P?.stop(), A?.stop(), ...members.map((member) => member.node.stop())]);
		}
	}, 8 * STARTUP_MS);
});
