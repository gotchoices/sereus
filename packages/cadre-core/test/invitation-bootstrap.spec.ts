import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';

import { encodeCadreInvitation } from '../src/cadre-invite-protocol.js';
import { generateStampId } from '../src/control-database.js';
import { cadreInvitationReach, selectCadreInvitationMembers, type InvitationSibling } from '../src/invitation-bootstrap.js';
import { freshKeyPair, signAs } from './control-constraint-helpers.js';

async function newPeerId(): Promise<string> {
	return peerIdFromPrivateKey(await generateKeyPair('Ed25519')).toString();
}

/** A relayed address as a machine publishes one: about 150 characters. */
function relayed(relay: string, peerId: string): string {
	return `/ip4/203.0.113.10/tcp/443/wss/p2p/${relay}/p2p-circuit/p2p/${peerId}`;
}

/** A direct LAN WebSocket address: about 85 characters. */
function direct(peerId: string, port: number): string {
	return `/ip4/192.168.1.20/tcp/${port}/ws/p2p/${peerId}`;
}

/** Relay and direct addresses alternating, as the measurement behind `CADRE_INVITATION_MAX_ADDRS` used. */
function addressesOf(relay: string, peerId: string, count: number): string[] {
	return Array.from({ length: count }, (_, i) => (i % 2 === 0 ? relayed(relay, peerId) : direct(peerId, 4001 + i)));
}

describe('cadre invitation addresses', () => {
	it('keeps an invitation with three owner keys, and more addresses offered than the cap, within one QR code', async () => {
		const relay = await newPeerId();
		const issuer = await newPeerId();
		const siblings: InvitationSibling[] = await Promise.all([0, 1, 2].map(async (i) => {
			const peerId = await newPeerId();
			return { peerId, updatedAt: i, addrs: addressesOf(relay, peerId, 4) };
		}));
		const members = selectCadreInvitationMembers(addressesOf(relay, issuer, 5), siblings, new Set());
		const owners = [freshKeyPair(), freshKeyPair(), freshKeyPair()];
		const signed = {
			key: freshKeyPair().publicKey,
			peerId: await newPeerId(),
			grantsOwner: true,
			expiresAt: '2026-10-12T16:00:00',
			totalUses: 1,
			stampId: generateStampId(issuer),
		};

		const encoded = encodeCadreInvitation({
			v: 1,
			partyId: randomUUID(),
			invitePrivateKey: freshKeyPair().privateKey,
			invite: { ...signed, issuerKey: owners[0]!.publicKey, issuerSig: signAs(owners[0]!, new Uint8Array(32)) },
			ownerKeys: owners.map((owner) => owner.publicKey),
			members,
		});

		expect(members).toHaveLength(6);
		// Measured 1,930 characters with these shapes. The largest QR code holds 2,953 bytes at error-correction
		// level L; the margin is for a field added to the bundle or the error-correction level
		// the screens choose. A loosened cap or a new field that crosses it fails here first.
		expect(encoded.length).toBeLessThanOrEqual(2_048);
	});

	it('judges reach on the other machines only: anywhere, local network, or the issuer alone', async () => {
		const issuer = await newPeerId();
		const other = await newPeerId();
		const relay = await newPeerId();
		const issuerPublic = `/dns4/home.example.org/tcp/443/wss/p2p/${issuer}`;

		expect(cadreInvitationReach([issuerPublic, relayed(relay, issuer)], issuer)).toBe('issuer-only');
		expect(cadreInvitationReach([issuerPublic, direct(other, 4001)], issuer)).toBe('local-network');
		expect(cadreInvitationReach([issuerPublic, `/ip4/127.0.0.1/tcp/4001/ws/p2p/${other}`], issuer)).toBe('local-network');
		expect(cadreInvitationReach([direct(issuer, 4001), direct(other, 4001), relayed(relay, other)], issuer)).toBe('anywhere');
	});
});
