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

/** A machine reachable only through relays: the longest addresses, which ranking puts first. */
function relayedOnly(relays: readonly string[], peerId: string): string[] {
	return relays.map((relay) => relayed(relay, peerId));
}

describe('cadre invitation addresses', () => {
	it('keeps an invitation with three owner keys, and more relayed addresses offered than the cap, within one QR code', async () => {
		const relays = await Promise.all([0, 1, 2, 3, 4].map(newPeerId));
		const issuer = await newPeerId();
		const siblings: InvitationSibling[] = await Promise.all([0, 1, 2].map(async (i) => {
			const peerId = await newPeerId();
			return { peerId, updatedAt: i, addrs: relayedOnly(relays.slice(0, 4), peerId) };
		}));
		const members = selectCadreInvitationMembers(relayedOnly(relays, issuer), siblings, new Set());
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
		// Measured 2,206 characters with these shapes. The largest QR code holds 2,331 bytes at error-correction
		// level M (2,953 at L); a loosened cap or a new bundle field that crosses that fails here first.
		expect(encoded.length).toBeLessThanOrEqual(2_331);
	});

	it('keeps each machine\'s relayed address when loopback and private ones are listed ahead of it', async () => {
		const relay = await newPeerId();
		const issuer = await newPeerId();
		const sibling = await newPeerId();
		const loopback = (peerId: string): string => `/ip4/127.0.0.1/tcp/4001/ws/p2p/${peerId}`;
		// As libp2p reports a machine listening on every interface: loopback, then each private interface, then the relay.
		const own = [loopback(issuer), direct(issuer, 4001), direct(issuer, 4002), direct(issuer, 4003), relayed(relay, issuer)];
		const siblingAddrs = [loopback(sibling), direct(sibling, 4001), relayed(relay, sibling)];

		const members = selectCadreInvitationMembers(own, [{ peerId: sibling, updatedAt: 0, addrs: siblingAddrs }], new Set());

		expect(members).toEqual([relayed(relay, issuer), direct(issuer, 4001), direct(issuer, 4002), direct(issuer, 4003), relayed(relay, sibling), direct(sibling, 4001)]);
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
