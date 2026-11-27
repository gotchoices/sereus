/**
 * Example (React Native): a person's cadrons. Copy and adapt; it is not built or published.
 *
 * - Each cadron with a status dot (`cadronPresence`), the person's name for it, a star to name it
 *   first in invitations, and removal.
 * - Adding a cadron by its node code: read it, show what it says, claim only after the person
 *   approves (a code can arrive from anyone).
 * - How many addresses an invitation names.
 *
 * `client` is `createCadreClient(...)` from `@serfab/cadre-client/sereus`. Strings are inline
 * English; an app maps each error `kind` to its own catalog instead of showing `message`.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import {
	cadreStore,
	cadronPresence,
	MAX_BOOTSTRAP_ADDRS,
	shortPeerId,
	type CadreMachine,
	type CadronPresence,
	type CadronPreferences,
} from '@serfab/cadre-client';
import type { CadreClient } from '@serfab/cadre-client/sereus';
import { useStore } from './useStore';

const DOT: Record<CadronPresence, string> = { connected: '#2c8a3f', recent: '#c98a00', quiet: '#888888', unknown: '#dddddd' };
const PRESENCE: Record<CadronPresence, string> = {
	connected: 'Connected',
	recent: 'Running',
	quiet: 'Not heard from lately',
	unknown: 'Not heard from yet',
};

export function CadronList({ client }: { client: CadreClient }) {
	// One store per client: create it once, not on every render.
	const store = useMemo(() => cadreStore(client), [client]);
	const load = useStore(store);
	const prefs = usePreferences(client);

	if (load.state === 'loading') return <Text>Loading…</Text>;
	if (load.state === 'failed') return <Text onPress={() => store.reload()}>{load.error.message} — tap to retry</Text>;
	const status = load.value;

	const toggleStar = (m: CadreMachine) => {
		if (!prefs) return;
		const preferred = prefs.preferred.includes(m.peerId)
			? prefs.preferred.filter(id => id !== m.peerId)
			: [...prefs.preferred, m.peerId];
		void client.invitations.setPreferences({ preferred });
	};
	const remove = (m: CadreMachine) => Alert.alert('Remove this machine?', 'It will no longer act for you.', [
		{ text: 'Cancel', style: 'cancel' },
		{ text: 'Remove', style: 'destructive', onPress: () => { void client.cadre.removeMachine(m.peerId); } },
	]);

	return (
		<View style={styles.list}>
			<Text style={styles.header}>{status.running ? 'Running' : 'Not running'} · {status.machines.length} machine(s)</Text>
			{status.machines.map(m => {
				const presence = cadronPresence(m);
				return (
					<View key={m.peerId} style={styles.row}>
						<View style={[styles.dot, { backgroundColor: DOT[presence] }]} />
						<View style={styles.grow}>
							<Text style={styles.title}>{m.thisDevice ? 'This device' : m.name || `Machine ${shortPeerId(m.peerId)}`}</Text>
							{!m.thisDevice && (
								<Text style={styles.subtitle}>
									{[PRESENCE[presence], m.alwaysOn ? 'Always on' : null, m.preferred ? 'Preferred' : null].filter(Boolean).join(' · ')}
								</Text>
							)}
						</View>
						{!m.thisDevice && <Pressable onPress={() => toggleStar(m)}><Text>{m.preferred ? '★' : '☆'}</Text></Pressable>}
						{!m.thisDevice && <Pressable onPress={() => remove(m)}><Text style={styles.danger}>Remove</Text></Pressable>}
					</View>
				);
			})}
			<AddCadron client={client} disabled={!status.ownerEnrolled} />
			{prefs && <AddressCount client={client} prefs={prefs} />}
		</View>
	);
}

/** The cadron preferences, kept fresh: names and stars show in the list, the count below it. */
function usePreferences(client: CadreClient): CadronPreferences | null {
	const [prefs, setPrefs] = useState<CadronPreferences | null>(null);
	useEffect(() => {
		const read = () => { void client.invitations.preferences().then(setPrefs); };
		read();
		return client.changes.invitations(read);
	}, [client]);
	return prefs;
}

/** Paste a node code, see what it says, approve, claim. A scanner would hand its text to `review` the same way. */
function AddCadron({ client, disabled }: { client: CadreClient; disabled: boolean }) {
	const [code, setCode] = useState('');
	const [busy, setBusy] = useState(false);
	const review = async () => {
		const preview = await client.cadre.inspectNodeCode(code);
		if (!preview.ok) { Alert.alert('That code cannot be used', preview.error.message); return; }
		const where = preview.value.reach === 'home-network'
			? 'It can only be reached on its own network: be on the same Wi-Fi as it.'
			: 'It can be reached from anywhere.';
		Alert.alert('Add this machine?', `Machine ${shortPeerId(preview.value.peerId)} will join your network.\n\n${where}`, [
			{ text: 'Cancel', style: 'cancel' },
			{
				text: 'Add',
				onPress: async () => {
					setBusy(true);
					const claimed = await client.cadre.claimNode(code); // can take up to two minutes
					setBusy(false);
					if (claimed.ok) setCode('');
					else Alert.alert('Could not add the machine', claimed.error.message); // kinds: node-unreachable, claim-refused, claim-failed
				},
			},
		]);
	};
	return (
		<View style={styles.row}>
			<TextInput style={[styles.input, styles.grow]} placeholder="sereus-join:…" value={code} onChangeText={setCode}
				autoCapitalize="none" autoCorrect={false} editable={!busy && !disabled} />
			<Pressable onPress={review} disabled={busy || disabled || !code.trim()}><Text>{busy ? 'Adding…' : 'Add'}</Text></Pressable>
		</View>
	);
}

function AddressCount({ client, prefs }: { client: CadreClient; prefs: CadronPreferences }) {
	const set = (maxAddrs: number) => { void client.invitations.setPreferences({ maxAddrs }); };
	return (
		<View style={styles.row}>
			<Text style={styles.grow}>Addresses per invitation (fewer: a shorter link, a simpler QR code)</Text>
			<Pressable onPress={() => set(prefs.maxAddrs - 1)} disabled={prefs.maxAddrs <= 1}><Text>−</Text></Pressable>
			<Text>{prefs.maxAddrs}</Text>
			<Pressable onPress={() => set(prefs.maxAddrs + 1)} disabled={prefs.maxAddrs >= MAX_BOOTSTRAP_ADDRS}><Text>+</Text></Pressable>
		</View>
	);
}

const styles = StyleSheet.create({
	list: { gap: 8, padding: 16 },
	header: { fontWeight: '600' },
	row: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 6 },
	dot: { width: 8, height: 8, borderRadius: 4 },
	grow: { flex: 1 },
	title: { fontSize: 15 },
	subtitle: { fontSize: 12, color: '#666666' },
	danger: { color: '#c4392f' },
	input: { borderWidth: 1, borderColor: '#dddddd', borderRadius: 6, padding: 8 },
});
