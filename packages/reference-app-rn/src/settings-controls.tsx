/**
 * settings-controls.tsx — the controls and styles the Settings screen and its sections
 * share. Here rather than in `app/settings.tsx` because every file under `app/` is a route.
 */

import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

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

export const controlStyles = StyleSheet.create({
	section: { marginBottom: 24 },
	sectionTitle: { color: '#6c63ff', fontSize: 16, fontWeight: '700', marginBottom: 12 },
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
});
