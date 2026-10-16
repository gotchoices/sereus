/**
 * machine-removal.tsx — removing a machine from the cadre, as Settings → "Devices and nodes"
 * does it and as "Rent an always-on node" does for a node its provider stopped: read
 * `planMachineRemoval`, confirm, then `removeMachine` (docs/architecture.md → "Removing a
 * machine"). Owner keys are not machines and stay; removing one is a separate step under Owner keys
 * (`owner-keys-section.tsx`), which the prompt offers for a lost or stolen phone.
 */

import { useRef, useState } from 'react';
import { Modal, ScrollView, Text, View } from 'react-native';
import {
	MachineRemovalRefusedError,
	type CadreMachine,
	type MachineRemovalPlan,
	type MachineRemovalRefusal,
} from '@serfab/cadre-core';
import { useCadre } from './cadre-context';
import { machineCode, machineKind, machineName } from './machines';
import { Btn, controlStyles, errorMessage, Fact, useExclusive } from './settings-controls';
import { TEST_IDS } from './test-ids';

/** Under this device's own row: a device does not remove itself (`self`); leaving a cadre stops the node and deletes its data. */
export const SELF_LINE = 'A device does not remove itself from its cadre: to remove this device, use another owner device.';
const KEEPS_LINE = 'It keeps whatever it already copied, including the cadre\'s shared data. Removing it stops it syncing with this cadre\'s machines.';
/** Removing a machine leaves its owner key live; only removing the key locks a lost phone out. */
const LOST_DEVICE_LINE = 'If this was a lost or stolen phone that held an owner key, remove that key too in Owner keys; otherwise whoever has the phone can still act as an owner.';

/** Why a removal cannot go ahead: in the prompt from the plan, and in the alert when `removeMachine` refuses. */
const REFUSAL_LINE: Record<MachineRemovalRefusal, string> = {
	'not-an-owner': 'Only an owner can remove machines, and this device is not one.',
	self: SELF_LINE,
};

type ShowAlert = (title: string, message: string, detail?: string) => void;

/** The removal the confirmation prompt is for. */
interface PendingRemoval {
	machine: CadreMachine;
	plan: MachineRemovalPlan;
}

export interface MachineRemoval {
	/** Read what removing `machine` would do and open the confirmation. Ignored while another plan read or removal runs. */
	request: (machine: CadreMachine) => void;
	/** A plan read or a removal is running. */
	busy: boolean;
	/** The confirmation, for the section to render. */
	prompt: React.ReactElement;
}

/**
 * The removal flow for one section. `onRemoved` runs after the machine is removed, and when the
 * plan or the removal finds another owner removed it already, so the section re-reads its list.
 * `onShowOwnerKeys`, given where Settings can take the user to Owner keys, adds the lost-phone line
 * and a button that closes the prompt and goes there; a rented node never holds an owner key.
 */
export function useMachineRemoval({ showAlert, onRemoved, onShowOwnerKeys }: {
	showAlert: ShowAlert;
	onRemoved: (machine: CadreMachine) => void;
	onShowOwnerKeys?: () => void;
}): MachineRemoval {
	const cadre = useCadre();
	const [confirming, setConfirming] = useState<PendingRemoval | null>(null);
	// A plan read or a removal, one at a time.
	const { busy, exclusive } = useExclusive();
	// The node now, so a plan that arrives after a join or a stop replaced it is dropped.
	const nodeRef = useRef(cadre.node);
	nodeRef.current = cadre.node;

	const request = (machine: CadreMachine) => void exclusive(async () => {
		const node = nodeRef.current;
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
			onRemoved(machine);
			return;
		}
		setConfirming({ machine: plan.machine, plan });
	});

	const remove = async ({ machine }: PendingRemoval) => {
		try {
			const result = await cadre.removeMachine(machine.peerId);
			if (!result.removedPeer) {
				showAlert('Already removed', `${machineName(machine)} is no longer in this cadre.`);
			} else {
				console.info(`[settings] removed machine ${machine.peerId} (invitations withdrawn ${result.withdrawnInvitations.length})`);
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

	const handleShowOwnerKeys = onShowOwnerKeys && (() => {
		setConfirming(null);
		onShowOwnerKeys();
	});

	const prompt = (
		<RemovePrompt
			removal={confirming}
			onConfirm={handleConfirm}
			onCancel={() => setConfirming(null)}
			onShowOwnerKeys={handleShowOwnerKeys}
		/>
	);
	return { request, busy, prompt };
}

/**
 * What the removal does and does not do, read from the plan. A refused removal shows why and only
 * Close. The system back button cancels.
 */
function RemovePrompt({ removal, onConfirm, onCancel, onShowOwnerKeys }: {
	removal: PendingRemoval | null;
	onConfirm: () => void;
	onCancel: () => void;
	onShowOwnerKeys?: () => void;
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
						{removal && refusal === null && <RemovalDetails plan={removal.plan} onShowOwnerKeys={onShowOwnerKeys} />}
					</ScrollView>
					{refusal === null && <Btn label="Remove" onPress={onConfirm} color="#f44336" testID={TEST_IDS.settings.confirmRemoveMachineBtn} />}
					<Btn label={refusal === null ? 'Cancel' : 'Close'} onPress={onCancel} color="#444" testID={TEST_IDS.settings.cancelRemoveMachineBtn} />
				</View>
			</View>
		</Modal>
	);
}

function RemovalDetails({ plan, onShowOwnerKeys }: { plan: MachineRemovalPlan; onShowOwnerKeys?: () => void }) {
	return (
		<>
			<Text style={controlStyles.promptText}>{removalEffects(plan)}</Text>
			<Text style={[controlStyles.hint, { marginTop: 8 }]}>{KEEPS_LINE}</Text>
			{onShowOwnerKeys && (
				<>
					<Text style={controlStyles.slowHint}>{LOST_DEVICE_LINE}</Text>
					<Btn label="Go to Owner keys" onPress={onShowOwnerKeys} color="#444" testID={TEST_IDS.settings.showOwnerKeysBtn} />
				</>
			)}
		</>
	);
}

/** "It is removed from this cadre. The 2 invitations it could join again with are withdrawn." */
function removalEffects(plan: MachineRemovalPlan): string {
	const count = plan.invitations.length;
	return [
		'It is removed from this cadre.',
		count === 1 ? 'The invitation it could join again with is withdrawn.' : null,
		count > 1 ? `The ${count} invitations it could join again with are withdrawn.` : null,
	].filter((line) => line !== null).join(' ');
}
