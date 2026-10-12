/**
 * machine-removal.tsx — removing a machine from the cadre, as Settings → "Devices and nodes"
 * does it and as "Rent an always-on node" does for a node its provider stopped: read
 * `planMachineRemoval`, confirm with a Keep switch per device or owner the machine added, then
 * `removeMachine` (docs/architecture.md → "Removing a machine"). A removed machine's owner key goes
 * with it, and the devices and owners that key added stop being trusted unless re-vouched first,
 * which is what the switches decide.
 */

import { useRef, useState } from 'react';
import { Modal, ScrollView, Switch, Text, View } from 'react-native';
import {
	MachineRemovalRefusedError,
	type CadreMachine,
	type MachineRemovalPlan,
	type MachineRemovalRefusal,
} from '@serfab/cadre-core';
import { useCadre } from './cadre-context';
import { dependentsOf, machineCode, machineKind, machineName, revouchFor, shortPeerId, type Dependent } from './machines';
import { ownerFingerprint } from './node-claim';
import { Btn, controlStyles, errorMessage, Fact } from './settings-controls';
import { TEST_IDS } from './test-ids';

/** Under this device's own row: a device cannot sign the removal of its own owner key. */
export const SELF_LINE = 'To remove this device, use another owner device.';
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

/** The removal the confirmation prompt is for. */
interface PendingRemoval {
	machine: CadreMachine;
	plan: MachineRemovalPlan;
	dependents: Dependent[];
}

export interface MachineRemoval {
	/**
	 * Read what removing `machine` would do and open the confirmation; `machines` is the listing the
	 * prompt names dependents from. Ignored while another plan read or removal runs.
	 */
	request: (machine: CadreMachine, machines: readonly CadreMachine[]) => void;
	/** A plan read or a removal is running. */
	busy: boolean;
	/** The confirmation, for the section to render. */
	prompt: React.ReactElement;
}

/**
 * The removal flow for one section. `onRemoved` runs after the machine is removed, and when the
 * plan or the removal finds another owner removed it already, so the section re-reads its list.
 */
export function useMachineRemoval({ showAlert, onRemoved }: {
	showAlert: ShowAlert;
	onRemoved: (machine: CadreMachine) => void;
}): MachineRemoval {
	const cadre = useCadre();
	const [confirming, setConfirming] = useState<PendingRemoval | null>(null);
	// Dependents whose Keep switch is on, by `Dependent.id`.
	const [kept, setKept] = useState<ReadonlySet<string>>(new Set());
	const [busy, setBusy] = useState(false);
	// Catches the same-frame double tap that `disabled` cannot: the prop only takes effect after
	// the re-render `setBusy` schedules.
	const busyRef = useRef(false);

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

	const request = (machine: CadreMachine, machines: readonly CadreMachine[]) => void exclusive(async () => {
		// The node now, so a plan that arrives after a join or a stop replaced it is dropped.
		const node = cadre.node;
		let plan: MachineRemovalPlan;
		try {
			plan = await cadre.planMachineRemoval(machine.peerId);
		} catch (err) {
			console.warn(`[settings] could not read what removing ${machine.peerId} would do:`, err);
			showAlert('Could not prepare the removal', errorMessage(err));
			return;
		}
		if (cadre.node !== node) return;
		if (plan.machine === null) {
			showAlert('Already removed', `${machineName(machine)} is no longer in this cadre.`);
			onRemoved(machine);
			return;
		}
		const dependents = dependentsOf(plan, machines);
		setKept(new Set(dependents.map((dependent) => dependent.id)));
		setConfirming({ machine: plan.machine, plan, dependents });
	});

	const remove = async ({ machine, dependents }: PendingRemoval) => {
		try {
			const result = await cadre.removeMachine(machine.peerId, { revouch: revouchFor(dependents, kept) });
			if (!result.removedPeer && !result.removedOwnerKey) {
				showAlert('Already removed', `${machineName(machine)} is no longer in this cadre.`);
			} else {
				console.info(`[settings] removed machine ${machine.peerId} (owner key ${result.removedOwnerKey}, invitations withdrawn ${result.withdrawnInvitations.length}, kept ${result.revouched.peers.length} devices and ${result.revouched.owners.length} owner keys)`);
			}
			onRemoved(machine);
		} catch (err) {
			console.warn(`[settings] removing machine ${machine.peerId} failed:`, err);
			if (err instanceof MachineRemovalRefusedError) showAlert('Could not remove it', REFUSAL_LINE[err.code]);
			else showAlert('Could not remove it', errorMessage(err));
		}
	};

	const handleConfirm = () => {
		const removal = confirming;
		setConfirming(null);
		if (removal) void exclusive(() => remove(removal));
	};

	const setKeep = (id: string, keep: boolean) => {
		const next = new Set(kept);
		if (keep) next.add(id);
		else next.delete(id);
		setKept(next);
	};

	const prompt = (
		<RemovePrompt
			removal={confirming}
			kept={kept}
			onKeepChange={setKeep}
			onConfirm={handleConfirm}
			onCancel={() => setConfirming(null)}
		/>
	);
	return { request, busy, prompt };
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

/** "App 1a2b3c4d (owner)"; an owner key the listing has no machine for is named by its fingerprint. */
function dependentName({ id, machine, peerId, ownerKey }: Dependent): string {
	const owner = ownerKey !== null ? ' (owner)' : '';
	if (machine) return `${machineKind(machine)} ${machineCode(machine)}${owner}`;
	if (peerId !== null) return `Machine ${shortPeerId(peerId)}${owner}`;
	return `Owner key ${ownerFingerprint(id)}`;
}
