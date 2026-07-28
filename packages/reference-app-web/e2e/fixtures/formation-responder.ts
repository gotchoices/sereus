/**
 * formation-responder.ts — an in-process headless cadre responder for the live
 * formation→convergence e2e.
 *
 * Boots a REAL cadre-core `CadreNode` inside the Playwright **worker** process (the
 * spec's `beforeAll`) and acts as the dialable **second party** for the live
 * formation→convergence test. The browser tab is the *initiator* — it only dials out,
 * so it needs no relay; this responder is the *only* party that must be dialable, so
 * it listens on WebSocket and the browser dials it directly.
 *
 * It boots in the worker, NOT in `global-setup`: Playwright runs `global-setup` in
 * the main runner process and spec files in separate worker child processes that do
 * NOT share `globalThis`/memory, and the handle's live methods (`readFormationUsage`,
 * `readStrandMessages`, `seedMessage`) read in-memory node state — so they are only
 * reachable from the process that booted the node, i.e. the worker the spec runs in.
 *
 * Run in-process, NOT as a child: cadre-core runs fine in Node (the integration tests
 * boot `CadreNode` under vitest), and an in-process node sidesteps the TS-loader /
 * child-process problems a CLI-spawned fixture would hit. The handle lives for the
 * spec's lifetime and is torn down in its `afterAll`.
 *
 * The node is modelled on the integration harness's Node node
 * (`integration-tests/src/harness/test-party.ts` — in-memory storage; WS-only here,
 * since the browser is the only dialer) and the responder wiring on the Phase-2/Phase-4
 * responder in
 * `strand-formation-e2e.integration.ts`. It imports the SAME signed `getChatSAppConfig`
 * the browser uses (from `../../src/lib/chat-strand.js`) so the cohort can converge —
 * a re-declared schema would drift the signature and break the browser's attach.
 *
 * The spec wiring (`beforeAll` boot + `afterAll` stop, the formation/convergence
 * assertions) is the sibling `formation-convergence-e2e-wire-and-spec` ticket; this
 * module delivers the responder and its API.
 */

import { generateKeyPair } from '@libp2p/crypto/keys';
import { webSockets } from '@libp2p/websockets';
import { MemoryRawStorage, type Libp2pTransports } from '@optimystic/db-p2p';
import {
	CadreNode,
	ed25519KeyPairFromLibp2p,
	ControlFormationUsageRecorder,
	generateStrandMemberKey,
} from '@serfab/cadre-core';
import type { CadreNodeConfig } from '@serfab/cadre-core';
import type { Database } from '@quereus/quereus';
import type { Libp2p } from '@libp2p/interface';
import { getChatSAppConfig, CHAT_SAPP_ID } from '../../src/lib/chat-strand.js';
import { insertChatMessage, selectChatMessages } from '../../src/lib/chat-dml.js';

/** Author display name the responder seeds its known message under. */
const SEED_MEMBER = 'responder';

/** How long the responder waits for its strand DB to seed when none has connected. */
const DEFAULT_SEED_TIMEOUT_MS = 20_000;

/** Default validity window for the redeemable invitation (24h). */
const DEFAULT_EXPIRATION_MS = 24 * 60 * 60 * 1000;

/** How far in the past the deliberately-expired invitation's expiry sits. */
const EXPIRED_OFFSET_MS = 60_000;

/**
 * A live handle to the in-process responder, consumed by the e2e spec (which boots it
 * in `beforeAll`). All multiaddrs are read back from the bound libp2p nodes
 * (never hard-coded), so parallel runs never clash on a port.
 */
export interface FormationResponderHandle {
	/** Base64url `OpenInvitation` (valid) — the browser redeems this via `formStrand`. */
	encoded: string;
	/** A well-formed but already-EXPIRED invitation, for the negative redemption test. */
	expiredEncoded: string;
	/** The host closed strand id the valid invite binds to (provision-then-record). */
	strandId: string;
	/**
	 * The responder CONTROL node's `/ws` multiaddrs — the formation dial target, also
	 * embedded in `encoded`. Distinct from {@link strandMultiaddrs}; do not conflate.
	 */
	controlMultiaddrs: string[];
	/**
	 * The responder STRAND node's `/ws` multiaddrs — the cohort dial target the browser
	 * dials to join the strand cohort (control-network strand discovery is still TODO,
	 * so the browser wires this link by hand).
	 */
	strandMultiaddrs: string[];
	/**
	 * The known message the responder seeds into the strand on cohort connect. `content`
	 * is fixed from boot; `id` is filled lazily once {@link seedMessage} runs (a 2-member
	 * cohort commit needs both members connected). Read it AFTER awaiting
	 * {@link seedMessage} or confirming the strand connection.
	 */
	seededMessage: { id: string; content: string };
	/**
	 * Seed the known message into the strand and return it. Idempotent (single-flight):
	 * the message is written at most once; concurrent/repeat calls return the same row.
	 * The test calls this AFTER it confirms the browser is a connected cohort member, so
	 * the super-majority-of-2 commit succeeds. A connection listener also calls this as a
	 * best-effort backstop; a failed early attempt (cohort not yet ready) is retried by
	 * the next call rather than caching the rejection.
	 */
	seedMessage(): Promise<{ id: string; content: string }>;
	/** All `App.Message` rows in the strand, reduced to the convergence-assertion shape. */
	readStrandMessages(): Promise<Array<{ id: string; memberId: string; content: string }>>;
	/** `FormationUsage` rows on the responder's control DB (asserted after redemption). */
	readFormationUsage(): Promise<Array<{ token: string; useNumber: number; strandId: string | null }>>;
	/** Stop the node and release its strand/control resources. */
	stop(): Promise<void>;
}

/**
 * Transports for the responder: WebSocket only. The browser (the only client)
 * dials the `/ws` listen addr, and the responder dials nobody — so, like the
 * browser's own stack (see cadre-web.ts), it needs no TCP transport. A WS-only
 * responder keeps the e2e dependency surface minimal.
 */
function responderTransports(): Libp2pTransports {
	return [webSockets()];
}

/**
 * Build the `CadreNodeConfig` for the in-process responder. Mirrors the integration
 * harness's Node node — in-memory raw storage — but with a WS-only transport that
 * listens on an ephemeral WS port (`tcp/0/ws`) so the browser can dial it directly.
 * `storage` profile matches the integration responder (a willing cohort holder).
 */
function buildResponderConfig(privateKey: CadreNodeConfig['privateKey'], partyId: string): CadreNodeConfig {
	return {
		privateKey,
		controlNetwork: { partyId, bootstrapNodes: [] },
		profile: 'storage',
		strandFilter: { mode: 'all' },
		storage: { provider: () => new MemoryRawStorage() },
		network: {
			transports: responderTransports(),
			listenAddrs: ['/ip4/127.0.0.1/tcp/0/ws'],
		},
		hibernation: { enabled: false },
	};
}

/**
 * Genesis-seed the node's own owner, mirroring `cadre-web.ts` `runOwnerGenesis`
 * — bridge the libp2p identity into a base64url owner keypair, run the idempotent
 * `OwnerKey` insert, then initialize seed-bootstrap. Unlike the browser's fail-soft
 * path this throws on failure: a responder with no owner cannot sign the invite or
 * the host Strand row, so there is nothing to test.
 */
async function runOwnerGenesis(node: CadreNode, privateKey: NonNullable<CadreNodeConfig['privateKey']>): Promise<void> {
	const { privateKeyB64, publicKeyB64 } = ed25519KeyPairFromLibp2p(privateKey);
	const controlDb = node.getControlDatabase();
	if (!controlDb) {
		throw new Error('control database unavailable after start; cannot run responder owner genesis');
	}
	await controlDb.ensureOwnerKey(publicKeyB64);
	node.initializeSeedBootstrap(privateKeyB64);
}

/**
 * Boot the in-process responder and return a live handle.
 *
 * Sequence (each step mirrors the documented production path it is named after):
 *  1. Boot a `CadreNode` with a WS transport + memory storage, listening on an
 *     ephemeral `/ws` port.
 *  2. Genesis-seed its owner (fail-loud).
 *  3. Wire the formation responder (`initializeStrandSolicitation` + a real
 *     `ControlFormationUsageRecorder`) — registers the `/sereus/formation/1.0.0` handler.
 *  4. Create the host CLOSED chat strand byte-identically to the browser
 *     (`publishStrand` + `addStrand` with the SHARED signed `getChatSAppConfig`,
 *     `mode:'networked'`).
 *  5. Mint + publish the redeemable invitation bound to that strand, PLUS a second
 *     already-expired invitation for the negative test.
 *  6. Arm seed-on-connect (best-effort) — the deterministic path is the explicit
 *     {@link FormationResponderHandle.seedMessage}.
 */
export async function startFormationResponder(opts?: {
	expirationMs?: number;
}): Promise<FormationResponderHandle> {
	const expirationMs = opts?.expirationMs ?? DEFAULT_EXPIRATION_MS;

	const identityKey = await generateKeyPair('Ed25519');
	const partyId = `formation-responder-${crypto.randomUUID()}`;

	const node = new CadreNode(buildResponderConfig(identityKey, partyId));
	await node.start();

	try {
		await runOwnerGenesis(node, identityKey);

		// Wire consent + register the responder. The DB-backed recorder makes token
		// validity + single-use real and threads the bound host strand back
		// (provision-then-record), exactly like cadre-web.ts `ensureSolicitation`.
		const controlDb = node.getControlDatabase();
		if (!controlDb) {
			throw new Error('control database unavailable after start; cannot wire formation responder');
		}
		node.initializeStrandSolicitation({
			formationUsageRecorder: new ControlFormationUsageRecorder(controlDb),
		});

		// Host CLOSED chat strand — byte-identical to the browser's createClosedChatStrand
		// (publishStrand 'c' + addStrand with the SHARED signed config + mode:'networked').
		const strandId = crypto.randomUUID();
		const memberKey = await generateStrandMemberKey();
		await node.publishStrand(strandId, 'c', memberKey);
		await node.addStrand({
			strandRow: { Id: strandId, MemberPrivateKey: memberKey, Type: 'c' },
			sAppConfig: getChatSAppConfig(),
			// Formed strands replicate across a cohort. `networked` is mandatory: without
			// it addStrand infers `bootstrap` from the empty CadrePeer cohort and the
			// strand never replicates. See cadre-web.ts createClosedChatStrand.
			mode: 'networked',
		});

		const strand = node.getStrand(strandId);
		if (!strand?.libp2pNode) {
			throw new Error(`responder strand ${strandId} has no libp2p node after networked addStrand`);
		}
		const strandLibp2p: Libp2p = strand.libp2pNode;

		// Valid invitation bound to the host strand (provision-then-record). The
		// OpenInvitation embeds this node's control multiaddrs (its `/ws` addr).
		const invitation = await node.createOpenInvitation(CHAT_SAPP_ID, expirationMs);
		await node.publishFormationInvite(invitation.token, CHAT_SAPP_ID, {
			strandId,
			expiresAtMs: invitation.expiration.getTime(),
		});

		// Second, already-EXPIRED invitation: well-formed (real FormationInvite row,
		// decodes cleanly) but past expiry, so redemption exercises the expiry branch —
		// NOT a decode error (that case is covered by the solo formation-rbac spec).
		//
		// NOTE: this reaches the protocol-level expiry rejection only because the VALID
		// invitation above holds the responder's inbound connection gate open (the gate
		// admits a stranger only while some invitation is outstanding). A future fixture
		// that publishes ONLY an expired invitation would be denied at the connection
		// layer first, and the failure would look like a transport error — mint a live
		// invitation alongside it, or assert the transport error deliberately.
		const expiredInvitation = await node.createOpenInvitation(CHAT_SAPP_ID, -EXPIRED_OFFSET_MS);
		await node.publishFormationInvite(expiredInvitation.token, CHAT_SAPP_ID, {
			strandId,
			expiresAtMs: expiredInvitation.expiration.getTime(),
		});

		// Known seed message: content fixed from boot, id filled lazily on seed.
		const seedContent = `responder-seed-${crypto.randomUUID().slice(0, 8)}`;
		const seededMessage = { id: '', content: seedContent };

		// Single-flight seed: write the known message at most once. A rejection is NOT
		// cached — an early attempt before the cohort is ready resets so the next call
		// retries (the quorum-ordering guard from the ticket).
		let seedPromise: Promise<{ id: string; content: string }> | null = null;
		const ensureSeeded = (): Promise<{ id: string; content: string }> => {
			if (seededMessage.id) {
				return Promise.resolve({ ...seededMessage });
			}
			if (!seedPromise) {
				seedPromise = (async () => {
					const db = requireStrandDatabase(node, strandId);
					const id = await insertChatMessage(db, SEED_MEMBER, seedContent);
					seededMessage.id = id;
					return { id, content: seedContent };
				})().catch((err: unknown) => {
					seedPromise = null;
					throw err;
				});
			}
			return seedPromise;
		};

		// Best-effort seed-on-connect backstop. The deterministic path is the explicit
		// seedMessage() the test calls after confirming the cohort connection; this just
		// covers a test that forgets to. Any strand-node inbound connection IS a cohort
		// peer (the strand node speaks only the strand network).
		const onStrandConnection = (): void => {
			void ensureSeeded().catch(() => {
				/* not ready yet — the explicit seedMessage() call retries; nothing to surface here */
			});
		};
		strandLibp2p.addEventListener('connection:open', onStrandConnection);

		return {
			encoded: node.encodeInvitation(invitation),
			expiredEncoded: node.encodeInvitation(expiredInvitation),
			strandId,
			controlMultiaddrs: node.getMultiaddrs(),
			strandMultiaddrs: strandLibp2p.getMultiaddrs().map((ma) => ma.toString()),
			seededMessage,
			seedMessage: () => seedWithTimeout(ensureSeeded, DEFAULT_SEED_TIMEOUT_MS),
			readStrandMessages: async () => {
				const rows = await selectChatMessages(requireStrandDatabase(node, strandId));
				return rows.map((r) => ({ id: r.id, memberId: r.memberId, content: r.content }));
			},
			readFormationUsage: () => readFormationUsage(controlDb.getDatabase()),
			stop: async () => {
				strandLibp2p.removeEventListener('connection:open', onStrandConnection);
				await node.stop();
			},
		};
	} catch (err) {
		// Bring-up failed after start(): tear the node down so a failed boot leaves no
		// dangling libp2p listeners/handles, then rethrow (fail loud, like genesis).
		await node.stop().catch(() => {
			/* best-effort cleanup; surface the ORIGINAL error below */
		});
		throw err;
	}
}

/**
 * Resolve the host strand's attached Quereus database, or throw a surfaced error. The
 * strand may still be launching (no attached database) — a thrown error fails loudly
 * rather than silently reading an empty database.
 */
function requireStrandDatabase(node: CadreNode, strandId: string): Database {
	const instance = node.getStrand(strandId);
	if (!instance) {
		throw new Error(`responder strand ${strandId} not found`);
	}
	if (!instance.database) {
		throw new Error(`responder strand ${strandId} has no database — it is still launching`);
	}
	return instance.database.getDatabase();
}

/** Read the responder's `FormationUsage` rows over its control DB (read-only SQL). */
async function readFormationUsage(
	db: Database,
): Promise<Array<{ token: string; useNumber: number; strandId: string | null }>> {
	const rows: Array<{ token: string; useNumber: number; strandId: string | null }> = [];
	for await (const row of db.eval('select Token, UseNumber, StrandId from CadreControl.FormationUsage')) {
		rows.push({
			token: row.Token as string,
			useNumber: row.UseNumber as number,
			strandId: (row.StrandId as string | null) ?? null,
		});
	}
	return rows;
}

/**
 * Await the seed write with a timeout so a never-connecting cohort fails the test
 * loudly rather than hanging the Playwright run.
 */
function seedWithTimeout(
	ensureSeeded: () => Promise<{ id: string; content: string }>,
	timeoutMs: number,
): Promise<{ id: string; content: string }> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			reject(new Error(`responder seed did not complete within ${timeoutMs}ms (no cohort connection?)`));
		}, timeoutMs);
		ensureSeeded().then(
			(seed) => {
				clearTimeout(timer);
				resolve(seed);
			},
			(err: unknown) => {
				clearTimeout(timer);
				reject(err instanceof Error ? err : new Error(String(err)));
			},
		);
	});
}
