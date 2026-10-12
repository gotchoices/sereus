/**
 * rentals.ts — what Settings → "Rent an always-on node" (`provider-store-section.tsx`) shows for
 * each node rented from a hosting provider, from the app's rental record, the provider's answer
 * to `getContainer` and `getBillingStatus`, and whether the node is still a machine of this cadre;
 * and the words for each way renting can fail. No React and no native imports, so
 * `test/rentals.spec.ts` runs these in Node.
 */

import {
	ClaimRefusedError,
	PeerUnreachableError,
	ProviderApiError,
	ProviderAuthError,
	RentNodeError,
	type BillingStatus,
	type ContainerJoinState,
	type ProviderClient,
	type RentedContainer,
	type RentedContainerStatusReport,
	type RentNodeErrorCode,
	type RentNodeJoin,
	type RentNodeStep,
} from '@serfab/cadre-core';
import type { Rental } from '@serfab/cadre-rn/provider';
import { shortPeerId } from './machines';

/** What the last poll learned about a rental's container. */
export type ContainerReading =
	/** Not polled yet. */
	| { kind: 'unread' }
	/** No tokens are held, so nothing can be read until the user signs in. */
	| { kind: 'signed-out' }
	/** The poll failed in a way other than the two below. */
	| { kind: 'unreadable'; error: string }
	/** The provider no longer knows the container (404). */
	| { kind: 'gone' }
	| { kind: 'live'; report: RentedContainerStatusReport };

/** What a row offers; the section maps each to a handler. */
export type RentalAction =
	/** `finishRental`: a rental this app did not finish adding. */
	| 'finish'
	/** Delete the container and drop the record. */
	| 'cancel'
	/** Delete the container, drop the record and rent again. */
	| 'retry'
	/** Remove the node from the cadre (the Devices and nodes confirmation), then drop the record. */
	| 'remove'
	/** Drop the record only. */
	| 'forget';

export interface RentalRow {
	/** "Node from Acme Cadre Nodes" */
	title: string;
	/** The node's standing in a word or two. */
	status: string;
	/** The join in words, or null while the provider has not folded one yet. */
	join: string | null;
	/** The node's peer id, shortened, when known. */
	peerId: string | null;
	/** A line in warning colour: stopped for non-payment, a failed join, a node the provider forgot. */
	notice: string | null;
	actions: RentalAction[];
}

/**
 * The row for `rental`. `listed`: whether a machine with the rental's peer id is still in this
 * cadre, which is when removing it from the cadre is offered for a node the provider stopped.
 */
export function rentalRow(rental: Rental, reading: ContainerReading, listed: boolean): RentalRow {
	const name = rental.providerName;
	const title = `Node from ${name}`;
	const peerId = rental.peerId ?? (reading.kind === 'live' ? reading.report.container.peerId ?? null : null);
	const base = { title, peerId: peerId ? shortPeerId(peerId) : null };
	const unfinished: RentalAction[] = rental.finished ? [] : ['finish', 'cancel'];
	switch (reading.kind) {
		case 'unread':
			return { ...base, status: 'Checking…', join: null, notice: null, actions: unfinished };
		case 'signed-out':
			return { ...base, status: 'Sign in to see its status', join: null, notice: null, actions: [...unfinished, 'forget'] };
		case 'unreadable':
			return { ...base, status: 'Could not read its status', join: null, notice: reading.error, actions: [...unfinished, 'forget'] };
		case 'gone':
			return { ...base, status: 'Gone', join: null, notice: `${name} no longer knows this node.`, actions: stoppedActions(listed) };
		case 'live':
			return { ...base, ...liveRow(rental, reading.report, listed) };
	}
}

function liveRow(rental: Rental, report: RentedContainerStatusReport, listed: boolean): Pick<RentalRow, 'status' | 'join' | 'notice' | 'actions'> {
	const { container, join } = report;
	const name = rental.providerName;
	if (container.status === 'stopped') {
		return { status: 'Stopped', join: joinText(join), notice: stoppedNotice(container, name), actions: stoppedActions(listed) };
	}
	if (container.status === 'error') {
		return {
			status: 'Failed',
			join: joinText(join),
			notice: `${name} reports the node as failed${container.error ? `: ${container.error}` : ''}. Cancel it and rent again.`,
			actions: listed ? ['cancel', 'remove'] : ['cancel'],
		};
	}
	if (join?.kind === 'invitation' && join.state === 'failed') {
		return { status: statusText(report), join: null, notice: `Could not join: ${join.error}`, actions: ['retry', 'cancel'] };
	}
	return { status: statusText(report), join: joinText(join), notice: null, actions: rental.finished ? [] : ['finish', 'cancel'] };
}

/** A stopped or forgotten node: out of the cadre if it is still listed there, else just out of this list. */
function stoppedActions(listed: boolean): RentalAction[] {
	return listed ? ['remove', 'forget'] : ['forget'];
}

function stoppedNotice(container: RentedContainer, name: string): string {
	switch (container.stopReason) {
		case 'non-payment':
			return `${name} stopped this node for non-payment.`;
		case 'customer':
			return `This node was stopped from ${name}'s site.`;
		default:
			return 'This node was stopped.';
	}
}

/** The container's standing, with the node's own health once it runs. */
function statusText({ container, health }: RentedContainerStatusReport): string {
	switch (container.status) {
		case 'pending':
		case 'creating':
			return 'Starting';
		case 'enrolling':
			return 'Starting its node';
		case 'running':
			return health?.status === 'unhealthy' ? 'Running, not healthy' : health?.status === 'starting' ? 'Starting' : 'Running';
		case 'stopping':
			return 'Stopping';
		case 'stopped':
			return 'Stopped';
		case 'error':
			return 'Failed';
	}
}

/** The join as the provider last folded it from the node; null until the node reported once. */
function joinText(join: ContainerJoinState | undefined): string | null {
	if (!join) return null;
	switch (join.kind) {
		case 'claim':
			return join.state === 'awaiting' ? 'Waiting for this phone to claim it' : 'Joined';
		case 'invitation':
			switch (join.state) {
				case 'pending':
					return 'Joining through a machine of this cadre';
				case 'accepted':
					return join.memberPeerId ? `Joined through ${shortPeerId(join.memberPeerId)}` : 'Joined';
				case 'failed':
					return `Could not join: ${join.error}`;
			}
	}
}

/**
 * "Renews 12 Nov", "Unpaid, stops 15 Nov" or "Subscription lapsed"; null when the customer has no
 * billing record. `formatDate` is the phone's own date format.
 */
export function billingText(billing: BillingStatus | undefined, formatDate: (ms: number) => string): string | null {
	if (!billing) return null;
	const { status, renewsAt, lapsesAt } = billing.subscription;
	switch (status) {
		case 'active':
			return renewsAt !== null ? `Renews ${formatDate(renewsAt)}` : 'Subscription active';
		case 'past-due':
			return lapsesAt !== null ? `Unpaid, stops ${formatDate(lapsesAt)}` : 'Unpaid';
		case 'lapsed':
			return 'Subscription lapsed';
	}
}

/** The reading a failed `getContainer` leaves: `gone` for a 404, else the error's words. */
export function readingFromError(err: unknown): ContainerReading {
	if (err instanceof ProviderApiError && err.status === 404) return { kind: 'gone' };
	return { kind: 'unreadable', error: err instanceof Error ? err.message : String(err) };
}

/** The progress line for each `rentNode` step. */
export function rentStepText(step: RentNodeStep, providerName: string): string {
	switch (step) {
		case 'inviting':
			return 'Making an invitation for the node…';
		case 'creating':
			return `Asking ${providerName} for a node…`;
		case 'waiting-for-code':
			return 'Waiting for the node to start…';
		case 'claiming':
			return 'Reaching the node and adding it to this cadre…';
		case 'done':
			return 'Done.';
	}
}

export interface RentalFailureDescription {
	/** What to tell the person holding the phone. */
	message: string;
	/** The underlying error's own words, for bug reports. */
	detail?: string;
}

/** Keyed by the error's own code type, so a code added to cadre-core fails typecheck here until it has words. */
const RENT_REFUSAL: Record<RentNodeErrorCode, (providerName: string) => string> = {
	'not-an-owner': () => 'Only an owner can rent a node for this cadre, and this device is not one.',
	'node-not-ready': () => 'The node has not started yet. It may still be starting: its row offers Finish adding.',
	'container-gone': (name) => `${name} reports this node as stopped or failed. Cancel it and rent again.`,
	'claimed-by-another': () => 'This node was claimed into another cadre. Cancel it and rent again.',
	'not-a-rental': () => 'This node was not rented through this app, so it cannot be added from here. Forget it.',
};

/** What to tell the user about `error`, thrown while renting from or finishing a rental at `providerName`. */
export function describeRentalFailure(error: unknown, providerName: string): RentalFailureDescription {
	const detail = error instanceof Error ? error.message : String(error);
	if (error instanceof RentNodeError) return { message: RENT_REFUSAL[error.code](providerName), detail };
	if (error instanceof ProviderApiError) return { message: providerRefusal(error, providerName), detail };
	if (error instanceof ProviderAuthError) return { message: signInFailure(error, providerName), detail };
	if (error instanceof PeerUnreachableError) {
		return { message: `This phone could not reach the node at the address ${providerName} gave. Check this phone's connection; the node may still be starting, and its row offers Finish adding.`, detail };
	}
	if (error instanceof ClaimRefusedError) {
		return { message: `The node refused to join this cadre${error.code ? ` (${error.code})` : ''}. Cancel it and rent again.`, detail: error.reason };
	}
	return { message: 'Renting the node did not finish. If its row appears below, Finish adding continues where it stopped.', detail };
}

function providerRefusal(error: ProviderApiError, name: string): string {
	if (error.status === 403 && error.code === 'QUOTA_EXCEEDED') {
		return `${name} refused: the subscription has lapsed or the plan's node limit is reached. Check the account on ${name}'s site.`;
	}
	if (error.status === 404) return `${name} no longer knows this node.`;
	return `${name} answered ${error.status} ${error.code}: ${error.message}`;
}

function signInFailure(error: ProviderAuthError, name: string): string {
	switch (error.code) {
		case 'reauthorize':
			return `The sign-in at ${name} has expired. Sign in again.`;
		case 'access_denied':
			return `${name} did not sign you in.`;
		case 'state-mismatch':
			return 'The sign-in came back with an answer to a different request. Try again.';
		default:
			return `Signing in to ${name} failed (${error.code}).`;
	}
}

/**
 * `client` with its create recorded: `onCreated` runs with the new container and the join kind
 * before the create returns, so the app's rental record exists before `rentNode` goes on to
 * claim or returns. A record that cannot be written is logged and the create still returns:
 * the container exists, and finishing the join matters more than the app's bookkeeping.
 */
export function recordingClient(client: ProviderClient, onCreated: (container: RentedContainer, join: RentNodeJoin) => Promise<void>): ProviderClient {
	return {
		async createContainer(body) {
			const container = await client.createContainer(body);
			try {
				await onCreated(container, body.join.kind);
			} catch (err) {
				console.warn(`[rentals] could not record the rental of container ${container.id}:`, err);
			}
			return container;
		},
		getContainer: (id) => client.getContainer(id),
		listContainers: () => client.listContainers(),
		deleteContainer: (id) => client.deleteContainer(id),
		getBillingStatus: () => client.getBillingStatus(),
		getNodeCode: (id) => client.getNodeCode(id),
	};
}
