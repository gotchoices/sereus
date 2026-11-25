import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';

import { encodeCadreInvitation } from '../src/cadre-invite-protocol.js';
import { generateStampId } from '../src/control-database.js';
import {
	cadreInvitationReach,
	selectCadreInvitationMembers,
	selectOpenInvitationBootstrap,
	type InvitationSibling,
} from '../src/invitation-bootstrap.js';
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

/** The WebRTC address the same relay carries the signalling for: a relay hop, then ICE. */
function webrtc(relay: string, peerId: string): string {
	return `/ip4/203.0.113.10/tcp/443/wss/p2p/${relay}/p2p-circuit/webrtc/p2p/${peerId}`;
}

/** A machine reachable only through relays: the longest addresses, which ranking puts first. */
function relayedOnly(relays: readonly string[], peerId: string): string[] {
	return relays.map((relay) => relayed(relay, peerId));
}

/**
 * What a machine listening on `/webrtc` publishes for each relay it holds a slot on, in the
 * order it reports them: `webrtcListenAddrs` puts the `/webrtc` entry ahead of the relay's own
 * `/p2p-circuit` one, so the WebRTC address of each relay arrives first.
 */
function webrtcAndRelayed(relays: readonly string[], peerId: string): string[] {
	return relays.flatMap((relay) => [webrtc(relay, peerId), relayed(relay, peerId)]);
}

/** What libp2p reports for a phone or laptop listening on every interface: loopback, private, then relayed. */
function deviceAddrs(relay: string, peerId: string): string[] {
	return [`/ip4/127.0.0.1/tcp/4001/ws/p2p/${peerId}`, direct(peerId, 4001), relayed(relay, peerId)];
}

/** A sibling with no evidence beyond its record unless `evidence` gives some. */
function sibling(peerId: string, addrs: string[], evidence: Partial<InvitationSibling> = {}): InvitationSibling {
	return { peerId, addrs, updatedAt: 0, alwaysOn: false, reachability: 0, tenureMs: 0, ...evidence };
}

describe('cadre invitation addresses', () => {
	it('keeps an invitation with three owner keys, and more relayed addresses offered than the cap, within one QR code', async () => {
		const relays = await Promise.all([0, 1, 2, 3, 4].map(newPeerId));
		const issuer = await newPeerId();
		const siblings: InvitationSibling[] = await Promise.all([0, 1, 2].map(async (i) => {
			const peerId = await newPeerId();
			return sibling(peerId, relayedOnly(relays.slice(0, 4), peerId), { updatedAt: i });
		}));
		const members = selectCadreInvitationMembers({ addrs: relayedOnly(relays, issuer), alwaysOn: true }, siblings);
		const owners = [freshKeyPair(), freshKeyPair(), freshKeyPair()];
		const signed = {
			key: freshKeyPair().publicKey,
			peerId: await newPeerId(),
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
		const other = await newPeerId();
		const loopback = (peerId: string): string => `/ip4/127.0.0.1/tcp/4001/ws/p2p/${peerId}`;
		// As libp2p reports a machine listening on every interface: loopback, then each private interface, then the relay.
		const own = [loopback(issuer), direct(issuer, 4001), direct(issuer, 4002), direct(issuer, 4003), relayed(relay, issuer)];

		const members = selectCadreInvitationMembers({ addrs: own, alwaysOn: true }, [sibling(other, deviceAddrs(relay, other))]);

		expect(members).toEqual([relayed(relay, issuer), direct(issuer, 4001), direct(issuer, 4002), direct(issuer, 4003), relayed(relay, other), direct(other, 4001)]);
	});

	it('fills the cap with a machine\'s relayed addresses before its WebRTC ones', async () => {
		// A WebRTC address connects only if ICE finds a path between the two networks, and
		// otherwise answers nothing for about 23 s — so under the cap that keeps an invitation
		// inside one QR code it must not take a relayed address's place. The sibling's two slots
		// both go to addresses that connect without ICE.
		const relays = await Promise.all([0, 1].map(newPeerId));
		const issuer = await newPeerId();
		const other = await newPeerId();

		const members = selectCadreInvitationMembers(
			{ addrs: webrtcAndRelayed(relays, issuer), alwaysOn: true },
			[sibling(other, webrtcAndRelayed(relays, other))]
		);

		expect(members).toEqual([
			relayed(relays[0]!, issuer), relayed(relays[1]!, issuer),
			webrtc(relays[0]!, issuer), webrtc(relays[1]!, issuer),
			relayed(relays[0]!, other), relayed(relays[1]!, other),
		]);
	});

	it('names a phone that is its party\'s only machine first, with its usual four addresses', async () => {
		const relays = await Promise.all([0, 1, 2, 3, 4].map(newPeerId));
		const phone = await newPeerId();

		const members = selectCadreInvitationMembers({ addrs: relayedOnly(relays, phone), alwaysOn: false }, []);

		expect(members).toEqual(relayedOnly(relays.slice(0, 4), phone));
		expect(cadreInvitationReach(members, phone)).toBe('issuer-only');
	});

	it('names a phone behind its party\'s always-on machines and ahead of its other devices, with one address held inside the cap', async () => {
		// The phone is usually closed by the time its invitation is redeemed, and a dead relayed
		// address costs a whole dial budget before the next machine is tried.
		const relays = await Promise.all([0, 1].map(newPeerId));
		const [phone, serverA, serverB, laptop] = await Promise.all([0, 1, 2, 3].map(newPeerId));
		const siblings = [
			sibling(laptop!, relayedOnly(relays, laptop!), { updatedAt: 3, reachability: 2 }),
			sibling(serverA!, [relayed(relays[0]!, serverA!), direct(serverA!, 4001)], { alwaysOn: true, updatedAt: 2 }),
			sibling(serverB!, [relayed(relays[0]!, serverB!), direct(serverB!, 4001)], { alwaysOn: true, updatedAt: 1 }),
		];
		const servers = [relayed(relays[0]!, serverA!), direct(serverA!, 4001), relayed(relays[0]!, serverB!), direct(serverB!, 4001)];

		const members = selectCadreInvitationMembers({ addrs: deviceAddrs(relays[0]!, phone!), alwaysOn: false }, siblings);
		// Its relay down, the phone has no address, and the siblings take every slot.
		const withoutOwn = selectCadreInvitationMembers({ addrs: [], alwaysOn: false }, siblings);

		expect(members).toEqual([...servers, relayed(relays[0]!, phone!), relayed(relays[0]!, laptop!)]);
		expect(withoutOwn).toEqual([...servers, ...relayedOnly(relays, laptop!)]);
	});

	it('names a phone first when every other machine named is a device too', async () => {
		const relay = await newPeerId();
		const [phone, laptop] = await Promise.all([0, 1].map(newPeerId));

		const members = selectCadreInvitationMembers(
			{ addrs: deviceAddrs(relay, phone!), alwaysOn: false },
			[sibling(laptop!, deviceAddrs(relay, laptop!), { reachability: 2, tenureMs: 3_600_000 })]
		);

		expect(members).toEqual([
			relayed(relay, phone!), direct(phone!, 4001), `/ip4/127.0.0.1/tcp/4001/ws/p2p/${phone!}`,
			relayed(relay, laptop!), direct(laptop!, 4001),
		]);
	});

	it('ranks the other machines by always on, then reachability now, then tenure, then the newest record', async () => {
		// A live connection outranks tenure, because tenure stops growing while a peer is silent.
		const relay = await newPeerId();
		const [server, connected, longest, newest] = await Promise.all([0, 1, 2, 3].map(newPeerId));
		const siblings = [
			sibling(newest!, [relayed(relay, newest!)], { reachability: 1, tenureMs: 1_000, updatedAt: 9 }),
			sibling(longest!, [relayed(relay, longest!)], { reachability: 1, tenureMs: 3_600_000, updatedAt: 1 }),
			sibling(connected!, [relayed(relay, connected!)], { reachability: 2, updatedAt: 1 }),
			sibling(server!, [relayed(relay, server!)], { alwaysOn: true, updatedAt: 0 }),
		];

		const bootstrap = selectOpenInvitationBootstrap({ addrs: [], alwaysOn: true }, siblings);

		expect(bootstrap).toEqual([relayed(relay, server!), relayed(relay, connected!), relayed(relay, longest!)]);
	});

	it('counts a WebRTC address as reaching from anywhere, since its relay carries signalling from any network', async () => {
		const issuer = await newPeerId();
		const other = await newPeerId();
		const relay = await newPeerId();

		expect(cadreInvitationReach([direct(issuer, 4001), webrtc(relay, other)], issuer)).toBe('anywhere');
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
