/**
 * rentals.spec.ts — what Settings → "Rent an always-on node" shows for a rented node
 * (`rentalRow` in src/rentals.ts): which actions each state of the rental record, the
 * provider's answer and the cadre's machine list offers, and the subscription line. The
 * errors are the real classes cadre-core throws, so an `instanceof` that stops matching
 * fails here rather than on a phone.
 */

import { describe, expect, it } from 'vitest';
import { ProviderApiError, RentNodeError, type BillingStatus, type RentedContainer, type RentedContainerStatusReport } from '@serfab/cadre-core';
import type { Rental } from '@serfab/cadre-rn/provider';
import { parsePlans } from '../src/providers';
import { billingText, describeRentalFailure, readingFromError, rentalRow, type ContainerReading } from '../src/rentals';

const PEER_ID = '12D3KooWMwa4jCjcL96kdsfjqxdNKFooX8YxaQZ2SqBNzpWvJsRX';
const MEMBER_ID = '12D3KooWQVo7JTYHgoj9rt9HScoxaM5axn3uB8P1WHiKrhhUqed3';

function rental(overrides: Partial<Rental> = {}): Rental {
	return { providerId: 'acme', providerName: 'Acme Nodes', containerId: 'c1', join: 'claim', createdAt: 1_000, finished: true, ...overrides };
}

function container(overrides: Partial<RentedContainer> = {}): RentedContainer {
	return { id: 'c1', partyId: 'party-a', profile: 'storage', status: 'running', createdAt: 1_000, updatedAt: 2_000, peerId: PEER_ID, tags: {}, ...overrides };
}

function live(report: Omit<RentedContainerStatusReport, 'container'> & { container?: Partial<RentedContainer> }): ContainerReading {
	return { kind: 'live', report: { ...report, container: container(report.container) } };
}

describe('rentalRow', () => {
	it.each<{ case: string; rental: Rental; reading: ContainerReading; listed: boolean; actions: string[]; status: string; join: string | null; notice: RegExp | null }>([
		{
			case: 'a claim this phone has not finished: Finish adding and Cancel',
			rental: rental({ finished: false }),
			reading: live({ container: { status: 'running' }, join: { kind: 'claim', state: 'awaiting' } }),
			listed: false, actions: ['finish', 'cancel'], status: 'Running', join: 'Waiting for this phone to claim it', notice: null,
		},
		{
			case: 'an unfinished claim before any poll answered still offers Finish adding',
			rental: rental({ finished: false }),
			reading: { kind: 'unread' },
			listed: false, actions: ['finish', 'cancel'], status: 'Checking…', join: null, notice: null,
		},
		{
			case: 'a running, claimed node: nothing to do',
			rental: rental(),
			reading: live({ container: { status: 'running' }, health: { status: 'healthy' }, join: { kind: 'claim', state: 'claimed', ownerKey: 'k', partyId: 'party-a' } }),
			listed: true, actions: [], status: 'Running', join: 'Joined', notice: null,
		},
		{
			case: 'an invitation node that joined names the member that admitted it',
			rental: rental({ join: 'invitation' }),
			reading: live({ join: { kind: 'invitation', state: 'accepted', memberPeerId: MEMBER_ID } }),
			listed: true, actions: [], status: 'Running', join: `Joined through ${MEMBER_ID.slice(0, 12)}…${MEMBER_ID.slice(-6)}`, notice: null,
		},
		{
			case: 'an invitation node that could not join: Try again and Cancel',
			rental: rental({ join: 'invitation' }),
			reading: live({ join: { kind: 'invitation', state: 'failed', error: 'no member answered', retryable: true } }),
			listed: false, actions: ['retry', 'cancel'], status: 'Running', join: null, notice: /Could not join: no member answered/,
		},
		{
			case: 'stopped for non-payment while still in the cadre: Remove from cadre and Forget',
			rental: rental({ peerId: PEER_ID }),
			reading: live({ container: { status: 'stopped', stopReason: 'non-payment' }, join: { kind: 'claim', state: 'claimed', ownerKey: 'k', partyId: 'party-a' } }),
			listed: true, actions: ['remove', 'forget'], status: 'Stopped', join: 'Joined', notice: /Acme Nodes stopped this node for non-payment/,
		},
		{
			case: 'stopped by the customer and already out of the cadre: Forget only',
			rental: rental({ peerId: PEER_ID }),
			reading: live({ container: { status: 'stopped', stopReason: 'customer' } }),
			listed: false, actions: ['forget'], status: 'Stopped', join: null, notice: /stopped from Acme Nodes's site/,
		},
		{
			case: 'a node the provider no longer knows, still listed in the cadre',
			rental: rental({ peerId: PEER_ID }),
			reading: { kind: 'gone' },
			listed: true, actions: ['remove', 'forget'], status: 'Gone', join: null, notice: /no longer knows this node/,
		},
		{
			case: 'signed out: the row says so and still offers Forget',
			rental: rental(),
			reading: { kind: 'signed-out' },
			listed: true, actions: ['forget'], status: 'Sign in to see its status', join: null, notice: null,
		},
	])('$case', ({ rental: record, reading, listed, actions, status, join, notice }) => {
		const row = rentalRow(record, reading, listed);
		expect(row.actions).toEqual(actions);
		expect(row.status).toBe(status);
		expect(row.join).toBe(join);
		if (notice) expect(row.notice).toMatch(notice);
		else expect(row.notice).toBeNull();
	});
});

describe('billingText', () => {
	const at = (ms: number) => `@${ms}`;
	const billing = (subscription: BillingStatus['subscription']): BillingStatus => ({ planId: 'basic', subscription });

	it.each<[string, BillingStatus | undefined, string | null]>([
		['active, renewing', billing({ status: 'active', renewsAt: 5, lapsesAt: null }), 'Renews @5'],
		['past due, with the stop date', billing({ status: 'past-due', renewsAt: null, lapsesAt: 9 }), 'Unpaid, stops @9'],
		['lapsed', billing({ status: 'lapsed', renewsAt: null, lapsesAt: null }), 'Subscription lapsed'],
		['no billing record', undefined, null],
	])('%s', (_label, status, expected) => {
		expect(billingText(status, at)).toBe(expected);
	});
});

describe('describeRentalFailure and readingFromError', () => {
	it('tells a lapsed subscription from a node the provider forgot', () => {
		const lapsed = new ProviderApiError(403, 'QUOTA_EXCEEDED', 'subscription lapsed');
		expect(describeRentalFailure(lapsed, 'Acme Nodes').message).toMatch(/subscription has lapsed/);
		const forgotten = new ProviderApiError(404, 'NOT_FOUND', 'no such container');
		expect(describeRentalFailure(forgotten, 'Acme Nodes').message).toMatch(/no longer knows this node/);
		expect(readingFromError(forgotten)).toEqual({ kind: 'gone' });
		expect(readingFromError(new Error('network down'))).toEqual({ kind: 'unreadable', error: 'network down' });
	});

	it('points a node that did not start in time at Finish adding', () => {
		expect(describeRentalFailure(new RentNodeError('node-not-ready', 'c1'), 'Acme Nodes').message).toMatch(/Finish adding/);
	});
});

describe('parsePlans', () => {
	it('reads the plans out of the provider\'s envelope and refuses a plan without a price', () => {
		const plans = parsePlans({ ok: true, data: { plans: [{ id: 'basic', name: 'Basic', pricePerHourCents: 5, maxContainers: 1 }] } });
		expect(plans).toEqual([{ id: 'basic', name: 'Basic', pricePerHourCents: 5 }]);
		expect(() => parsePlans({ ok: true, data: { plans: [{ id: 'basic', name: 'Basic' }] } })).toThrow(/price per hour/);
	});
});
