/**
 * settings-controls.tsx — the controls and styles the Settings screen and its sections
 * share. Here rather than in `app/settings.tsx` because every file under `app/` is a route.
 */

import { useEffect, useState } from 'react';
import { Modal, Pressable, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import { TEST_IDS } from './test-ids';

// Defined in `machines.ts`, which has no React import, so the Node-run modules can shorten a peer id too.
export { shortPeerId } from './machines';

const OWNER_SWITCH_LINE = 'An owner can add and remove devices and apps and approve everything in this cadre. Turn this off for an app that should only take part.';

export function Section({ title, children }: { title: string; children: React.ReactNode }) {
	return (
		<View style={controlStyles.section}>
			<Text style={controlStyles.sectionTitle}>{title}</Text>
			{children}
		</View>
	);
}

export function LabelledInput(props: { label: string; value: string; onChangeText: (t: string) => void; placeholder?: string; multiline?: boolean; testID?: string }) {
	return (
		<View style={{ marginBottom: 8 }}>
			<Text style={controlStyles.label}>{props.label}</Text>
			{/*
				Every field on this screen takes an identifier, an address or a code —
				never prose. RN's defaults (`autoCapitalize="sentences"`, autocorrect on)
				would upper-case the first character and offer word substitutions, which
				silently turns a pasted code into one that no longer decodes. Off for all of them.
			*/}
			<TextInput style={controlStyles.input} value={props.value} onChangeText={props.onChangeText} placeholder={props.placeholder} placeholderTextColor="#666" multiline={props.multiline} autoCapitalize="none" autoCorrect={false} testID={props.testID} />
		</View>
	);
}

export function Btn({ label, onPress, disabled, color, testID }: { label: string; onPress: () => void; disabled?: boolean; color?: string; testID?: string }) {
	return (
		<Pressable style={[controlStyles.btn, { backgroundColor: color ?? '#6c63ff' }, disabled && controlStyles.btnDisabled]} onPress={onPress} disabled={disabled} testID={testID}>
			<Text style={controlStyles.btnText}>{label}</Text>
		</Pressable>
	);
}

/** One labelled value in an approval prompt, selectable, with an optional note under it. */
export function Fact({ label, value, note }: { label: string; value: string; note?: string }) {
	return (
		<View style={controlStyles.fact}>
			<Text style={controlStyles.label}>{label}</Text>
			<Text style={controlStyles.factValue} selectable>{value}</Text>
			{note ? <Text style={controlStyles.factNote}>{note}</Text> : null}
		</View>
	);
}

/** "Also an owner", for what an invitation grants. `explained`: show what an owner can do under it; off where the prompt says it above. */
export function OwnerSwitch({ value, onChange, testID, explained = true }: { value: boolean; onChange: (value: boolean) => void; testID: string; explained?: boolean }) {
	return (
		<View>
			<View style={controlStyles.switchRow}>
				<Text style={controlStyles.switchLabel}>Also an owner</Text>
				<Switch value={value} onValueChange={onChange} testID={testID} />
			</View>
			{explained && <Text style={controlStyles.hint}>{OWNER_SWITCH_LINE}</Text>}
		</View>
	);
}

/** A yes-or-no confirmation before something that cannot be undone; the system back button cancels. */
export function ConfirmPrompt({ open, title, text, confirmLabel, onConfirm, onCancel, confirmTestID, cancelTestID }: {
	open: boolean;
	title: string;
	text: string;
	confirmLabel: string;
	onConfirm: () => void;
	onCancel: () => void;
	confirmTestID: string;
	cancelTestID: string;
}) {
	return (
		<Modal visible={open} transparent animationType="fade" onRequestClose={onCancel}>
			<View style={controlStyles.modalOverlay}>
				<View style={controlStyles.modalBox}>
					<Text style={controlStyles.modalTitle}>{title}</Text>
					<Text style={controlStyles.promptText}>{text}</Text>
					<Btn label={confirmLabel} onPress={onConfirm} color="#f44336" testID={confirmTestID} />
					<Btn label="Cancel" onPress={onCancel} color="#444" testID={cancelTestID} />
				</View>
			</View>
		</Modal>
	);
}

/** The confirmation before a cadre invitation is withdrawn. */
export function WithdrawPrompt({ open, onConfirm, onCancel }: { open: boolean; onConfirm: () => void; onCancel: () => void }) {
	return (
		<ConfirmPrompt
			open={open}
			title="Withdraw this invitation?"
			text="Nobody can join with it afterwards."
			confirmLabel="Withdraw"
			onConfirm={onConfirm}
			onCancel={onCancel}
			confirmTestID={TEST_IDS.settings.confirmWithdrawBtn}
			cancelTestID={TEST_IDS.settings.cancelWithdrawBtn}
		/>
	);
}

/** True once `active` has stayed true for `ms`; false again as soon as it is not. For a slow hint under a progress line. */
export function useLaterThan(active: boolean, ms: number): boolean {
	const [late, setLate] = useState(false);
	useEffect(() => {
		setLate(false);
		if (!active) return;
		const timer = setTimeout(() => setLate(true), ms);
		return () => clearTimeout(timer);
	}, [active, ms]);
	return late;
}

/** What an alert shows for a caught error. */
export function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/** "Valid until 14:32", with the weekday when that is not today, in the phone's own time zone. */
export function validUntilText(expiresAtMs: number | null): string {
	if (expiresAtMs === null) return 'No expiry';
	const at = new Date(expiresAtMs);
	const time = at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
	if (at.toDateString() === new Date().toDateString()) return `Valid until ${time}`;
	return `Valid until ${at.toLocaleDateString([], { weekday: 'short' })} ${time}`;
}

export const controlStyles = StyleSheet.create({
	section: { marginBottom: 24 },
	sectionTitle: { color: '#6c63ff', fontSize: 16, fontWeight: '700', marginBottom: 12 },
	subTitle: { color: '#fff', fontSize: 14, fontWeight: '600', marginTop: 12, marginBottom: 6 },
	label: { color: '#aaa', fontSize: 13, marginBottom: 4 },
	hint: { color: '#888', fontSize: 12, lineHeight: 17, marginBottom: 10 },
	slowHint: { color: '#ff9800', fontSize: 12, lineHeight: 17, marginTop: 6 },
	input: { backgroundColor: '#2a2a3e', color: '#fff', borderRadius: 8, paddingHorizontal: 12, paddingVertical: 8, fontSize: 14 },
	btn: { borderRadius: 8, paddingVertical: 10, alignItems: 'center', marginTop: 8 },
	btnDisabled: { opacity: 0.4 },
	btnText: { color: '#fff', fontWeight: '600', fontSize: 14 },
	modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'center', alignItems: 'center' },
	modalBox: { backgroundColor: '#1e1e2e', borderRadius: 12, padding: 20, width: '85%', maxHeight: '60%' },
	modalTitle: { color: '#fff', fontSize: 16, fontWeight: '700', marginBottom: 12 },
	promptText: { color: '#ccc', fontSize: 14, lineHeight: 20, marginBottom: 8 },
	fact: { marginBottom: 10 },
	factValue: { color: '#fff', fontSize: 14 },
	factNote: { color: '#888', fontSize: 12, marginTop: 2 },
	switchRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 },
	switchLabel: { color: '#fff', fontSize: 14 },
	/** A listed item with its two lines of text on the left and one button on the right. */
	listRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 6 },
	listRowText: { flex: 1 },
	listRowTitle: { color: '#fff', fontSize: 13 },
	listRowMeta: { color: '#888', fontSize: 12, marginTop: 2 },
	listRowBtn: { width: 110 },
});
