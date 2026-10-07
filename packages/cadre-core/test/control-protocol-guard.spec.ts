import { describe, it, expect, vi } from 'vitest';
import type { Connection, Libp2p, Stream, StreamHandler, StreamHandlerRecord } from '@libp2p/interface';
import { CadreNode } from '../src/cadre-node.js';
import {
	ControlStreamRefusedError,
	controlProtocolClasses,
	installControlProtocolGuard,
	type ControlProtocolGuardOptions
} from '../src/control-protocol-guard.js';
import { SEED_PROTOCOL } from '../src/seed-bootstrap.js';
import { WAKE_PROTOCOL } from '../src/strand-wake-protocol.js';

/**
 * The control node's per-stream protocol guard (`control-protocol-guard.ts`): every protocol a
 * running control node serves is classed, the stranger-open set is exactly the three Sereus
 * protocols that make their own trust decision, and the wrapper the guard puts on a handler
 * admits or refuses by class, failing closed. The wire-level effect on a real outsider is
 * `control-stream-authz.integration.ts`.
 */
describe('control protocol guard', () => {
	it('classes every protocol a control node serves with every conditional protocol on', async () => {
		// Storage profile so the relay server's hop protocol is registered, plus the seed
		// listener, which an embedder enables after start. A protocol added by a new handler or
		// an Optimystic, FRET or libp2p upgrade fails this until someone declares its class.
		const partyId = `guard-${Math.random().toString(36).slice(2)}`;
		const node = new CadreNode({ controlNetwork: { partyId, bootstrapNodes: [] }, profile: 'storage' });
		try {
			await node.start();
			await node.enableSeedListener();
			const classes = controlProtocolClasses(partyId);
			const unclassified = node.getControlNode()!.getProtocols().filter((protocol) => !classes.has(protocol));
			expect(unclassified).toEqual([]);
		} finally {
			await node.stop();
		}
	}, 60_000);

	it('declares exactly the seed, formation and cadre-invite protocols open to strangers', () => {
		// Literal wire ids, so widening the set (or renaming one of them) cannot pass silently.
		const open = [...controlProtocolClasses('any-party')]
			.filter(([, protocolClass]) => protocolClass === 'stranger-open')
			.map(([protocol]) => protocol);
		expect(open).toEqual(['/sereus/seed/1.0.0', '/sereus/formation/1.0.0', '/sereus/cadre-invite/1.0.0']);
	});

	type Predicates = Pick<ControlProtocolGuardOptions, 'isMemberLive' | 'isMemberSnapshot'>;
	const refuseAll: Predicates = { isMemberLive: async () => false, isMemberSnapshot: () => false };
	const unclassified = '/somebody/forgot-to-class-this/1.0.0';

	it.each<[string, string, Partial<Predicates>, boolean]>([
		['a live member', WAKE_PROTOCOL, { isMemberLive: async () => true }, true],
		['a live non-member', WAKE_PROTOCOL, {}, false],
		['a live check that throws', WAKE_PROTOCOL, { isMemberLive: async () => { throw new Error('read failed'); } }, false],
		['a live check that never settles', WAKE_PROTOCOL, { isMemberLive: () => new Promise<boolean>(() => {}) }, false],
		['a snapshot member on an unclassified protocol', unclassified, { isMemberSnapshot: () => true }, true],
		['a snapshot non-member on an unclassified protocol', unclassified, {}, false],
		['a stranger on a stranger-open protocol', SEED_PROTOCOL, {}, true],
	])('%s: handler runs = %s', async (_case, protocol, predicates, admitted) => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			const handler = vi.fn<StreamHandler>();
			const record: StreamHandlerRecord = { handler, options: { maxInboundStreams: 3, runOnLimitedConnection: true } };
			const registrar = { getHandler: (_protocol: string): StreamHandlerRecord => record };
			installControlProtocolGuard({ components: { registrar } } as unknown as Libp2p, {
				partyId: 'guard-party', ...refuseAll, ...predicates, liveDecisionTimeoutMs: 20
			});
			const abort = vi.fn();
			const stream = { abort } as unknown as Stream;
			const connection = { remotePeer: { toString: () => 'remote-peer' } } as unknown as Connection;

			const guarded = registrar.getHandler(protocol);
			await guarded.handler(stream, connection);

			// libp2p reads stream limits and the limited-connection flag through the same lookup.
			expect(guarded.options).toBe(record.options);
			expect(handler).toHaveBeenCalledTimes(admitted ? 1 : 0);
			if (admitted) {
				expect(abort).not.toHaveBeenCalled();
			} else {
				expect(abort).toHaveBeenCalledWith(expect.any(ControlStreamRefusedError));
			}
		} finally {
			warn.mockRestore();
		}
	});
});
