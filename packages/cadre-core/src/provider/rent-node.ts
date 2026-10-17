/**
 * Rent a node from a hosting provider and add it to this node's cadre, by whichever of the two
 * join paths fits (`docs/architecture.md` → "Renting a node from an app"):
 *
 * - **invitation**, when the cadre has a member the container can reach from the provider's
 *   network (`CadreNode.invitationReach()` reads `anywhere`): mint a single-use, non-owner
 *   invitation and create the container with it; the container joins by itself and the app
 *   watches `getContainer(id).join`.
 * - **claim**, otherwise (a phone that is the cadre's only member, or members reachable only on
 *   their LAN, which the provider's container is never on): create the container, poll for its
 *   node code, and claim it from this node.
 *
 * Nothing here persists anything: which container belongs to which cadre is the app's record,
 * and {@link finishRental} is how an app resumes a rental it was killed in the middle of. The
 * node code carries the claim secret, so neither the code nor the decoded payload is ever
 * logged, only the container id and the peer id.
 */

import debug from 'debug';
import type { CadreNode } from '../cadre-node.js';
import { decodeNodeClaimPayload } from '../node-claim-payload.js';
import { ProviderApiError, type ProviderClient, type RentedContainerStatusReport } from './client.js';

const log = debug('sereus:cadre:provider-rent');

export type RentNodeJoin = 'claim' | 'invitation';

/** Progress, as `RentNodeOptions.onProgress` reports it; `claiming` can last a while, see {@link rentNode}. */
export type RentNodeStep = 'creating' | 'waiting-for-code' | 'claiming' | 'inviting' | 'done';

export interface RentNodeOptions {
	/** Default `storage`. */
	profile?: 'storage' | 'transaction';
	/** Called at each step; an exception it throws is logged and ignored. */
	onProgress?: (step: RentNodeStep) => void;
	/**
	 * How long to wait for the node code before giving up with `node-not-ready`; default
	 * {@link DEFAULT_NODE_CODE_DEADLINE_MS}. The container exists by then and
	 * {@link finishRental} resumes it.
	 */
	nodeCodeDeadlineMs?: number;
	/** How often the node code is asked for while it is not ready; default {@link NODE_CODE_POLL_MS}. */
	nodeCodePollMs?: number;
}

export interface RentNodeResult {
	containerId: string;
	join: RentNodeJoin;
	/** The node's peer id, known at once on the claim path and once the container reported it on the invitation path. */
	peerId?: string;
}

/** {@link finishRental} on an invitation container whose node could not redeem: delete the container and rent again. */
export interface RentalFailed {
	containerId: string;
	outcome: 'failed';
	error: string;
	retryable: boolean;
}

export type RentNodeErrorCode =
	/** This node cannot act as an owner of its cadre, so it can neither invite nor claim. */
	| 'not-an-owner'
	/** The node code was not ready by the deadline; the container exists, `finishRental` resumes it. */
	| 'node-not-ready'
	/** The container is `stopped` or `error`, or the provider reported it so while the code was awaited. */
	| 'container-gone'
	/** A claim container that another cadre's owner claimed. */
	| 'claimed-by-another'
	/** A container `rentNode` did not create: it carries no join. */
	| 'not-a-rental';

export class RentNodeError extends Error {
	constructor(readonly code: RentNodeErrorCode, readonly containerId?: string) {
		super(`rentNode: ${code}${containerId ? ` (container ${containerId})` : ''}`);
		this.name = 'RentNodeError';
	}
}

/** The `CadreNode` surface renting needs; a hand-written object implementing it is how tests avoid a node. */
export type RentingNode = Pick<CadreNode, 'partyId' | 'isOwner' | 'invitationReach' | 'createCadreInvitation' | 'withdrawCadreInvitation' | 'claimNode'>;

/**
 * The provider's enrolment window is 60 s and an image pull can precede it. Bounds the
 * container's start, not an exchange over the link, so it is not derived from the link budget.
 */
// eslint-disable-next-line no-restricted-syntax -- link-independent: bounds the container's start (an image pull plus the provider's 60 s enrolment window), not an exchange over the link
export const DEFAULT_NODE_CODE_DEADLINE_MS = 120_000;
export const NODE_CODE_POLL_MS = 2_000;
/** Lifetime of the invitation a rental mints: long enough for the container to start and redeem, short enough to limit a leaked bundle. */
export const RENTAL_INVITATION_TTL_MS = 15 * 60_000;

/**
 * Rent a node and add it to `node`'s cadre; see the module doc for the path choice.
 *
 * The claim path's `claimNode` can take up to the per-peer dial limit plus the seed request
 * when no address answers (its doc: 114.5 s at the default link); no timeout is added on top
 * of it, and `onProgress('claiming')` is the app's cue to show a slow hint. Two calls at once
 * on one node both mint or both create; serializing them is the app's.
 *
 * @throws {RentNodeError} `not-an-owner`, or `node-not-ready` once the container exists.
 * @throws {ProviderApiError} when the provider refused a request (a lapsed subscription is `403 QUOTA_EXCEEDED`).
 * @throws {ClaimRefusedError} or {PeerUnreachableError} from `claimNode`, as it throws them.
 */
export async function rentNode(node: RentingNode, client: ProviderClient, options: RentNodeOptions = {}): Promise<RentNodeResult> {
	await requireOwner(node);
	const reach = await node.invitationReach();
	log('renting a node for party %s; invitation reach %s → %s path', node.partyId, reach, reach === 'anywhere' ? 'invitation' : 'claim');
	return reach === 'anywhere'
		? await rentByInvitation(node, client, options)
		: await rentByClaim(node, client, options);
}

/**
 * Resume a rental: for an app that was killed mid-flow or hit the node-code deadline.
 *
 * - a `stopped` or `error` container → `RentNodeError('container-gone')`;
 * - a claim container not yet claimed → the code, then `claimNode`, as {@link rentNode} would;
 * - a claim container claimed into this cadre → done. The provider withholds the code once a
 *   claim is folded, so the claim is not re-run; one claimed by another cadre's owner →
 *   `RentNodeError('claimed-by-another')`;
 * - an invitation container → done while `pending` or `accepted` (the app watches `join`), or
 *   the failed outcome, after which the app deletes the container and rents again (the claim
 *   path is chosen then if the member that answered is gone).
 */
export async function finishRental(node: RentingNode, client: ProviderClient, containerId: string, options: RentNodeOptions = {}): Promise<RentNodeResult | RentalFailed> {
	await requireOwner(node);
	const report = await client.getContainer(containerId);
	const kind = joinKindOf(report, containerId);
	if (kind === 'claim') {
		return await finishClaim(node, client, report, options);
	}
	const join = report.join;
	if (join?.kind === 'invitation' && join.state === 'failed') {
		return { containerId, outcome: 'failed', error: join.error, retryable: join.retryable };
	}
	return invitationResult(report.container);
}

async function requireOwner(node: RentingNode): Promise<void> {
	if (!await node.isOwner()) throw new RentNodeError('not-an-owner');
}

async function rentByInvitation(node: RentingNode, client: ProviderClient, options: RentNodeOptions): Promise<RentNodeResult> {
	report(options, 'inviting');
	const { invitation, encoded } = await node.createCadreInvitation({ uses: 1, expiresInMs: RENTAL_INVITATION_TTL_MS });
	report(options, 'creating');
	let container;
	try {
		container = await client.createContainer({ join: { kind: 'invitation', invitation: encoded }, profile: options.profile ?? 'storage' });
	} catch (error) {
		await withdrawQuietly(node, invitation.invite.key);
		throw error;
	}
	log('container %s created with an invitation; it joins by itself', container.id);
	report(options, 'done');
	return invitationResult(container);
}

/** A create that failed leaves no live invitation behind; a withdrawal that fails too is logged, and the create's error is what the caller sees. */
async function withdrawQuietly(node: RentingNode, key: string): Promise<void> {
	try {
		await node.withdrawCadreInvitation(key);
	} catch (error) {
		log('withdrawing invitation %s after a failed create failed too: %o', key, error);
	}
}

async function rentByClaim(node: RentingNode, client: ProviderClient, options: RentNodeOptions): Promise<RentNodeResult> {
	report(options, 'creating');
	const container = await client.createContainer({ join: { kind: 'claim' }, profile: options.profile ?? 'storage' });
	log('container %s created for a claim', container.id);
	return await claimContainer(node, client, container.id, options);
}

/** Poll for the node code, then claim; the second half of the claim path, shared with {@link finishRental}. */
async function claimContainer(node: RentingNode, client: ProviderClient, containerId: string, options: RentNodeOptions): Promise<RentNodeResult> {
	report(options, 'waiting-for-code');
	const { code, peerId } = await awaitNodeCode(client, containerId, options);
	report(options, 'claiming');
	// The claim is the owner's signature; the app asked the user before calling.
	await node.claimNode(decodeNodeClaimPayload(code));
	log('container %s claimed; its node is %s', containerId, peerId);
	report(options, 'done');
	return { containerId, join: 'claim', peerId };
}

/**
 * `getNodeCode` every poll interval until it answers or the deadline passes. A container that
 * dies meanwhile (`409 CONTAINER_GONE`) is `container-gone`, the same code `finishRental` gives
 * one found dead, so an app handles both at one site.
 */
async function awaitNodeCode(client: ProviderClient, containerId: string, options: RentNodeOptions): Promise<{ code: string; peerId: string }> {
	const deadline = Date.now() + (options.nodeCodeDeadlineMs ?? DEFAULT_NODE_CODE_DEADLINE_MS);
	const poll = options.nodeCodePollMs ?? NODE_CODE_POLL_MS;
	for (;;) {
		const answer = await requestNodeCode(client, containerId);
		if (!('notReady' in answer)) return answer;
		if (Date.now() >= deadline) {
			log('container %s has no node code by the deadline', containerId);
			throw new RentNodeError('node-not-ready', containerId);
		}
		await sleep(poll);
	}
}

async function requestNodeCode(client: ProviderClient, containerId: string): ReturnType<ProviderClient['getNodeCode']> {
	try {
		return await client.getNodeCode(containerId);
	} catch (error) {
		if (error instanceof ProviderApiError && error.code === 'CONTAINER_GONE') throw new RentNodeError('container-gone', containerId);
		throw error;
	}
}

async function finishClaim(node: RentingNode, client: ProviderClient, report: RentedContainerStatusReport, options: RentNodeOptions): Promise<RentNodeResult> {
	const { container, join } = report;
	if (join?.kind === 'claim' && join.state === 'claimed') return judgeClaimed(node, report);
	try {
		return await claimContainer(node, client, container.id, options);
	} catch (error) {
		// The node was claimed between the read and the code request; judge the fresh record.
		if (error instanceof ProviderApiError && error.code === 'ALREADY_CLAIMED') {
			return judgeClaimed(node, await client.getContainer(container.id));
		}
		throw error;
	}
}

/**
 * A claimed container is this cadre's when the claim named this party.
 *
 * NOTE: the row `claimNode` writes after the node accepts is not re-run here, because the
 * provider withholds the code once the claim is folded. An app killed between the node
 * accepting and that one local insert has a node that belongs to this owner with no row for it
 * on this machine, the window the React Native app's accepted tradeoff for cadre-host claims
 * names; the remedy is to delete the container and rent again. Revisit if a device run sees it.
 */
function judgeClaimed(node: RentingNode, report: RentedContainerStatusReport): RentNodeResult {
	const { container, join } = report;
	if (join?.kind !== 'claim' || join.state !== 'claimed') throw new RentNodeError('container-gone', container.id);
	if (join.partyId !== node.partyId) {
		log('container %s was claimed into another party', container.id);
		throw new RentNodeError('claimed-by-another', container.id);
	}
	return { containerId: container.id, join: 'claim', ...(container.peerId ? { peerId: container.peerId } : {}) };
}

/** Which path a container is on; refuses one that is gone or was never a rental. */
function joinKindOf(report: RentedContainerStatusReport, containerId: string): RentNodeJoin {
	const { container, join } = report;
	if (container.status === 'stopped' || container.status === 'error') throw new RentNodeError('container-gone', containerId);
	// The join state is folded from the node's first `/status` read, so a container still
	// starting carries only the kind it was created with.
	const kind = join?.kind ?? container.join?.kind;
	if (kind === undefined) throw new RentNodeError('not-a-rental', containerId);
	return kind;
}

function invitationResult(container: { id: string; peerId?: string }): RentNodeResult {
	return { containerId: container.id, join: 'invitation', ...(container.peerId ? { peerId: container.peerId } : {}) };
}

function report(options: RentNodeOptions, step: RentNodeStep): void {
	try {
		options.onProgress?.(step);
	} catch (error) {
		log('onProgress(%s) threw; ignored: %o', step, error);
	}
}

function sleep(ms: number): Promise<void> {
	// A plain timer, not an unref'd one: a Node process renting from a script must stay up for it.
	return new Promise((resolve) => setTimeout(resolve, ms));
}
