/**
 * machines-section.tsx — Settings → "Devices and nodes": every machine of this cadre (apps,
 * always-on nodes, owner keys no machine has joined with) and the devices invited and not joined
 * yet, and on an owner device, Remove (`CadreNode.removeMachine`; docs/architecture.md →
 * "Removing a machine"). A removed machine's owner key goes with it, and the devices and owners
 * that key added stop being trusted unless re-vouched first, so the confirmation lists them with
 * a Keep switch each. The words for a listed machine are `machines.ts`'s.
 */

import { useEffect, useRef, useState } from 'react';
import { Modal, ScrollView, Switch, Text, View } from 'react-native';
import {
	MachineRemovalRefusedError,
	parseNullableStoredDatetimeMs,
	type CadreInviteStatus,
	type CadreMachine,
	type MachineRemovalPlan,
	type MachineRemovalRefusal,
} from '@serfab/cadre-core';
import { useCadre } from './cadre-context';
import { dependentsOf, lastSeenText, machineKind, pendingDeviceInvitations, revouchFor, type Dependent } from './machines';
import { ownerFingerprint } from './node-claim';
import { Btn, controlStyles, Fact, Section, shortPeerId, validUntilText, WithdrawPrompt } from './settings-controls';
import { TEST_IDS } from './test-ids';

const NOT_OWNER_LINE = 'Only an owner of this cadre can remove machines. This app is a member.';
const UNREADABLE_LINE = 'Could not check whether this app is an owner of this cadre, so nothing can be removed from here until Refresh reads it.';
const SELF_LINE = 'To remove this device, use another owner device.';
const DEPENDENTS_LINE = 'A device it added stops being trusted unless you keep it here. Switch off anything you do not recognise.';
const OWN_DEPENDENCY_LINE = 'This device was added by the machine you are removing. After removing it, ask another owner to add this device again.';
const KEEPS_LINE = 'It keeps whatever it already copied, including the cadre\'s shared data. Removing it stops it syncing with this cadre\'s machines.';

/** Why a removal cannot go ahead: in the prompt from the plan, and in the alert when `removeMachine` refuses. */
const REFUSAL_LINE: Record<MachineRemovalRefusal, string> = {
	'not-an-owner': 'Only an owner can remove machines, and this device is not one.',
	self: SELF_LINE,
	'last-owner': 'It cannot be removed: it holds the only owner key of this cadre.',
};

type ShowAlert = (title: string, message: string, detail?: string) => void;

/** Whether this app may remove machines, which only an owner of the cadre can. */
type Standing = 'checking' | 'owner' | 'member' | 'unreadable';

interface Listing {
	machines: CadreMachine[];
	/** Live invitations for one device that has not joined yet. */
	pending: CadreInviteStatus[];
	/** When it was read, for "last seen". */
	readAtMs: number;
}

/** The removal the confirmation prompt is for. */
interface PendingRemoval {
	machine: CadreMachine;
	plan: MachineRemovalPlan;
	dependents: Dependent[];
}

// NOTE: screen state, as in AddDeviceSection: the tab navigator keeps Settings mounted. The
// section unmounts with the connected view, so a prompt open when this phone is itself removed
// closes with it.
export function MachinesSection({ showAlert, refreshKey }: {
	showAlert: ShowAlert;
	/** Bumped by Add a device or app after it makes or withdraws an invitation. */
	refreshKey: number;
}) {
	const cadre = useCadre();
	const [standing, setStanding] = useState<Standing>('checking');
	const [listing, setListing] = useState<Listing>({ machines: [], pending: [], readAtMs: 0 });
	const [listError, setListError] = useState<string | null>(null);
	const [confirming, setConfirming] = useState<PendingRemoval | null>(null);
	// Dependents whose Keep switch is on, by `Dependent.id`.
	const [kept, setKept] = useState<ReadonlySet<string>>(new Set());
	const [busy, setBusy] = useState(false);
	// Catches the same-frame double tap that `disabled` cannot: the prop only takes effect after
	// the re-render `setBusy` schedules.
	const busyRef = useRef(false);
	const [withdrawing, setWithdrawing] = useState<CadreInviteStatus | null>(null);
	// The node now, so a read that finishes after a join or a stop replaced it is dropped.
	const nodeRef = useRef(cadre.node);
	nodeRef.current = cadre.node;

	const refresh = async () => {
		const node = cadre.node;
		const stale = () => nodeRef.current !== node;
		try {
			const owner = await cadre.isOwnerDevice();
			if (!stale()) setStanding(owner ? 'owner' : 'member');
		} catch (err) {
			console.warn('[settings] could not read this cadre\'s owner keys:', err);
			if (!stale()) setStanding('unreadable');
		}
		try {
			const machines = await cadre.listMachines();
			const invitations = await cadre.listCadreInvitations();
			if (stale()) return;
			setListing({ machines, pending: pendingDeviceInvitations(invitations, machines), readAtMs: Date.now() });
			setListError(null);
		} catch (err) {
			console.warn('[settings] could not read this cadre\'s machines:', err);
			if (!stale()) setListError(errorMessage(err));
		}
	};

	// A join replaces the node, and the owner standing may change with it.
	useEffect(() => {
		void refresh();
	}, [cadre.node, refreshKey]);

	/** Run `action` unless another is running: a plan read or a removal, one at a time. */
	const exclusive = async (action: () => Promise<void>): Promise<void> => {
		if (busyRef.current) return;
		busyRef.current = true;
		setBusy(true);
		try {
			await action();
		} finally {
			busyRef.current = false;
			setBusy(false);
		}
	};

	const handleRemove = (machine: CadreMachine) => void exclusive(async () => {
		const node = cadre.node;
		let plan: MachineRemovalPlan;
		try {
			plan = await cadre.planMachineRemoval(machine.peerId);
		} catch (err) {
			console.warn(`[settings] could not read what removing ${machine.peerId} would do:`, err);
			showAlert('Could not prepare the removal', errorMessage(err));
			return;
		}
		if (nodeRef.current !== node) return;
		if (plan.machine === null) {
			showAlert('Already removed', `${machineName(machine)} is no longer in this cadre.`);
			void refresh();
			return;
		}
		const dependents = dependentsOf(plan, listing.machines);
		setKept(new Set(dependents.map((dependent) => dependent.id)));
		setConfirming({ machine: plan.machine, plan, dependents });
	});

	const handleConfirmRemove = () => {
		const removal = confirming;
		setConfirming(null);
		if (!removal) return;
		void exclusive(async () => {
			await remove(removal);
			await refresh();
		});
	};

	const remove = async ({ machine, dependents }: PendingRemoval) => {
		try {
			const result = await cadre.removeMachine(machine.peerId, { revouch: revouchFor(dependents, kept) });
			if (!result.removedPeer && !result.removedOwnerKey) {
				showAlert('Already removed', `${machineName(machine)} is no longer in this cadre.`);
				return;
			}
			console.info(`[settings] removed machine ${machine.peerId} (owner key ${result.removedOwnerKey}, invitations withdrawn ${result.withdrawnInvitations.length}, kept ${result.revouched.peers.length} devices and ${result.revouched.owners.length} owner keys)`);
		} catch (err) {
			console.warn(`[settings] removing machine ${machine.peerId} failed:`, err);
			if (err instanceof MachineRemovalRefusedError) showAlert('Could not remove it', REFUSAL_LINE[err.code]);
			else showAlert('Could not remove it', errorMessage(err));
		}
	};

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

	const setKeep = (id: string, keep: boolean) => {
		const next = new Set(kept);
		if (keep) next.add(id);
		else next.delete(id);
		setKept(next);
	};

	const owner = standing === 'owner';
	return (
		<Section title="Devices and nodes">
			{standing === 'member' && <Text style={controlStyles.hint}>{NOT_OWNER_LINE}</Text>}
			{standing === 'unreadable' && <Text style={controlStyles.hint}>{UNREADABLE_LINE}</Text>}
			{listError && <Text style={controlStyles.slowHint}>Could not read the cadre&apos;s machines: {listError}</Text>}
			{listing.machines.map((machine) => (
				<MachineRow
					key={machine.peerId}
					machine={machine}
					nowMs={listing.readAtMs}
					onRemove={owner && !machine.isSelf ? () => handleRemove(machine) : undefined}
					selfLine={owner && machine.isSelf}
					busy={busy}
				/>
			))}
			{listing.pending.map((status) => (
				<PendingRow key={status.invite.key} status={status} onWithdraw={owner ? () => setWithdrawing(status) : undefined} />
			))}
			<Btn label="Refresh" onPress={() => void refresh()} color="#444" testID={TEST_IDS.settings.refreshMachinesBtn} />
			<RemovePrompt
				removal={confirming}
				kept={kept}
				onKeepChange={setKeep}
				onConfirm={handleConfirmRemove}
				onCancel={() => setConfirming(null)}
			/>
			<WithdrawPrompt open={withdrawing !== null} onConfirm={handleConfirmWithdraw} onCancel={() => setWithdrawing(null)} />
		</Section>
	);
}

function MachineRow({ machine, nowMs, onRemove, selfLine, busy }: {
	machine: CadreMachine;
	nowMs: number;
	/** Absent where nothing may be removed: this device, or a member's view. */
	onRemove?: () => void;
	/** Say how this device is removed, under its row in an owner's view. */
	selfLine: boolean;
	busy: boolean;
}) {
	const facts = machine.isMember
		? [machine.isOwner ? 'Owner' : null, `Last seen ${lastSeenText(machine.lastPublishedAt, nowMs)}`, `Key ${machineCode(machine)}`]
		: ['Owner key, no machine joined', `Key ${machineCode(machine)}`];
	return (
		<View testID={TEST_IDS.settings.machineRow(machine.peerId)}>
			<View style={controlStyles.listRow}>
				<View style={controlStyles.listRowText}>
					<Text style={controlStyles.listRowTitle}>{machine.isSelf ? `${machineKind(machine)} (this device)` : machineKind(machine)}</Text>
					<Text style={controlStyles.listRowMeta}>{facts.filter((fact) => fact !== null).join(' · ')}</Text>
					{/* `trusted` is always false for this device: the membership predicate it reads excludes self. */}
					{machine.isMember && !machine.isSelf && !machine.trusted && <Text style={controlStyles.slowHint}>Not trusted here</Text>}
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

/**
 * What the removal does and does not do, read from the plan, with a Keep switch per device or
 * owner the machine added. A refused removal shows why and only Close. The system back button
 * cancels.
 */
function RemovePrompt({ removal, kept, onKeepChange, onConfirm, onCancel }: {
	removal: PendingRemoval | null;
	kept: ReadonlySet<string>;
	onKeepChange: (id: string, keep: boolean) => void;
	onConfirm: () => void;
	onCancel: () => void;
}) {
	const refusal = removal?.plan.refusal ?? null;
	return (
		<Modal visible={removal !== null} transparent animationType="fade" onRequestClose={onCancel}>
			<View style={controlStyles.modalOverlay}>
				<View style={controlStyles.modalBox}>
					<Text style={controlStyles.modalTitle}>{removal ? `Remove this ${machineKind(removal.machine).toLowerCase()}?` : ''}</Text>
					<ScrollView>
						{removal && <Fact label="Key" value={machineCode(removal.machine)} />}
						{refusal !== null && <Text style={controlStyles.promptText}>{REFUSAL_LINE[refusal]}</Text>}
						{removal && refusal === null && <RemovalDetails removal={removal} kept={kept} onKeepChange={onKeepChange} />}
					</ScrollView>
					{refusal === null && <Btn label="Remove" onPress={onConfirm} color="#f44336" testID={TEST_IDS.settings.confirmRemoveMachineBtn} />}
					<Btn label={refusal === null ? 'Cancel' : 'Close'} onPress={onCancel} color="#444" testID={TEST_IDS.settings.cancelRemoveMachineBtn} />
				</View>
			</View>
		</Modal>
	);
}

function RemovalDetails({ removal: { plan, dependents }, kept, onKeepChange }: {
	removal: PendingRemoval;
	kept: ReadonlySet<string>;
	onKeepChange: (id: string, keep: boolean) => void;
}) {
	return (
		<>
			<Text style={controlStyles.promptText}>{removalEffects(plan)}</Text>
			{dependents.length > 0 && (
				<>
					<Text style={controlStyles.subTitle}>Devices and owners this machine added</Text>
					<Text style={controlStyles.hint}>{DEPENDENTS_LINE}</Text>
					{dependents.map((dependent) => (
						<View key={dependent.id} style={controlStyles.switchRow}>
							<Text style={controlStyles.switchLabel}>{`Keep ${dependentName(dependent)}`}</Text>
							<Switch
								value={kept.has(dependent.id)}
								onValueChange={(keep) => onKeepChange(dependent.id, keep)}
								testID={TEST_IDS.settings.keepDependentSwitch(dependent.id)}
							/>
						</View>
					))}
				</>
			)}
			{plan.ownDependency && <Text style={controlStyles.slowHint}>{OWN_DEPENDENCY_LINE}</Text>}
			<Text style={[controlStyles.hint, { marginTop: 8 }]}>{KEEPS_LINE}</Text>
		</>
	);
}

/** "It is removed from this cadre. Its owner key is removed too. 2 invitations it could join again with are withdrawn." */
function removalEffects(plan: MachineRemovalPlan): string {
	const count = plan.invitations.length;
	return [
		'It is removed from this cadre.',
		plan.removesOwnerKey ? 'Its owner key is removed too.' : null,
		count === 1 ? 'The invitation it could join again with is withdrawn.' : null,
		count > 1 ? `The ${count} invitations it could join again with are withdrawn.` : null,
	].filter((line) => line !== null).join(' ');
}

/** The key fingerprint cadre-host shows for an owner, else the shortened peer id. */
function machineCode(machine: CadreMachine): string {
	return machine.publicKey !== null ? ownerFingerprint(machine.publicKey) : shortPeerId(machine.peerId);
}

/** "The always-on node 1a2b3c4d", for an alert. */
function machineName(machine: CadreMachine): string {
	return `The ${machineKind(machine).toLowerCase()} ${machineCode(machine)}`;
}

/** "App 1a2b3c4d (owner)"; an owner key the listing has no machine for is named by its fingerprint. */
function dependentName({ id, machine, peerId, ownerKey }: Dependent): string {
	const owner = ownerKey !== null ? ' (owner)' : '';
	if (machine) return `${machineKind(machine)} ${machineCode(machine)}${owner}`;
	if (peerId !== null) return `Machine ${shortPeerId(peerId)}${owner}`;
	return `Owner key ${ownerFingerprint(id)}`;
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
