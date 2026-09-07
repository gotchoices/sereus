import { describe, it, expect } from 'vitest';
import { CadreNode } from '../src/cadre-node.js';
import type { CadreNodeConfig, StrandInstance } from '../src/types.js';
import type { StartStrandConfig, ResumeStrandOverrides } from '../src/strand-instance-manager.js';

/**
 * A strand node must declare NO block-repair corroboration yardstick.
 *
 * Optimystic trusts a repair answer only when enough peers corroborate it, measured
 * against `clusterPolicy.repairCorroborationClusterSize` rather than the peers currently
 * visible. Declaring 3 or more pins that floor at two corroborating peers — which a cohort
 * that can only ever field one peer can never reach, so it can never repair a block
 * (`cluster-fetch:no-quorum`, surfacing as reads failing with `Missing block`).
 *
 * `CadreNode` holds exactly one machine count: the party's enrolled machines
 * (`authorizedControlPeers`). That is the right number for the CONTROL network, where every
 * enrolled machine runs the node, and the WRONG number for a strand, which launches only on
 * machines whose embedder registered its sApp config (`addStrand`) — so a closed strand
 * shared by two machines of a three-machine party would be over-declared into exactly the
 * failure above. It reached `startStrand` as `enrolledMachines` for one release
 * (`fix/bug-strand-yardstick-counts-party-machines`); nothing pins it out of the launch path
 * except this file.
 *
 * So both assertions are about ABSENCE, and both are made with a NON-EMPTY authorized-peer
 * snapshot — the only state in which the old code produced a number at all, and therefore the
 * only state in which a regression is visible. When
 * `backlog/feat-strand-yardstick-from-serving-machines` lands, these become assertions about
 * the count it produces; they must not be relaxed into "some number is fine".
 */

function createConfig(): CadreNodeConfig {
	return {
		controlNetwork: {
			partyId: 'strand-yardstick-test-' + Math.random().toString(36).slice(2),
			bootstrapNodes: []
		},
		profile: 'transaction'
	};
}

interface CapturedManager {
	startConfigs: StartStrandConfig[];
	resumeOverrides: (ResumeStrandOverrides | undefined)[];
}

function fakeInstance(strandId: string): StrandInstance {
	return {
		strandId,
		status: 'active',
		connectedPeers: 0,
		lastActivity: new Date(0),
		latencyHint: 'interactive'
	} as StrandInstance;
}

/**
 * Records every `startStrand` config and every `resumeStrand` override without booting a
 * real libp2p node — the same double `cadre-node-strand-launch-key.spec.ts` uses, extended
 * with the resume arm. The returned instances carry no `libp2pNode`, which short-circuits
 * the address-merge that follows both calls in production.
 */
function injectCapturingStrandManager(node: CadreNode): CapturedManager {
	const captured: CapturedManager = { startConfigs: [], resumeOverrides: [] };
	(node as unknown as { strandManager: unknown }).strandManager = {
		// launchStrand's already-tracked guard checks this first; the fake never tracks a
		// running instance, so every call is a fresh launch.
		getInstance: () => undefined,
		startStrand: async (config: StartStrandConfig) => {
			captured.startConfigs.push(config);
			return fakeInstance(config.strandRow.Id);
		},
		resumeStrand: async (strandId: string, overrides?: ResumeStrandOverrides) => {
			captured.resumeOverrides.push(overrides);
			return fakeInstance(strandId);
		}
	};
	return captured;
}

/**
 * Populate the authorized-peer snapshot the removed `enrolledMachineCount()` read from.
 * Three peers plus self is 4 — comfortably past the yardstick floor of 2, so a regression
 * that reintroduced the derivation would produce a visible number, not `undefined`.
 */
function seedAuthorizedPeers(node: CadreNode, count: number): void {
	const peers = new Set(Array.from({ length: count }, (_, i) => `12D3KooWFakePeer${i}`));
	(node as unknown as { authorizedControlPeers: Set<string> }).authorizedControlPeers = peers;
}

function launchStrand(node: CadreNode, strandId: string): Promise<unknown> {
	return (node as unknown as {
		launchStrand(strand: { Id: string; MemberPrivateKey: string | null; Type: 'o' | 'c' }, sAppConfig: unknown): Promise<unknown>;
	}).launchStrand(
		{ Id: strandId, MemberPrivateKey: null, Type: 'o' },
		{ id: 'sapp-author', version: '1.0.0', schema: '' }
	);
}

function resumeStrandRuntime(node: CadreNode, strandId: string): Promise<void> {
	return (node as unknown as {
		resumeStrandRuntime(strandId: string): Promise<void>;
	}).resumeStrandRuntime(strandId);
}

describe('CadreNode strand repair-yardstick wiring', () => {
	it('hands startStrand no servingMachines, even with a populated authorized-peer set', async () => {
		const node = new CadreNode(createConfig());
		seedAuthorizedPeers(node, 3);
		const captured = injectCapturingStrandManager(node);

		await launchStrand(node, 'strand-a');

		expect(captured.startConfigs).toHaveLength(1);
		const config = captured.startConfigs[0]!;
		expect(config.servingMachines).toBeUndefined();
		// `in`, not just the value: a future `servingMachines: undefined` spread from some
		// party-derived helper would satisfy the check above while re-establishing the path.
		expect('servingMachines' in config).toBe(false);
		// The party count IS available to the node — this is what makes the absence meaningful
		// rather than an artifact of an empty snapshot.
		expect((node as unknown as { authorizedControlPeers: Set<string> }).authorizedControlPeers.size).toBe(3);
	});

	it('hands resumeStrand only the cohort seed — no servingMachines override', async () => {
		// The wake path re-resolves volatile inputs on every hibernation wake, many times a
		// day. It is a second, independent way for the party count to reach the strand node.
		const node = new CadreNode(createConfig());
		seedAuthorizedPeers(node, 3);
		const captured = injectCapturingStrandManager(node);

		await resumeStrandRuntime(node, 'strand-a');

		expect(captured.resumeOverrides).toHaveLength(1);
		const overrides = captured.resumeOverrides[0]!;
		expect(overrides.servingMachines).toBeUndefined();
		expect('servingMachines' in overrides).toBe(false);
		expect(Object.keys(overrides)).toEqual(['bootstrapNodes']);
	});
});
