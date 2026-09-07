/**
 * Members of one party that DISAGREE about the party's size must still commit and
 * still converge.
 *
 * The block-repair corroboration yardstick (`repairCorroborationClusterSize`, see
 * `docs/architecture.md` → "Replication cluster size") is derived per node from the
 * machines that node believes are enrolled. On the control network that number is
 * read at bring-up out of a node-local record written by the PREVIOUS run
 * (`enrolled-machine-store.ts`), because the control libp2p node is built before the
 * database holding the membership rows exists. So a party that has just grown
 * genuinely runs with its members declaring different numbers until each restarts —
 * that is the designed steady state, not a race to close.
 *
 * It also covers the WRITE half of that record end to end — a run that learns its
 * party's size leaves that size behind for the next launch — which no unit test can
 * reach, since it needs a real control database with real vouched membership rows.
 *
 * The safety argument for the divergence is short: the yardstick is per-node and
 * gates only that node's own reads, and no node refuses another anything over it.
 * This scenario exists because that is a claim worth PROVING once on a real network
 * rather than only reasoning about — a yardstick that leaked into the write path (into the
 * membership admission gate, the approval bar, or the cohort a coordinator will
 * accept) would show up here as a write that will not commit, or a member that never
 * catches up.
 *
 * Topology: A (owner, storage, the writer) declares 2 while B (a plain reader that is
 * deliberately NOT its own owner) declares 3, so every row B observes must have
 * arrived over the wire. The counts are planted through
 * `ControlNodeOpts.enrolledMachines`, which is the only way to make a control node
 * declare a number at all — production reaches the same state by having run before.
 *
 * The recipe is deliberately `control-db-two-node-convergence`'s, node construction
 * included: connect BEFORE the write so the cohort is >= 2 and the commit is not
 * local-only, then let B converge by pull-on-read. The two nodes are built here
 * rather than through `bootPair` because they need different `enrolledMachines`
 * records, which is the whole point of the scenario and not something a shared
 * fixture should carry.
 *
 * ## Why two nodes and not three
 *
 * The ticket that added this asked for a THREE-node version — one node declaring 2
 * while the other two declare 3. That version was written, and it is not shippable
 * today, for reasons that have nothing to do with the yardstick:
 *
 *  - The three-node divergent version was **1 green in 4 runs**, failing with three
 *    fingerprints: the boot gate timing out on "C self-publishes its CadrePeer
 *    record" (45 s), the boot gate timing out on "B resolves C's signed address
 *    record" (45 s), and a commit rejected with `content-digest-mismatch`.
 *  - Re-run with the counts made to **AGREE** (3/3/3), it failed **4 of 4** with the
 *    same three fingerprints. So the divergence is not what breaks it.
 *  - The existing `control-cohort-three-node-isolation`, untouched by that work, was
 *    **2 red in 3 runs** at the same HEAD with the identical "B resolves C's signed
 *    CadrePeer address record" fingerprint.
 *
 * That is the three-node control-write / peer-record family `tickets/.pre-existing-known.md`
 * records as red at HEAD on tracked, human-blocked tickets
 * (`control-peer-row-refresh-invisible-to-third-node`). Shipping a fourth flaky-red
 * file into it would bury this scenario's signal in that noise. Two members that
 * disagree prove the claim — it is about non-interference between per-node
 * yardsticks, and a third agreeing member adds unanimity pressure, not another way
 * for a yardstick to leak. Restore the three-node variant when that family is green.
 */

import { describe, it, expect } from 'vitest';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { CadreNode, CONTROL_REPLICATION_BREADTH } from '@serfab/cadre-core';
import type { Libp2pNodeWithRepo } from '@serfab/cadre-core';
import {
	controlNodeConfig, makeOwnOwner, connectControlNodes, enrolledMachineStoreWith,
	randomPeerId, waitForCadrePeerConverged, waitUntil
} from '../harness/index.js';

/** Machines A remembers — the LAGGING view, from before the party grew. */
const A_REMEMBERED_MACHINES = 2;
/** Machines B remembers — the current party size. */
const B_REMEMBERED_MACHINES = 3;

/** Convergence by pull-on-read; the bound the two-node convergence scenario uses. */
const CONVERGE_TIMEOUT_MS = 30_000;

/**
 * How long the node-local record may lag the membership write that drove it. The
 * refresh is local and coalesced (no network), so this is generous rather than
 * tuned — it exists so a hang fails with this scenario's message instead of the
 * suite timeout.
 */
const RECORD_TIMEOUT_MS = 10_000;

/**
 * The repair yardstick a LIVE node resolved, read off its control `CoordinatorRepo`.
 *
 * Optimystic keeps `repairCorroborationClusterSize` private and exposes no getter
 * (unlike `effectiveSuperMajorityThreshold`), so this reaches for the field by name.
 * That is load-bearing rather than convenient: the whole point of the scenario is
 * that the two nodes REALLY resolved different numbers, and asserting that on the
 * config object instead would prove nothing `cadre-node-control-node-options.spec.ts`
 * does not already prove. If Optimystic renames the field this returns `undefined`
 * and the assertions below fail loudly, which is the right failure — a silently
 * vacuous version of this test is worth less than no test.
 */
function resolvedRepairYardstick(node: CadreNode): number | undefined {
	const controlNode = node.getControlNode() as Libp2pNodeWithRepo | null;
	const repo = controlNode?.coordinatedRepo as unknown as { repairCorroborationClusterSize?: number } | undefined;
	return repo?.repairCorroborationClusterSize;
}

// ═══════════════════════════════════════════════════════════════════════════════

describe('control writes across members that declare different repair yardsticks', () => {
	it('commits and converges when the writer and the reader disagree about the party size', async () => {
		const partyId = `divergent-yardstick-${Date.now()}`;
		let A: CadreNode | undefined;
		let B: CadreNode | undefined;
		try {
			const aKey = await generateKeyPair('Ed25519');
			A = new CadreNode(controlNodeConfig({
				partyId, privateKey: aKey, profile: 'storage', enableRelay: true,
				enrolledMachines: await enrolledMachineStoreWith(partyId, A_REMEMBERED_MACHINES)
			}));
			await A.start();
			await makeOwnOwner(A, aKey);

			const bKey = await generateKeyPair('Ed25519');
			B = new CadreNode(controlNodeConfig({
				partyId, privateKey: bKey, profile: 'transaction',
				enrolledMachines: await enrolledMachineStoreWith(partyId, B_REMEMBERED_MACHINES)
			}));
			await B.start();

			// A vouches B so B's inbound pull streams pass A's per-stream control-DB gate
			// (A's snapshot is non-empty once it has an anchor and any member row).
			await A.authorizePeer(B.peerId!.toString());

			// The precondition everything below depends on. Without it the write and
			// convergence assertions would pass vacuously, proving only that a two-node
			// party works — which `control-db-two-node-convergence` already covers.
			expect(resolvedRepairYardstick(A)).toBe(A_REMEMBERED_MACHINES);
			expect(resolvedRepairYardstick(B)).toBe(B_REMEMBERED_MACHINES);
			// Both sit inside the control breadth, so neither was clamped on the way in —
			// the divergence under test is the party's, not an artifact of the cap.
			expect(B_REMEMBERED_MACHINES).toBeLessThanOrEqual(CONTROL_REPLICATION_BREADTH);

			// CONNECT BEFORE WRITE so the cohort is >= 2 and the commit is not local-only.
			await connectControlNodes(B, A);

			// A third peer X that exists ONLY as a row A writes — never started, never
			// known to B locally, so B observing it proves replication, not local seeding.
			const xPeerId = await randomPeerId();
			await A.authorizePeer(xPeerId);
			expect(await A.isMember(xPeerId)).toBe(true);

			// B declares 3 while the writer declares 2, and still catches up by
			// pull-on-read: each poll is the read that pulls A's block into B's view.
			await waitForCadrePeerConverged(B.getControlDatabase()!, xPeerId, {
				timeoutMs: CONVERGE_TIMEOUT_MS,
				description: 'B (yardstick 3) observes a row committed by A (yardstick 2)',
			});
			expect(await B.isMember(xPeerId)).toBe(true);

			// The WRITE half of the record, which nothing else covers: a run that learns
			// its party's size must leave that size behind for the next launch to read.
			// A has vouched B and X, and its own authorized set excludes itself, so the
			// count it records is 2 + 1. Without this the `record()` call in
			// `refreshAuthorizedControlPeers` could be deleted and every other test in the
			// repo would still pass — the yardstick would simply never advance in the
			// field. Polled rather than asserted outright: the refresh is driven off the
			// membership-change listener and coalesced, so it settles shortly after the
			// write rather than within it.
			await waitUntil(() => A!.getEnrolledMachineStore()?.count() === 3, {
				timeoutMs: RECORD_TIMEOUT_MS,
				description: "A records the party's grown size (A + B + X) for its next launch",
			});
			// B holds no trusted-owner anchor of its own, so it authorizes nobody and
			// records 1 — overwriting the 3 planted above. That is the documented cost of
			// recording an empty snapshot rather than skipping it (see the NOTE at the
			// record site in `cadre-node.ts`): the number must be able to come back DOWN
			// when a party genuinely shrinks, so an empty read writes 1 even when the
			// emptiness is only "this node cannot authorize anyone yet". Safe in both
			// directions here — the yardstick floor turns a recorded 1 back into today's
			// 2, and B's DECLARED 3 is unaffected, having been captured at start(). What
			// B must never do is inherit A's 3: the record is per node, written from what
			// that node itself can authorize.
			expect(B!.getEnrolledMachineStore()?.count()).toBe(1);
		} finally {
			await B?.stop();
			await A?.stop();
		}
	}, 90_000);
});
