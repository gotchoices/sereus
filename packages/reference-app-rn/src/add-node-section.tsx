/**
 * add-node-section.tsx — Settings → "Add an always-on node": claim a node a machine
 * running cadre-host shows a code for, by scanning that code or pasting its text.
 *
 * A code goes through `readNodeCode`, then an approval prompt naming the cadre the node
 * will join, then `claimHostNode`. Success means the node accepted the claim, not that a
 * connection is open: the node restarts itself right after accepting, and this phone's
 * next reconcile pass reconnects to it (the Settings connection rows show when).
 *
 * The decoded code carries the node's claim secret: log the peer id only.
 */

import { useEffect, useState } from 'react';
import { Modal, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { NodeClaimPayload } from '@serfab/cadre-core';
import { useCadre } from './cadre-context';
import { describeClaimFailure, nodeReach, ownerFingerprint, readNodeCode, type NodeReach } from './node-claim';
import { NodeCodeScanner } from './node-code-scanner';
import { Btn, controlStyles, LabelledInput, Section } from './settings-controls';
import { TEST_IDS } from './test-ids';

/**
 * When the progress line adds that some addresses are not answering. A dead address costs
 * up to 21.5 s before the next is tried, so a claim still running at 20 s is almost always
 * waiting one out.
 */
const CLAIM_SLOW_HINT_MS = 20_000;

const REACH_TEXT: Record<NodeReach, string> = {
	anywhere: 'Reachable from anywhere',
	'home-network': 'Reachable only on the machine\'s home network: this phone must be on the same Wi-Fi',
};

type ShowAlert = (title: string, message: string, detail?: string) => void;

// NOTE: screen state. The tab navigator (app/_layout.tsx) keeps Settings mounted, so a
// running claim's progress and a kept code survive a tab switch. If Settings is ever
// unmounted on blur, the claim would run on in the hook with nothing showing it; move
// this state into the cadre context then.
export function AddNodeSection({ showAlert }: { showAlert: ShowAlert }) {
	const cadre = useCadre();
	const [codeText, setCodeText] = useState('');
	const [scannerOpen, setScannerOpen] = useState(false);
	// A read code waiting for the user's approval; the prompt shows while it is set.
	const [pending, setPending] = useState<NodeClaimPayload | null>(null);
	// A code whose claim failed in a way the same code may fix, for Try again.
	const [kept, setKept] = useState<NodeClaimPayload | null>(null);
	const [claiming, setClaiming] = useState(false);
	const slow = useLaterThan(claiming, CLAIM_SLOW_HINT_MS);

	const handleCode = async (text: string) => {
		const reading = readNodeCode(text);
		if (!reading.ok) {
			showAlert('Cannot use this code', reading.message, reading.detail);
			return;
		}
		try {
			if (!await cadre.isOwnerDevice()) {
				showAlert('Only an owner can add a node', 'This device is a member of this cadre, not an owner. Scan the code from a device that owns the cadre.');
				return;
			}
		} catch (err) {
			console.warn('[settings] could not read this cadre\'s owner keys:', err);
			showAlert('Cannot add a node right now', 'Could not check whether this device owns the cadre. Try again.', String(err));
			return;
		}
		setPending(reading.payload);
	};

	// NOTE: the scanner closes and the approval prompt (or an alert) opens in the same
	// moment. If a device run shows iOS dropping a Modal asked to open while another is
	// still animating closed, open the prompt from the scanner Modal's `onDismiss` instead.
	const handleScanned = (text: string) => {
		setScannerOpen(false);
		void handleCode(text);
	};

	const runClaim = async (payload: NodeClaimPayload) => {
		setKept(null);
		setClaiming(true);
		console.info(`[settings] adding node ${payload.peerId}`);
		try {
			await cadre.claimHostNode(payload);
			setCodeText('');
			showAlert('Node added', `Node ${payload.peerId}.\n\nThe machine restarts the node once to switch to this cadre; it then connects by itself.`);
		} catch (err) {
			console.warn(`[settings] adding node ${payload.peerId} failed:`, err);
			const failure = describeClaimFailure(err, payload);
			if (failure.canRetrySameCode) setKept(payload);
			showAlert('Adding the node failed', failure.message, failure.detail);
		} finally {
			setClaiming(false);
		}
	};

	const handleApprove = () => {
		const payload = pending;
		setPending(null);
		if (payload) void runClaim(payload);
	};

	return (
		<Section title="Add an always-on node">
			<Text style={controlStyles.hint}>
				A machine running cadre-host shows a code when you choose Join a cadre. Scan it, or paste its text.
			</Text>
			<Btn label="Scan code" onPress={() => setScannerOpen(true)} disabled={claiming} testID={TEST_IDS.settings.scanNodeCodeBtn} />
			<LabelledInput label="Paste node code" value={codeText} onChangeText={setCodeText} placeholder="sereus-join:1.…" multiline testID={TEST_IDS.settings.nodeCodeInput} />
			<Btn label="Use code" onPress={() => void handleCode(codeText)} disabled={claiming || !codeText.trim()} testID={TEST_IDS.settings.useNodeCodeBtn} />
			{claiming && (
				<Text style={controlStyles.slowHint} testID={TEST_IDS.settings.nodeClaimProgress}>
					Reaching the node and adding it to this cadre…
					{slow ? '\nSome of the node\'s addresses are not answering; still trying the others.' : ''}
				</Text>
			)}
			{kept && !claiming && (
				<View style={styles.retryRow}>
					<View style={styles.retryBtn}>
						<Btn label="Try again" onPress={() => void runClaim(kept)} testID={TEST_IDS.settings.retryNodeClaimBtn} />
					</View>
					<View style={styles.retryBtn}>
						<Btn label="Discard" onPress={() => setKept(null)} color="#444" testID={TEST_IDS.settings.discardNodeClaimBtn} />
					</View>
				</View>
			)}
			<NodeCodeScanner visible={scannerOpen} onScanned={handleScanned} onClose={() => setScannerOpen(false)} />
			<ApprovalPrompt
				payload={pending}
				partyId={cadre.node?.partyId ?? '—'}
				ownerPublicKey={cadre.ownerPublicKey}
				onApprove={handleApprove}
				onCancel={() => setPending(null)}
			/>
		</Section>
	);
}

/** Nothing is claimed until the user agrees, because the prompt is where they see which cadre the node joins. */
function ApprovalPrompt({ payload, partyId, ownerPublicKey, onApprove, onCancel }: {
	payload: NodeClaimPayload | null;
	partyId: string;
	ownerPublicKey: string | null;
	onApprove: () => void;
	onCancel: () => void;
}) {
	return (
		<Modal visible={payload !== null} transparent animationType="fade" onRequestClose={onCancel}>
			<View style={controlStyles.modalOverlay}>
				<View style={controlStyles.modalBox}>
					<Text style={controlStyles.modalTitle}>Add this node to your cadre?</Text>
					<ScrollView>
						<Fact label="Cadre" value={partyId} />
						<Fact
							label="Owner"
							value={ownerPublicKey ? ownerFingerprint(ownerPublicKey) : '—'}
							note="The machine shows the same fingerprint once the node joins."
						/>
						<Fact label="Node" value={payload ? shortPeerId(payload.peerId) : ''} />
						<Fact label="Reach" value={payload ? REACH_TEXT[nodeReach(payload.multiaddrs)] : ''} />
					</ScrollView>
					<Btn label="Add to this cadre" onPress={onApprove} testID={TEST_IDS.settings.approveNodeClaimBtn} />
					<Btn label="Cancel" onPress={onCancel} color="#444" testID={TEST_IDS.settings.cancelNodeClaimBtn} />
				</View>
			</View>
		</Modal>
	);
}

function Fact({ label, value, note }: { label: string; value: string; note?: string }) {
	return (
		<View style={styles.fact}>
			<Text style={controlStyles.label}>{label}</Text>
			<Text style={styles.factValue} selectable>{value}</Text>
			{note ? <Text style={styles.factNote}>{note}</Text> : null}
		</View>
	);
}

function shortPeerId(peerId: string): string {
	return `${peerId.slice(0, 12)}…${peerId.slice(-6)}`;
}

/** True once `active` has stayed true for `ms`; false again as soon as it is not. */
function useLaterThan(active: boolean, ms: number): boolean {
	const [late, setLate] = useState(false);
	useEffect(() => {
		setLate(false);
		if (!active) return;
		const timer = setTimeout(() => setLate(true), ms);
		return () => clearTimeout(timer);
	}, [active, ms]);
	return late;
}

const styles = StyleSheet.create({
	retryRow: { flexDirection: 'row', gap: 8 },
	retryBtn: { flex: 1 },
	fact: { marginBottom: 10 },
	factValue: { color: '#fff', fontSize: 14 },
	factNote: { color: '#888', fontSize: 12, marginTop: 2 },
});
