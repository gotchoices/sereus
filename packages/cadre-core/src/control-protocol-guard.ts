/**
 * The per-stream protocol guard on the control node: ONE declaration of what a peer must be to
 * open a stream on each protocol the control node serves ({@link controlProtocolClasses}), and
 * ONE place that enforces it for every handler, whoever registered it — Sereus, Optimystic,
 * FRET or libp2p ({@link installControlProtocolGuard}).
 *
 * It is the fail-closed layer behind the fail-open connection gate
 * (`membership-connection-gater.ts`). That gate decides per CONNECTION and must admit strangers
 * in several windows (an open formation invitation, a live cadre invitation, relay-only
 * admission on a node running the relay server, a delegate grant); this guard is what keeps a
 * stranger on such a connection to the protocols declared open to it. A handler therefore never
 * checks membership itself, and a handler added later cannot open a hole by forgetting to: a
 * protocol missing from the table is guarded as members-only (see "Unclassified protocols").
 *
 * ## The classes
 *
 *  - `stranger-open` — seed delivery, strand formation, cadre-invitation redemption. Any peer;
 *    each handler makes its own trust decision in-protocol (a seed signature against the
 *    anchored trust policy, a formation token, an invitation's possession proof).
 *  - `transport` — libp2p plumbing (identify, ping, hole punching, AutoNAT, the circuit-relay
 *    stop and hop protocols, WebRTC signaling). Every connection runs these, the redeeming
 *    device's own included: refusing identify would make that device treat the member as
 *    off-network. What they expose is the node's listen and observed addresses, its protocol
 *    list (whose `/optimystic/control-<partyId>` prefix names the party id, which an invitation
 *    bundle already carries) and its public key. AutoNAT v1 (`@libp2p/autonat` 3.0.28) dials
 *    back only public addresses on the requester's own observed host, and refuses a request made
 *    on another peer's behalf, so it cannot be pointed at a third machine. Relay reservations
 *    are decided separately, at the connection gate's reservation hook.
 *  - `members` — wake and strand-addr. Authorized members by the voucher-anchored LIVE read
 *    (`CadreNode.isAuthorizedMember`), the check those handlers made themselves before this
 *    guard existed, so moving it here changes nobody's admission. That matters most for
 *    strand-addr's delegate grant, which hands out connection and relay admission. The live read
 *    also has no window during `start()` where it admits everyone, which the snapshot does.
 *  - `members-snapshot` — the four Optimystic control-database protocols and the five FRET
 *    protocols. Authorized members by the in-memory snapshot
 *    (`CadreNode.authorizeInboundControlStream`). These serve the reads a live membership check
 *    would itself make, so a live read from inside their guard would deadlock two machines into
 *    refusing each other; the snapshot is synchronous and reads nothing.
 *
 * ## Mechanism: the registrar's handler lookup
 *
 * libp2p dispatches every inbound stream through `components.registrar.getHandler(protocol)`
 * (`libp2p/dist/src/connection.js`, `onIncomingStream`). The guard replaces `getHandler` on the
 * control node's registrar instance with one that returns the registered record with its
 * handler wrapped for the protocol's class. A handler registered at any time, before or after
 * the guard, is therefore guarded at dispatch, with no sweep over registrations and no race
 * against a late one (the seed listener, a replaced formation handler).
 *
 * The record's `options` object is passed through unchanged: libp2p also reads it through
 * `getHandler` for stream limits (`findIncomingStreamLimit`, `findOutgoingStreamLimit`) and for
 * `runOnLimitedConnection`.
 *
 * libp2p's own stream middleware (`libp2p.use`) is NOT used. In libp2p 3.3.11 `onIncomingStream`
 * pushes the handler call onto the very array `registrar.getMiddleware` returns, so every inbound
 * stream appends another handler call to the stored chain and outbound streams then run those
 * too (read from the source, not run). Revisit if a libp2p upgrade stops mutating that array.
 *
 * ## Denial
 *
 * A refused stream is aborted with {@link ControlStreamRefusedError} before its handler runs, so
 * nothing is decoded and nothing goes on the wire: telling a stranger "you are not a member"
 * would confirm membership state to it. The refusal is logged on this node with peer, protocol
 * and reason. The live read fails closed: a false result, a throw and a read slower than
 * {@link ControlProtocolGuardOptions.liveDecisionTimeoutMs} all refuse.
 *
 * ## Unclassified protocols
 *
 * A protocol missing from the table is guarded as `members-snapshot`, with one `console.warn` per
 * protocol: it works for members and refuses strangers until someone classes it.
 * `control-protocol-guard.spec.ts` starts a node with every conditional protocol on and fails
 * when any protocol it serves is unclassified, so an upgrade that adds one fails CI.
 */

import debug from 'debug';
import type { Connection, Libp2p, Stream, StreamHandler, StreamHandlerRecord } from '@libp2p/interface';
import { SEED_PROTOCOL } from './seed-bootstrap.js';
import { FORMATION_PROTOCOL } from './strand-formation-protocol.js';
import { CADRE_INVITE_PROTOCOL } from './cadre-invite-protocol.js';
import { WAKE_PROTOCOL } from './strand-wake-protocol.js';
import { STRAND_ADDR_PROTOCOL } from './strand-addr-protocol.js';
import { withTimeout } from './control-stream.js';

const log = debug('sereus:cadre:control-protocol-guard');

/** What a peer must be to open a stream on a control-node protocol (see the module doc). */
export type ControlProtocolClass =
	/** Any peer. The handler makes its own trust decision in-protocol (seed, formation, cadre-invite). */
	| 'stranger-open'
	/** libp2p plumbing that a stranger's connection needs or that carries no party data. */
	| 'transport'
	/** Authorized members by the voucher-anchored live read (`isAuthorizedMember`). For Sereus application protocols. */
	| 'members'
	/** Authorized members by the in-memory snapshot (`authorizeInboundControlStream`). For anything a control-database read itself depends on. */
	| 'members-snapshot';

/** The class a protocol missing from {@link controlProtocolClasses} is guarded as. */
export const UNCLASSIFIED_PROTOCOL_CLASS: ControlProtocolClass = 'members-snapshot';

/** Stable error code carried by {@link ControlStreamRefusedError}. */
export const CONTROL_STREAM_REFUSED_CODE = 'ERR_CONTROL_STREAM_REFUSED';

/**
 * The reason a control-node stream was aborted by the guard, so this node's logs can tell a
 * refusal from a transport fault. The remote only ever sees the stream reset.
 */
export class ControlStreamRefusedError extends Error {
	readonly code = CONTROL_STREAM_REFUSED_CODE;

	constructor(remotePeerId: string, protocol: string, reason: string) {
		super(`control stream refused: peer=${remotePeerId} protocol=${protocol} reason=${reason}`);
		this.name = 'ControlStreamRefusedError';
	}
}

/**
 * The control libp2p node's Optimystic network name. `db-p2p` namespaces the node's protocol ids
 * as `/optimystic/<networkName>/...`, so this is the one binding every control-network derivation
 * starts from: the node options, the block-transfer prefix the control backfill dials, and the
 * class table below.
 *
 * NOTE: the party id goes in UNENCODED here, unlike in `controlStorageScope`. Safe today because a
 * party id is locally configured rather than replicated in, and both ends of a connection derive
 * this string identically: an odd party id yields an odd but consistent protocol id, not a
 * mismatch or an escaped name. If a party id ever arrives from the network, encode it here as the
 * storage scope key already does.
 */
export function controlNetworkName(partyId: string): string {
	return `control-${partyId}`;
}

/**
 * The class of every protocol a control node serves, by exact protocol id: the single
 * declaration the guard enforces. See the module doc for what each class admits and why each
 * protocol is in it.
 */
export function controlProtocolClasses(partyId: string): ReadonlyMap<string, ControlProtocolClass> {
	const prefix = `/optimystic/${controlNetworkName(partyId)}`;
	const fret = `${prefix}/fret/1.0.0`;
	return new Map<string, ControlProtocolClass>([
		[SEED_PROTOCOL, 'stranger-open'],
		[FORMATION_PROTOCOL, 'stranger-open'],
		[CADRE_INVITE_PROTOCOL, 'stranger-open'],

		[WAKE_PROTOCOL, 'members'],
		[STRAND_ADDR_PROTOCOL, 'members'],

		[`${prefix}/repo/1.0.0`, 'members-snapshot'],
		[`${prefix}/cluster/1.0.0`, 'members-snapshot'],
		[`${prefix}/db-p2p/sync/1.0.0`, 'members-snapshot'],
		[`${prefix}/db-p2p/block-transfer/1.0.0`, 'members-snapshot'],
		[`${fret}/neighbors`, 'members-snapshot'],
		[`${fret}/neighbors/announce`, 'members-snapshot'],
		[`${fret}/maybeAct`, 'members-snapshot'],
		[`${fret}/leave`, 'members-snapshot'],
		[`${fret}/ping`, 'members-snapshot'],

		[`${prefix}/id/1.0.0`, 'transport'],
		[`${prefix}/id/push/1.0.0`, 'transport'],
		['/ipfs/ping/1.0.0', 'transport'],
		['/libp2p/dcutr', 'transport'],
		['/libp2p/autonat/1.0.0', 'transport'],
		['/libp2p/circuit/relay/0.2.0/stop', 'transport'],
		// Registered only while the relay server runs (the storage profile's default).
		['/libp2p/circuit/relay/0.2.0/hop', 'transport'],
		// Registered only when an embedder's `network.transports` includes WebRTC.
		['/webrtc-signaling/0.0.1', 'transport'],
	]);
}

/** What {@link installControlProtocolGuard} needs from its host (`CadreNode`). */
export interface ControlProtocolGuardOptions {
	/** The party whose control network the node serves; names the `/optimystic/control-<partyId>` protocols. */
	partyId: string;
	/** The `members` class predicate: `CadreNode.isAuthorizedMember`. Only a literal `true` admits. */
	isMemberLive(remotePeerId: string): Promise<boolean>;
	/** The `members-snapshot` class predicate: `CadreNode.authorizeInboundControlStream`. Synchronous and in-memory. */
	isMemberSnapshot(remotePeerId: string, protocol: string): boolean;
	/**
	 * How long one {@link isMemberLive} read may take before the stream is refused. `CadreNode`
	 * passes the asker's own attempt deadline at this node's declared link (`relayedRequestBudgetMs`),
	 * so the guard never cuts off a check the asker would still be waiting for: a shorter cut would
	 * refuse members whose check completes in time today.
	 */
	liveDecisionTimeoutMs: number;
}

/** The slice of libp2p's internal registrar the guard replaces. */
interface GuardableRegistrar {
	getHandler(protocol: string): StreamHandlerRecord;
}

function isGuardableRegistrar(value: unknown): value is GuardableRegistrar {
	return typeof value === 'object' && value !== null
		&& typeof (value as { getHandler?: unknown }).getHandler === 'function';
}

/**
 * The control node's registrar, which is not on libp2p's public `Libp2p` type. Throws when the
 * shape is absent (a libp2p upgrade that moved it), which fails `CadreNode.start()`: a control
 * node without the guard must not run.
 */
function controlRegistrar(node: Libp2p): GuardableRegistrar {
	let registrar: unknown;
	try {
		// libp2p's components object is a Proxy that throws for a component it does not hold.
		registrar = (node as unknown as { components?: { registrar?: unknown } }).components?.registrar;
	} catch (error) {
		throw new Error('control-protocol guard: the control node exposes no registrar component; refusing to run unguarded', { cause: error });
	}
	if (!isGuardableRegistrar(registrar)) {
		throw new Error('control-protocol guard: the control node\'s registrar has no getHandler; refusing to run unguarded');
	}
	return registrar;
}

/**
 * Guard every inbound stream on `node` by its protocol's class (see the module doc). Call once,
 * on the control node, before it holds any connection: `CadreNode.start()` calls it right after
 * the node is built, inside the bring-up quiet period. Throws when the node's registrar is not
 * the shape the guard replaces.
 */
export function installControlProtocolGuard(node: Libp2p, options: ControlProtocolGuardOptions): void {
	const registrar = controlRegistrar(node);
	const guard = new ControlProtocolGuard(options);
	const lookup = registrar.getHandler.bind(registrar);
	// An unregistered protocol still throws libp2p's own UnhandledProtocolError, from `lookup`.
	registrar.getHandler = (protocol: string): StreamHandlerRecord => guard.recordFor(protocol, lookup(protocol));
	log('Guarding the control node\'s inbound streams for party %s', options.partyId);
}

/** The per-node state behind {@link installControlProtocolGuard}. */
class ControlProtocolGuard {
	private readonly classes: ReadonlyMap<string, ControlProtocolClass>;
	/**
	 * The guarded copy of each registered record, so the lookups libp2p makes per stream (the
	 * stream-limit read, then the dispatch) allocate nothing. Keyed on the registrar's own record,
	 * which a re-registration replaces, so a replaced handler gets a fresh wrapper.
	 */
	private readonly guarded = new WeakMap<StreamHandlerRecord, StreamHandlerRecord>();
	private readonly warnedUnclassified = new Set<string>();

	constructor(private readonly options: ControlProtocolGuardOptions) {
		this.classes = controlProtocolClasses(options.partyId);
	}

	recordFor(protocol: string, record: StreamHandlerRecord): StreamHandlerRecord {
		const protocolClass = this.classOf(protocol);
		if (protocolClass === 'stranger-open' || protocolClass === 'transport') {
			return record;
		}
		let guarded = this.guarded.get(record);
		if (!guarded) {
			guarded = { ...record, handler: this.wrap(protocol, protocolClass, record.handler) };
			this.guarded.set(record, guarded);
		}
		return guarded;
	}

	private classOf(protocol: string): ControlProtocolClass {
		const declared = this.classes.get(protocol);
		if (declared) {
			return declared;
		}
		if (!this.warnedUnclassified.has(protocol)) {
			this.warnedUnclassified.add(protocol);
			console.warn(`Control node serves ${protocol}, which has no class in controlProtocolClasses ` +
				`(control-protocol-guard.ts); guarding it as ${UNCLASSIFIED_PROTOCOL_CLASS}, so strangers are refused on it. ` +
				'Declare its class.');
		}
		return UNCLASSIFIED_PROTOCOL_CLASS;
	}

	private wrap(protocol: string, protocolClass: 'members' | 'members-snapshot', handler: StreamHandler): StreamHandler {
		if (protocolClass === 'members') {
			// NOTE: the handler starts reading only once the live read settles, usually after the
			// asker has half-closed, and a plain `for await` over a libp2p 3.3.11 stream never ends
			// there (see `collect` in control-stream.ts). Wake and strand-addr read through
			// `readStreamToEnd`, which handles it; a handler added to this class must too.
			return async (stream: Stream, connection: Connection): Promise<void> => {
				const remotePeerId = connection.remotePeer.toString();
				const refusal = await this.liveRefusal(remotePeerId);
				if (refusal !== undefined) {
					refuse(stream, remotePeerId, protocol, refusal);
					return;
				}
				await handler(stream, connection);
			};
		}
		return (stream: Stream, connection: Connection): void | Promise<void> => {
			const remotePeerId = connection.remotePeer.toString();
			const refusal = this.snapshotRefusal(remotePeerId, protocol);
			if (refusal !== undefined) {
				refuse(stream, remotePeerId, protocol, refusal);
				return;
			}
			return handler(stream, connection);
		};
	}

	/**
	 * Why the live read refuses `remotePeerId`, or undefined when it admits.
	 *
	 * NOTE: a stranger's stream now costs one live membership read before it is refused, and the
	 * handlers' concurrency caps no longer bound those reads; libp2p's per-connection
	 * `maxInboundStreams` (32 per protocol) does. Fine while that read touches only held blocks.
	 * If refused strangers ever show up as load, refuse a peer absent from the snapshot before the
	 * live read.
	 */
	private async liveRefusal(remotePeerId: string): Promise<string | undefined> {
		try {
			const member = await withTimeout(
				this.options.liveDecisionTimeoutMs,
				`membership check for ${remotePeerId}`,
				() => this.options.isMemberLive(remotePeerId)
			);
			return member === true ? undefined : 'not an authorized member';
		} catch (error) {
			return `membership check failed: ${error instanceof Error ? error.message : String(error)}`;
		}
	}

	/** Why the snapshot refuses `remotePeerId` on `protocol`, or undefined when it admits. */
	private snapshotRefusal(remotePeerId: string, protocol: string): string | undefined {
		try {
			return this.options.isMemberSnapshot(remotePeerId, protocol) === true
				? undefined
				: 'not in the authorized-member snapshot';
		} catch (error) {
			return `snapshot check threw: ${error instanceof Error ? error.message : String(error)}`;
		}
	}
}

/** Log a refusal and reset the stream before its handler runs. */
function refuse(stream: Stream, remotePeerId: string, protocol: string, reason: string): void {
	log('Refusing %s on %s: %s', remotePeerId, protocol, reason);
	try {
		stream.abort(new ControlStreamRefusedError(remotePeerId, protocol, reason));
	} catch (error) {
		// The stream may already be gone; the refusal stands either way.
		log('Aborting the refused stream from %s on %s failed: %o', remotePeerId, protocol, error);
	}
}
