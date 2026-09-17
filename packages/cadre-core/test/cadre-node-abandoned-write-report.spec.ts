import { describe, it, expect, vi } from 'vitest';
import { CadreNode } from '../src/cadre-node.js';
import { DEFAULT_PEER_RECORD_MAX_AGE_MS } from '../src/peer-record.js';
import type { CadreNodeConfig } from '../src/types.js';
import type { ControlRetryAbandonment } from '../src/control-retry.js';

/**
 * What a node DOES with an abandoned control write: re-emit it as an event, and escalate the
 * one case that degrades the party on its own.
 *
 * The seam this covers used to lose writes in silence. `ControlDatabase.lockedWithRetry` gives
 * up on a write two ways — the classifier declining it, or attempts/budget running out — and
 * both only wrote a `debug('sereus:cadre:control-db')` line, a namespace nothing enables by
 * default. Foreground writes still reject to their caller, but the BACKGROUND ones (the
 * self-address republish in `startRecordRefresh`, and the two replication drains) are fired
 * unawaited with a `debug`-only catch, so nothing reached the machine, the operator or the
 * embedding app. Measured 2026-09-17: a run of
 * `control-write-degraded-cohort-member.integration.ts` reported `7 passed` while a node's
 * background `[self-record-update]` had been abandoned for good during it.
 *
 * Both methods under test read only private fields and `this.eventHandlers`, so they run on a
 * bare `new CadreNode(config)` through the same private cast
 * `cadre-node-announce-addrs-warning.spec.ts` uses — no libp2p node, no database, no clock to
 * wait out. The wiring that connects them to a real database (`start()` sets the listener,
 * teardown clears it) is asserted where that listener lives, in `control-write-retry.spec.ts`.
 */

/** The private surface these cases drive. */
interface NodeInternals {
	noteControlWriteAbandoned(abandonment: ControlRetryAbandonment): void;
	escalateIfSelfRecordStale(reason: string, error: unknown): void;
	noteSelfRecordPublished(): void;
	lastSelfRecordPublishAt: number | null;
	selfRecordStaleWarned: boolean;
}

/**
 * A node and a private view of the SAME object. Kept as two references rather than an
 * intersection type: `CadreNode & NodeInternals` collapses to `never`, because a type cannot
 * both declare a member private and re-declare it.
 */
function bareNode(): { node: CadreNode; internals: NodeInternals } {
	const config: CadreNodeConfig = {
		controlNetwork: {
			partyId: 'abandoned-write-report-' + Math.random().toString(36).slice(2),
			bootstrapNodes: []
		},
		profile: 'transaction'
	};
	const node = new CadreNode(config);
	return { node, internals: node as unknown as NodeInternals };
}

function abandonment(overrides: Partial<ControlRetryAbandonment> = {}): ControlRetryAbandonment {
	return {
		label: 'self-record-update',
		attemptsMade: 1,
		attemptsAllowed: 3,
		elapsedMs: 42,
		reason: 'declined',
		error: new Error('sync for collection default/cadrecontrol/CadrePeer exhausted 10 retries: '
			+ 'pending conflict: block(s) held by unresolved rival action(s) f7cM8wOiFkZ4O_bOrXFVQQ'),
		...overrides
	};
}

/**
 * Warnings emitted while `body` runs, filtered to this node's own — asserted by content
 * rather than against `console.warn` as a whole, so an unrelated warning cannot turn these
 * into false failures (same rule as the announceAddrs warning spec).
 */
function selfRecordWarnings(body: () => void): string[] {
	const warn = vi.spyOn(console, 'warn').mockImplementation(() => { });
	try {
		body();
		return warn.mock.calls
			.map((call) => String(call[0]))
			.filter((message) => message.includes('has not published its own address record'));
	} finally {
		warn.mockRestore();
	}
}

describe('CadreNode reports an abandoned control write', () => {
	it('re-emits it as control:write-abandoned, unchanged', () => {
		const { node, internals } = bareNode();
		const seen: ControlRetryAbandonment[] = [];
		node.on('control:write-abandoned', (event) => { seen.push(event); });

		const lost = abandonment();
		internals.noteControlWriteAbandoned(lost);

		// Identity: an app classifies the loss with the same error object and matchers the
		// funnel saw, so nothing may be re-wrapped on the way out.
		expect(seen).toEqual([lost]);
		expect(seen[0]!.error).toBe(lost.error);
	});

	/** No listener is the normal case for an embedder that does not care; it must not throw. */
	it('does not require a listener', () => {
		expect(() => bareNode().internals.noteControlWriteAbandoned(abandonment())).not.toThrow();
	});
});

/**
 * The escalation, whose bar is the CONSEQUENCE rather than a failure count: other machines
 * discard a `CadrePeer` record older than `DEFAULT_PEER_RECORD_MAX_AGE_MS`, so once this node
 * has gone that long without publishing, it is unreachable to any member not already
 * connected — and nothing else says so.
 */
describe('CadreNode escalates a self-address record it can no longer publish', () => {
	it('stays silent when the node has never published in this session', () => {
		const { internals } = bareNode();
		// A node with no row of its own (not a member yet, revoked, no signing key) has
		// nothing out there to go stale, and `registerSelf` already logs why it skipped.
		expect(internals.lastSelfRecordPublishAt).toBeNull();

		expect(selfRecordWarnings(() => internals.escalateIfSelfRecordStale('heartbeat', new Error('nope'))))
			.toEqual([]);
	});

	/**
	 * A single missed heartbeat is half the freshness budget and costs nothing — warning on a
	 * failure COUNT would fire here, which is exactly why the bar is the elapsed gap.
	 */
	it('stays silent while the published record is still fresh elsewhere', () => {
		const { internals } = bareNode();
		internals.lastSelfRecordPublishAt = Date.now() - (DEFAULT_PEER_RECORD_MAX_AGE_MS - 60_000);

		expect(selfRecordWarnings(() => internals.escalateIfSelfRecordStale('heartbeat', new Error('nope'))))
			.toEqual([]);
	});

	it('warns once the gap exceeds the freshness ceiling, naming the consequence', () => {
		const { internals } = bareNode();
		internals.lastSelfRecordPublishAt = Date.now() - (DEFAULT_PEER_RECORD_MAX_AGE_MS + 60_000);

		const warnings = selfRecordWarnings(() =>
			internals.escalateIfSelfRecordStale('heartbeat', new Error('pending conflict: block held')));

		expect(warnings).toHaveLength(1);
		// What an operator needs from it: the consequence in plain terms, the failure that
		// caused it, and that the node has not given up.
		expect(warnings[0]).toContain('[sereus]');
		expect(warnings[0]).toContain('can no longer reach it');
		expect(warnings[0]).toContain('pending conflict: block held');
		expect(warnings[0]).toContain('reported once');
	});

	/** Say-once: a node that stays broken must not warn every 7.5-minute heartbeat. */
	it('warns once, not on every later failure', () => {
		const { internals } = bareNode();
		internals.lastSelfRecordPublishAt = Date.now() - (DEFAULT_PEER_RECORD_MAX_AGE_MS + 60_000);

		const warnings = selfRecordWarnings(() => {
			internals.escalateIfSelfRecordStale('heartbeat', new Error('first'));
			internals.escalateIfSelfRecordStale('heartbeat', new Error('second'));
			internals.escalateIfSelfRecordStale('self:peer:update', new Error('third'));
		});

		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain('first');
	});

	/**
	 * Re-armed by a successful publish, so a node that recovers and then breaks again is
	 * reported again — the warning describes a live condition, not a once-per-process event.
	 */
	it('re-arms on the next successful publish', () => {
		const { internals } = bareNode();
		internals.lastSelfRecordPublishAt = Date.now() - (DEFAULT_PEER_RECORD_MAX_AGE_MS + 60_000);

		const first = selfRecordWarnings(() => internals.escalateIfSelfRecordStale('heartbeat', new Error('before')));
		expect(first).toHaveLength(1);

		// The publish that rescues it: stamps now, clears the latch.
		internals.noteSelfRecordPublished();
		expect(internals.selfRecordStaleWarned).toBe(false);
		expect(selfRecordWarnings(() => internals.escalateIfSelfRecordStale('heartbeat', new Error('still fresh'))))
			.toEqual([]);

		// …and it goes stale all over again.
		internals.lastSelfRecordPublishAt = Date.now() - (DEFAULT_PEER_RECORD_MAX_AGE_MS + 60_000);
		const second = selfRecordWarnings(() => internals.escalateIfSelfRecordStale('heartbeat', new Error('after')));
		expect(second).toHaveLength(1);
		expect(second[0]).toContain('after');
	});
});
