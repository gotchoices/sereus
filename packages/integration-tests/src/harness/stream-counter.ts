/**
 * Counts the libp2p streams a node OPENS, per protocol, by wrapping
 * `connection.newStream` on every connection it holds now and every connection it
 * opens later.
 *
 * Outbound only, and deliberately: a stream is counted against the side that
 * initiated it, which is the question the relay round-trip measurements ask ("how
 * many requests does a commit cost the party that issued it?"). The receiving side's
 * handler is not instrumented, so a protocol only ever appears under the label of
 * the node that dialed it.
 *
 * Maintenance traffic — libp2p's own identify/ping/circuit protocols and FRET's ring
 * upkeep — is left out by default, because it runs on its own cadence and is not
 * caused by the operation being measured. Everything else is counted under its full
 * protocol id, so a protocol nobody anticipated still shows up rather than being
 * silently dropped.
 */

import type { Libp2p } from 'libp2p';
import type { Connection } from '@libp2p/interface';

export interface StreamTallyOptions {
	/** Return true to leave a protocol out of the counts (default {@link isMaintenanceProtocol}). */
	ignore?: (protocol: string) => boolean;
}

export interface StreamTally {
	/**
	 * Counts since the previous `take()`, keyed `<label> <protocol>`, and zero the
	 * tally. A window is therefore always "since the last time anybody looked", which
	 * is how an operation's own streams are separated from the settle window's.
	 */
	take(): Map<string, number>;
	/** Stop counting and unwrap every connection wrapped so far. */
	stop(): void;
}

/** libp2p's own upkeep and FRET's ring maintenance — not caused by the measured operation. */
export function isMaintenanceProtocol(protocol: string): boolean {
	return protocol.startsWith('/ipfs/')
		|| protocol.startsWith('/libp2p/')
		// `/optimystic/<network>/fret/1.0.0/…` — neighbours, announce, leave, ping.
		|| protocol.includes('/fret/');
}

/**
 * Wrap every connection of each `[label, node]` pair. Caller owns shutdown
 * (`tally.stop()`), which must run before the nodes are stopped so the wrappers do
 * not outlive the tally they write into.
 */
export function countOutboundStreams(
	nodes: Iterable<readonly [string, Libp2p]>,
	opts: StreamTallyOptions = {}
): StreamTally {
	const ignore = opts.ignore ?? isMaintenanceProtocol;
	const counts = new Map<string, number>();
	const wrapped = new Map<Connection, Connection['newStream']>();
	const unsubscribe: Array<() => void> = [];
	let counting = true;

	const wrap = (label: string, connection: Connection): void => {
		if (wrapped.has(connection)) return;
		const original = connection.newStream.bind(connection);
		wrapped.set(connection, connection.newStream);
		connection.newStream = async (protocols, options) => {
			const stream = await original(protocols, options);
			if (counting) {
				// The negotiated protocol, not the requested list: a caller may offer
				// several and only one is opened.
				const protocol = stream.protocol;
				if (!ignore(protocol)) {
					const key = `${label} ${protocol}`;
					counts.set(key, (counts.get(key) ?? 0) + 1);
				}
			}
			return stream;
		};
	};

	for (const [label, node] of nodes) {
		for (const connection of node.getConnections()) wrap(label, connection);
		const onOpen = (event: CustomEvent<Connection>): void => { wrap(label, event.detail); };
		node.addEventListener('connection:open', onOpen);
		unsubscribe.push(() => { node.removeEventListener('connection:open', onOpen); });
	}

	return {
		take() {
			const window = new Map(counts);
			counts.clear();
			return window;
		},
		stop() {
			counting = false;
			for (const cleanup of unsubscribe) cleanup();
			unsubscribe.length = 0;
			for (const [connection, original] of wrapped) connection.newStream = original;
			wrapped.clear();
		}
	};
}
