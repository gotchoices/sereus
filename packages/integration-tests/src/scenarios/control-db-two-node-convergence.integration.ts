/**
 * Two-node control-DB convergence over the live control network.
 *
 * The regression anchor for the claim that the `CadreControl` store **replicates
 * peer-to-peer** across a party's cadre nodes (docs/architecture.md — `CadrePeer`
 * as the "authoritative, replicated form"). Network-backing has now LANDED
 * (`control-db-network-backed`), so this asserts the positive convergence directly.
 *
 * How it was wired (context for reviewers):
 *
 * `ControlDatabase.initialize()` now mirrors `connectToStrand`
 * (@serfab/quereus-plugin-sereus): after registering the optimystic plugin and the
 * libp2p node it calls `db.setDefaultVtabName('optimystic')` +
 * `setDefaultVtabArgs({ transactor: 'network', ... })` and hydrates the catalog
 * BEFORE applying `CONTROL_SCHEMA`. The `declare schema CadreControl { table ... }`
 * tables carry no per-table `using optimystic(...)`, so routing the DEFAULT vtab to
 * the network transactor is what makes a control write replicate (a control write
 * now emits the same optimystic transactor/cluster/coordinator activity a strand
 * write does). Before that fix the tables fell back to Quereus's in-memory vtab and
 * never converged.
 *
 * Network-backing also required closing a transaction-semantics gap in the Optimystic
 * vtab: a deferred CHECK referencing `committed.<Table>` (the
 * `FormationUsage.Monotonic` anti-replay) must read the pre-transaction snapshot, so
 * the vtab now honours Quereus's `_readCommitted` flag (and enforces secondary-UNIQUE
 * constraints for the single-use StampId columns). That work lives in the
 * `../optimystic` workspace; the green cadre-core consent suite depends on it being
 * built and linked.
 *
 * This scenario isolates the *replication-given-a-connected-cohort* behavior, so it
 * still forms the cohort with a test-only manual `dial()` over the public
 * `getControlNode()` seam — exactly as the strand scenarios manually dial strand
 * nodes. A must vouch B (`authorizePeer` in `bootPair`) for B's pull-on-read
 * streams to pass A's fail-closed per-stream control-DB gate
 * (`authorizeInboundControlStream` — once A holds an anchor and ≥1 member row,
 * un-vouched peers are refused on the repo protocol); B still pins nobody, so
 * the row-presence-vs-trust distinction the closing comment describes is intact.
 * Production auto-connect (nodes forming the control cohort with no manual
 * dial) now lands via `CadreNode.reconcileControlCohort` and is proven end-to-end,
 * with zero manual control dials, by `control-cohort-auto-convergence.integration.ts`.
 */

import { describe, it, expect } from 'vitest';
import type { CadreNode } from '@serfab/cadre-core';
import { waitForCadrePeerConverged, connectControlNodes, randomPeerId, bootPair } from '../harness/index.js';

// ═══════════════════════════════════════════════════════════════════════════════

describe('Two-node control-DB convergence', () => {
	// The control tables are network-backed (default vtab → optimystic network
	// transactor), so an owner-written CadrePeer row on A converges to a connected
	// reader B by pull-on-read. The recipe is intentionally identical to the strand
	// convergence scenarios.

	it('replicates an owner-written CadrePeer row from node A to node B over the live control network', async () => {
		let A: CadreNode | undefined;
		let B: CadreNode | undefined;
		try {
			({ A, B } = await bootPair('converge'));

			// CONNECT BEFORE WRITE so the cohort is ≥2 and the commit is not local-only.
			await connectControlNodes(B, A);

			// A third peer X that exists ONLY as a row A writes — never started, never
			// known to B locally. B observing X proves replication, not local seeding.
			const xPeerId = await randomPeerId();
			await A.authorizePeer(xPeerId);
			expect(await A.isMember(xPeerId)).toBe(true);

			// B converges by READING (pull-on-read): each poll is the read that pulls
			// A's CadrePeer block into B's cohort view.
			await waitForCadrePeerConverged(B.getControlDatabase()!, xPeerId, {
				timeoutMs: 30_000,
				description: 'B observes the X CadrePeer row written on A',
			});

			// Deliberately the ADDRESSABLE surface (`isMember` — row presence): this
			// scenario proves replication mechanics, not trust. The trust-facing gate
			// (`isAuthorizedMember`) additionally requires A's owner key pinned in B's
			// node-local anchor — that enrollment story is proven in push-wake-e2e
			// scenario 4; B here never pins anyone.
			expect(await B.isMember(xPeerId)).toBe(true);
		} finally {
			await B?.stop();
			await A?.stop();
		}
	}, 60_000);
});
