/**
 * provider-store-section.tsx — Settings → "Rent an always-on node": one hosting provider
 * (`providers.ts`), its plans and terms, and **Subscribe and add node**, which signs the user in on
 * the provider's own pages in the system browser, rents a container and adds it to this cadre
 * (cadre-core's `rentNode`, through `useCadre`; docs/reference-app-rn.md → "Renting a Provider
 * Node"). Below, one row per node this phone rented, re-read from the provider every few seconds
 * while Settings is in front (`use-rental-poll.ts`): its standing, its join, and what to do about a
 * node the provider stopped (`rentals.ts`). Removing such a node from the cadre is the Devices and
 * nodes confirmation (`machine-removal.tsx`).
 *
 * The sign-in's code and the tokens are credentials: log the container id and the peer id only.
 */

import { useEffect, useRef, useState } from 'react';
import { Image, Linking, Modal, ScrollView, StyleSheet, Text, View } from 'react-native';
import * as WebBrowser from 'expo-web-browser';
import type { BillingStatus, RentalFailed, RentNodeResult, RentNodeStep } from '@serfab/cadre-core';
import type { Rental } from '@serfab/cadre-rn/provider';
import { useCadre } from './cadre-context';
import { ownScheme, providerTokens } from './cadre-phone';
import { useMachineRemoval } from './machine-removal';
import { standingLine, useOwnerStanding } from './owner-standing';
import { openProviderSession, type ProviderSession } from './provider-session';
import { configuredProviders, fetchPlans, planPriceText, providerRedirectUri, type ConfiguredProvider, type ProviderPlan } from './providers';
import { billingText, describeRentalFailure, readingFromError, rentalRow, rentStepText, type ContainerReading, type RentalAction } from './rentals';
import { Btn, ConfirmPrompt, controlStyles, errorMessage, Fact, Section, useLaterThan } from './settings-controls';
import { TEST_IDS } from './test-ids';
import { useRentalPoll } from './use-rental-poll';

/** The providers this build offers; Settings mounts the section only when there is one. */
export const PROVIDERS = configuredProviders();

/** When the progress line adds that some addresses are not answering; as in the add-node section. */
const CLAIM_SLOW_HINT_MS = 20_000;

const ACTION_LABEL: Record<RentalAction, string> = {
	finish: 'Finish adding',
	cancel: 'Cancel',
	retry: 'Try again',
	remove: 'Remove from cadre',
	forget: 'Forget',
};

type ShowAlert = (title: string, message: string, detail?: string) => void;

/** The provider as the section holds it: its session once the descriptor is read, or why it is not. */
type Store =
	| { state: 'loading' }
	| { state: 'failed'; error: string }
	| { state: 'ready'; session: ProviderSession; plans: ProviderPlan[] | null; plansError: string | null };

/** What the progress line shows while a rental step runs. */
interface Progress {
	text: string;
	/** `claimNode` is running: the slow hint applies. */
	claiming: boolean;
}

// NOTE: screen state, as in AddNodeSection: the tab navigator keeps Settings mounted, so a running
// rental's progress survives a tab switch. If Settings is ever unmounted on blur, the rental would
// run on in the hook with nothing showing it; move this state into the cadre context then.
export function ProviderStoreSection({ provider, showAlert, onRentalsChanged }: {
	provider: ConfiguredProvider;
	showAlert: ShowAlert;
	/** After a rental is recorded, finished, cancelled or forgotten: Devices and nodes shows "Rented from". */
	onRentalsChanged: () => void;
}) {
	const cadre = useCadre();
	const [store, setStore] = useState<Store>({ state: 'loading' });
	// Bumped by Retry after a failed descriptor read.
	const [attempt, setAttempt] = useState(0);
	// Bumped by every action, so the rows are re-read at once rather than at the next tick, and the
	// standing with them, so an unreadable one is not stuck until the next join.
	const [tick, setTick] = useState(0);
	const standing = useOwnerStanding(tick);
	const { rentals, readings, billing, machines, signedIn } = useRentalPoll(store.state === 'ready' ? store.session : null, tick);
	// The approval prompt shows while set.
	const [approving, setApproving] = useState(false);
	// The rental whose Cancel confirmation is open.
	const [cancelling, setCancelling] = useState<Rental | null>(null);
	const [progress, setProgress] = useState<Progress | null>(null);
	// Catches the same-frame double tap that `disabled` cannot: the prop only takes effect after the re-render `setProgress` schedules.
	const busyRef = useRef(false);
	const slow = useLaterThan(progress?.claiming ?? false, CLAIM_SLOW_HINT_MS);

	// ── The provider ────────────────────────────────────────────────────────

	useEffect(() => {
		let stale = false;
		setStore({ state: 'loading' });
		const open = async () => {
			const session = await openProviderSession(provider, providerRedirectUri(ownScheme()), {
				openAuthSession: WebBrowser.openAuthSessionAsync,
				tokensFor: providerTokens,
			});
			if (stale) return;
			setStore({ state: 'ready', session, plans: null, plansError: null });
			try {
				const plans = await fetchPlans(session.descriptor.plansUrl);
				if (!stale) setStore((current) => (current.state === 'ready' ? { ...current, plans } : current));
			} catch (err) {
				console.warn('[settings] could not read the provider\'s plans:', err);
				if (!stale) setStore((current) => (current.state === 'ready' ? { ...current, plansError: errorMessage(err) } : current));
			}
		};
		open().catch((err: unknown) => {
			console.warn('[settings] could not read the provider:', err);
			if (!stale) setStore({ state: 'failed', error: errorMessage(err) });
		});
		return () => {
			stale = true;
		};
	}, [provider, attempt]);

	// ── Actions ─────────────────────────────────────────────────────────────

	/** Run one rental step with the progress line; a second tap while one runs is ignored. */
	const run = async (label: string, action: (session: ProviderSession) => Promise<void>): Promise<void> => {
		if (store.state !== 'ready' || busyRef.current) return;
		busyRef.current = true;
		setProgress({ text: label, claiming: false });
		try {
			await action(store.session);
		} finally {
			busyRef.current = false;
			setProgress(null);
			setTick((n) => n + 1);
			onRentalsChanged();
		}
	};

	const name = store.state === 'ready' ? store.session.descriptor.name : '';
	const onProgress = (step: RentNodeStep) => setProgress({ text: rentStepText(step, name), claiming: step === 'claiming' });

	const alertFailure = (title: string, err: unknown) => {
		const failure = describeRentalFailure(err, name);
		showAlert(title, failure.message, failure.detail);
	};

	/** The alert for a rental that returned: added by claim, requested by invitation, or an invitation join that failed. */
	const reportRental = (result: RentNodeResult | RentalFailed) => {
		if ('outcome' in result) {
			showAlert('The node could not join', `${result.error}${result.retryable ? ' Try again from its row.' : ' Cancel it from its row and rent again.'}`);
			return;
		}
		console.info(`[settings] rental ${result.containerId} done by ${result.join}${result.peerId ? `; its node is ${result.peerId}` : ''}`);
		if (result.join === 'claim') {
			showAlert('Node added', `Node ${result.peerId ?? ''}.\n\nThe node restarts once under this cadre; it then connects by itself.`);
		} else {
			showAlert('Node requested', `${name} is starting the node, which joins this cadre through one of its machines by itself. Its row shows when it has.`);
		}
	};

	/** Rent and add a node; the user closing the browser leaves nothing behind. */
	const rent = async (session: ProviderSession) => {
		const { id } = session.descriptor;
		let created: string | null = null;
		// A token the provider refuses after the container exists resumes that container on the
		// retry, rather than renting a second one.
		const result = await session.withClient((client) => (created === null
			? cadre.rentProviderNode({ id, name }, client, { onProgress, onCreated: (containerId) => { created = containerId; } })
			: cadre.finishProviderRental(client, created, onProgress)));
		if (result !== 'cancelled') reportRental(result);
	};

	const handleApprove = () => {
		setApproving(false);
		void run(`Contacting ${name}…`, async (session) => {
			try {
				await rent(session);
			} catch (err) {
				console.warn('[settings] renting a node failed:', err);
				alertFailure('Renting the node failed', err);
			}
		});
	};

	const handleFinish = (rental: Rental) => void run(`Contacting ${name}…`, async (session) => {
		try {
			const result = await session.withClient((client) => cadre.finishProviderRental(client, rental.containerId, onProgress));
			if (result !== 'cancelled') reportRental(result);
		} catch (err) {
			console.warn(`[settings] finishing rental ${rental.containerId} failed:`, err);
			alertFailure('Adding the node failed', err);
		}
	});

	/** Delete the container at the provider (one the provider already forgot counts as deleted) and drop the record. */
	const cancelRental = async (session: ProviderSession, rental: Rental): Promise<boolean> => {
		const outcome = await session.withClient(async (client) => {
			try {
				await client.deleteContainer(rental.containerId);
			} catch (err) {
				if (readingFromError(err).kind !== 'gone') throw err;
			}
		});
		if (outcome === 'cancelled') return false;
		await cadre.forgetRental(rental.containerId);
		console.info(`[settings] cancelled rental ${rental.containerId}`);
		return true;
	};

	const handleConfirmCancel = () => {
		const rental = cancelling;
		setCancelling(null);
		if (!rental) return;
		void run(`Cancelling the node at ${name}…`, async (session) => {
			try {
				await cancelRental(session, rental);
			} catch (err) {
				console.warn(`[settings] cancelling rental ${rental.containerId} failed:`, err);
				alertFailure('Could not cancel the node', err);
			}
		});
	};

	const handleRetry = (rental: Rental) => void run(`Cancelling the node at ${name}…`, async (session) => {
		try {
			if (!await cancelRental(session, rental)) return;
			await rent(session);
		} catch (err) {
			console.warn(`[settings] renting again after ${rental.containerId} failed:`, err);
			alertFailure('Renting the node again failed', err);
		}
	});

	const removal = useMachineRemoval({
		showAlert,
		onRemoved: (machine) => {
			const rental = rentals.find((entry) => entry.peerId === machine.peerId);
			if (rental) void handleForget(rental);
		},
	});

	const handleRemove = (rental: Rental) => {
		const machine = machines.find((entry) => entry.peerId === rental.peerId);
		if (machine) removal.request(machine, machines);
	};

	const handleForget = async (rental: Rental) => {
		try {
			await cadre.forgetRental(rental.containerId);
		} catch (err) {
			console.warn(`[settings] forgetting rental ${rental.containerId} failed:`, err);
			showAlert('Could not forget the node', errorMessage(err));
		}
		setTick((n) => n + 1);
		onRentalsChanged();
	};

	const handleAction = (action: RentalAction, rental: Rental) => {
		switch (action) {
			case 'finish': return handleFinish(rental);
			case 'cancel': return setCancelling(rental);
			case 'retry': return handleRetry(rental);
			case 'remove': return handleRemove(rental);
			case 'forget': return void handleForget(rental);
		}
	};

	const handleSignIn = () => void run(`Signing in to ${name}…`, async (session) => {
		try {
			await session.signIn();
		} catch (err) {
			console.warn('[settings] signing in to the provider failed:', err);
			alertFailure('Sign-in failed', err);
		}
	});

	const handleSignOut = () => void run(`Signing out of ${name}…`, async (session) => {
		try {
			await session.signOut();
		} catch (err) {
			console.warn('[settings] signing out of the provider failed:', err);
			showAlert('Could not sign out', errorMessage(err));
		}
	});

	// ── Render ──────────────────────────────────────────────────────────────

	const busy = progress !== null || removal.busy;
	return (
		<Section title="Rent an always-on node">
			{store.state === 'loading' && <Text style={controlStyles.hint}>Reading the provider…</Text>}
			{store.state === 'failed' && (
				<>
					<Text style={controlStyles.slowHint}>Could not read the provider: {store.error}</Text>
					<Btn label="Retry" onPress={() => setAttempt((n) => n + 1)} color="#444" testID={TEST_IDS.settings.retryProviderBtn} />
				</>
			)}
			{store.state === 'ready' && (
				<>
					<ProviderCard session={store.session} plans={store.plans} plansError={store.plansError} />
					{(standing === 'member' || standing === 'unreadable') && <Text style={controlStyles.hint}>{standingLine(standing, 'rent a node')}</Text>}
					{standing === 'owner' && (
						<Btn label="Subscribe and add node" onPress={() => setApproving(true)} disabled={busy} testID={TEST_IDS.settings.rentNodeBtn} />
					)}
					{progress && (
						<Text style={controlStyles.slowHint} testID={TEST_IDS.settings.rentNodeProgress}>
							{progress.text}
							{slow ? '\nSome of the node\'s addresses are not answering; still trying the others.' : ''}
						</Text>
					)}
					{rentals.map((rental) => (
						<RentalRowView
							key={rental.containerId}
							rental={rental}
							reading={readings.get(rental.containerId) ?? { kind: 'unread' }}
							listed={rental.peerId !== undefined && machines.some((machine) => machine.peerId === rental.peerId && machine.isMember)}
							busy={busy}
							onAction={handleAction}
						/>
					))}
					{signedIn ? (
						<>
							<SubscriptionLine billing={billing} />
							<Text style={controlStyles.hint}>
								{`Signed in to ${name}. `}
								<Text style={styles.link} onPress={handleSignOut} testID={TEST_IDS.settings.providerSignOutBtn}>Sign out</Text>
							</Text>
						</>
					) : rentals.length > 0 && (
						<Btn label={`Sign in to ${name}`} onPress={handleSignIn} disabled={busy} color="#444" testID={TEST_IDS.settings.providerSignInBtn} />
					)}
					<ApprovalPrompt
						open={approving}
						providerName={name}
						partyId={cadre.node?.partyId ?? '—'}
						onApprove={handleApprove}
						onCancel={() => setApproving(false)}
					/>
					<ConfirmPrompt
						open={cancelling !== null}
						title="Cancel this node?"
						text={`${name} deletes the node and whatever it holds. The subscription itself is managed on ${name}'s site.`}
						confirmLabel="Cancel the node"
						onConfirm={handleConfirmCancel}
						onCancel={() => setCancelling(null)}
						confirmTestID={TEST_IDS.settings.confirmCancelRentalBtn}
						cancelTestID={TEST_IDS.settings.cancelCancelRentalBtn}
					/>
					{removal.prompt}
				</>
			)}
		</Section>
	);
}

/** The provider's name, icon, regions and plans, and the links to its terms and its site. */
function ProviderCard({ session, plans, plansError }: { session: ProviderSession; plans: ProviderPlan[] | null; plansError: string | null }) {
	const { descriptor } = session;
	const terms = descriptor.termsUrl;
	// Expo's runtime installs a WHATWG `URL` (React Native's own has no `origin`).
	const site = new URL(descriptor.apiBaseUrl).origin;
	return (
		<View style={styles.card}>
			<View style={styles.cardHeader}>
				{descriptor.icon && <Image source={{ uri: descriptor.icon }} style={styles.icon} />}
				<Text style={styles.providerName}>{descriptor.name}</Text>
			</View>
			{descriptor.regions && descriptor.regions.length > 0 && <Text style={controlStyles.listRowMeta}>{`Regions: ${descriptor.regions.join(', ')}`}</Text>}
			{plans === null && plansError === null && <Text style={controlStyles.listRowMeta}>Reading the plans…</Text>}
			{plansError !== null && <Text style={controlStyles.slowHint}>{`Could not read the plans: ${plansError}`}</Text>}
			{plans?.map((plan) => (
				<Text key={plan.id} style={controlStyles.listRowMeta}>{`${plan.name}: ${planPriceText(plan)}`}</Text>
			))}
			<Text style={controlStyles.hint}>
				{'You sign in and pay on the provider\'s own site; the plan is chosen there. '}
				{terms && <Text style={styles.link} onPress={() => void Linking.openURL(terms)}>Terms</Text>}
				{terms ? ' · ' : ''}
				<Text style={styles.link} onPress={() => void Linking.openURL(site)}>{`${descriptor.name}'s site`}</Text>
			</Text>
		</View>
	);
}

/** "Subscription: Renews 12 Nov 2026", once for the account, since every node rented here is on it. */
function SubscriptionLine({ billing }: { billing: BillingStatus | undefined }) {
	const text = billingText(billing, (ms) => new Date(ms).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' }));
	if (text === null) return null;
	return <Text style={billing?.subscription.status === 'active' ? controlStyles.listRowMeta : controlStyles.slowHint}>{`Subscription: ${text}`}</Text>;
}

function RentalRowView({ rental, reading, listed, busy, onAction }: {
	rental: Rental;
	reading: ContainerReading;
	/** A machine with the rental's peer id is still a member of this cadre. */
	listed: boolean;
	busy: boolean;
	onAction: (action: RentalAction, rental: Rental) => void;
}) {
	const row = rentalRow(rental, reading, listed);
	return (
		<View style={styles.row} testID={TEST_IDS.settings.rentalRow(rental.containerId)}>
			<Text style={controlStyles.listRowTitle}>{row.title}</Text>
			<Text style={controlStyles.listRowMeta}>{[row.status, row.join, row.peerId].filter((part) => part !== null).join(' · ')}</Text>
			{row.notice && <Text style={controlStyles.slowHint}>{row.notice}</Text>}
			{row.actions.length > 0 && (
				<View style={styles.actions}>
					{row.actions.map((action) => (
						<View key={action} style={styles.action}>
							<Btn
								label={ACTION_LABEL[action]}
								onPress={() => onAction(action, rental)}
								disabled={busy}
								color={action === 'finish' || action === 'retry' ? undefined : '#444'}
								testID={TEST_IDS.settings.rentalActionBtn(action, rental.containerId)}
							/>
						</View>
					))}
				</View>
			)}
		</View>
	);
}

/** Nothing is rented until the user agrees, because the prompt is where they see which cadre the node joins and where they pay. */
function ApprovalPrompt({ open, providerName, partyId, onApprove, onCancel }: {
	open: boolean;
	providerName: string;
	partyId: string;
	onApprove: () => void;
	onCancel: () => void;
}) {
	return (
		<Modal visible={open} transparent animationType="fade" onRequestClose={onCancel}>
			<View style={controlStyles.modalOverlay}>
				<View style={controlStyles.modalBox}>
					<Text style={controlStyles.modalTitle}>{`Rent a node from ${providerName}?`}</Text>
					<ScrollView>
						<Text style={controlStyles.promptText}>
							{`Rent a node from ${providerName} and add it to cadre ${partyId}? You will sign in and pay on ${providerName}'s site.`}
						</Text>
						<Fact label="Cadre" value={partyId} />
						<Fact label="Provider" value={providerName} note="The node joins this cadre as an always-on member, not as an owner." />
					</ScrollView>
					<Btn label="Subscribe and add node" onPress={onApprove} testID={TEST_IDS.settings.approveRentNodeBtn} />
					<Btn label="Cancel" onPress={onCancel} color="#444" testID={TEST_IDS.settings.cancelRentNodeBtn} />
				</View>
			</View>
		</Modal>
	);
}

const styles = StyleSheet.create({
	card: { backgroundColor: '#1e1e2e', borderRadius: 8, padding: 12, marginBottom: 8 },
	cardHeader: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 4 },
	icon: { width: 24, height: 24, borderRadius: 4 },
	providerName: { color: '#fff', fontSize: 15, fontWeight: '600' },
	link: { color: '#6c63ff', textDecorationLine: 'underline' },
	row: { marginTop: 10 },
	actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
	action: { flexGrow: 1, minWidth: 120 },
});
