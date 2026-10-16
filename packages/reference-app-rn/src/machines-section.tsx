/**
 * machines-section.tsx — Settings → "Devices and nodes": every machine of this cadre (apps and
 * always-on nodes) and the devices invited and not joined yet, and on an owner device, Remove
 * (`machine-removal.tsx`; docs/architecture.md → "Removing a machine"). A node this phone rented
 * from a hosting provider says so, from the app's rental record. The words for a listed machine
 * are `machines.ts`'s.
 */

import { useEffect, useRef, useState } from 'react';
import { Text, View } from 'react-native';
import { parseNullableStoredDatetimeMs, type CadreInviteStatus, type CadreMachine } from '@serfab/cadre-core';
import type { Rental } from '@serfab/cadre-rn/provider';
import { useCadre } from './cadre-context';
import { SELF_LINE, useMachineRemoval } from './machine-removal';
import { lastSeenText, machineCode, machineKind, pendingDeviceInvitations, rentedFromText } from './machines';
import { standingLine, useOwnerStanding } from './owner-standing';
import { Btn, controlStyles, errorMessage, Section, shortPeerId, validUntilText, WithdrawPrompt } from './settings-controls';
import { TEST_IDS } from './test-ids';

type ShowAlert = (title: string, message: string, detail?: string) => void;

interface Listing {
	machines: CadreMachine[];
	/** Live invitations for one device that has not joined yet. */
	pending: CadreInviteStatus[];
	/** This phone's rentals, for the "Rented from" fact; empty when the record could not be read. */
	rentals: Rental[];
	/** When it was read, for "last seen". */
	readAtMs: number;
}

// NOTE: screen state, as in AddDeviceSection: the tab navigator keeps Settings mounted. The
// section unmounts with the connected view, so a prompt open when this phone is itself removed
// closes with it.
export function MachinesSection({ showAlert, refreshKey }: {
	showAlert: ShowAlert;
	/** Bumped by Add a device or app after it makes or withdraws an invitation, and by Rent an always-on node after a rental changes. */
	refreshKey: number;
}) {
	const cadre = useCadre();
	// Refresh re-reads the standing too, so an unreadable one is not stuck until the next join.
	const [refreshes, setRefreshes] = useState(0);
	const standing = useOwnerStanding(`${refreshKey}/${refreshes}`);
	const [listing, setListing] = useState<Listing>({ machines: [], pending: [], rentals: [], readAtMs: 0 });
	const [listError, setListError] = useState<string | null>(null);
	const [withdrawing, setWithdrawing] = useState<CadreInviteStatus | null>(null);
	// The node now, so a read that finishes after a join or a stop replaced it is dropped.
	const nodeRef = useRef(cadre.node);
	nodeRef.current = cadre.node;

	const refresh = async () => {
		const node = cadre.node;
		try {
			const machines = await cadre.listMachines();
			const invitations = await cadre.listCadreInvitations();
			const rentals = await readRentalsQuietly(cadre.listRentals);
			if (nodeRef.current !== node) return;
			setListing({ machines, pending: pendingDeviceInvitations(invitations, machines), rentals, readAtMs: Date.now() });
			setListError(null);
		} catch (err) {
			console.warn('[settings] could not read this cadre\'s machines:', err);
			if (nodeRef.current === node) setListError(errorMessage(err));
		}
	};

	// A join replaces the node, and the owner standing may change with it.
	useEffect(() => {
		void refresh();
	}, [cadre.node, refreshKey]);

	const removal = useMachineRemoval({ showAlert, onRemoved: () => void refresh() });

	const withdraw = async (key: string) => {
		try {
			if (!await cadre.withdrawCadreInvitation(key)) {
				console.info(`[settings] cadre invitation ${key} was already withdrawn`);
			}
		} catch (err) {
			console.warn(`[settings] withdrawing cadre invitation ${key} failed:`, err);
			showAlert('Could not withdraw the invitation', errorMessage(err));
		}
		await refresh();
	};

	const handleConfirmWithdraw = () => {
		const status = withdrawing;
		setWithdrawing(null);
		if (status) void withdraw(status.invite.key);
	};

	const handleRefresh = () => {
		setRefreshes((n) => n + 1);
		void refresh();
	};

	const owner = standing === 'owner';
	return (
		<Section title="Devices and nodes">
			{(standing === 'member' || standing === 'unreadable') && <Text style={controlStyles.hint}>{standingLine(standing, 'remove machines')}</Text>}
			{listError && <Text style={controlStyles.slowHint}>Could not read the cadre&apos;s machines: {listError}</Text>}
			{listing.machines.map((machine) => (
				<MachineRow
					key={machine.peerId}
					machine={machine}
					rentedFrom={rentedFromText(machine, listing.rentals)}
					nowMs={listing.readAtMs}
					onRemove={owner && !machine.isSelf ? () => removal.request(machine) : undefined}
					selfLine={owner && machine.isSelf}
					busy={removal.busy}
				/>
			))}
			{listing.pending.map((status) => (
				<PendingRow key={status.invite.key} status={status} onWithdraw={owner ? () => setWithdrawing(status) : undefined} />
			))}
			<Btn label="Refresh" onPress={handleRefresh} color="#444" testID={TEST_IDS.settings.refreshMachinesBtn} />
			{removal.prompt}
			<WithdrawPrompt open={withdrawing !== null} onConfirm={handleConfirmWithdraw} onCancel={() => setWithdrawing(null)} />
		</Section>
	);
}

/** The rental records, or none, logged: the "Rented from" fact must not keep the machine list from showing. */
async function readRentalsQuietly(listRentals: () => Promise<Rental[]>): Promise<Rental[]> {
	try {
		return await listRentals();
	} catch (err) {
		console.warn('[settings] could not read this phone\'s rentals:', err);
		return [];
	}
}

function MachineRow({ machine, rentedFrom, nowMs, onRemove, selfLine, busy }: {
	machine: CadreMachine;
	/** "Rented from ‹provider›" when this phone rented the node, else null. */
	rentedFrom: string | null;
	nowMs: number;
	/** Absent where nothing may be removed: this device, or a member's view. */
	onRemove?: () => void;
	/** Say how this device is removed, under its row in an owner's view. */
	selfLine: boolean;
	busy: boolean;
}) {
	const facts = [rentedFrom, `Last seen ${lastSeenText(machine.lastPublishedAt, nowMs)}`, `Key ${machineCode(machine)}`];
	return (
		<View testID={TEST_IDS.settings.machineRow(machine.peerId)}>
			<View style={controlStyles.listRow}>
				<View style={controlStyles.listRowText}>
					<Text style={controlStyles.listRowTitle}>{machine.isSelf ? `${machineKind(machine)} (this device)` : machineKind(machine)}</Text>
					<Text style={controlStyles.listRowMeta}>{facts.filter((fact) => fact !== null).join(' · ')}</Text>
					{/* `trusted` is always false for this device: the membership predicate it reads excludes self. */}
					{!machine.isSelf && !machine.trusted && <Text style={controlStyles.slowHint}>Not trusted here</Text>}
				</View>
				{onRemove && (
					<View style={controlStyles.listRowBtn}>
						<Btn label="Remove" onPress={onRemove} disabled={busy} color="#444" testID={TEST_IDS.settings.removeMachineBtn(machine.peerId)} />
					</View>
				)}
			</View>
			{selfLine && <Text style={controlStyles.hint}>{SELF_LINE}</Text>}
		</View>
	);
}

function PendingRow({ status, onWithdraw }: { status: CadreInviteStatus; onWithdraw?: () => void }) {
	const { invite } = status;
	return (
		<View style={controlStyles.listRow}>
			<View style={controlStyles.listRowText}>
				<Text style={controlStyles.listRowTitle}>Invited, not joined yet</Text>
				<Text style={controlStyles.listRowMeta}>
					{shortPeerId(invite.peerId ?? '')} · {invite.grantsOwner ? 'owner' : 'member'} · {validUntilText(parseNullableStoredDatetimeMs(invite.expiresAt))}
				</Text>
			</View>
			{onWithdraw && (
				<View style={controlStyles.listRowBtn}>
					<Btn label="Withdraw" onPress={onWithdraw} color="#444" testID={TEST_IDS.settings.withdrawInvitationBtn(invite.key)} />
				</View>
			)}
		</View>
	);
}
