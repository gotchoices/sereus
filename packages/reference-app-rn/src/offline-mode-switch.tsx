/**
 * offline-mode-switch.tsx — Settings → Node's "Offline mode" switch: whether a message is taken as
 * sent once it is queued on this phone, or once the strand's other members hold it
 * (docs/strands.md → "Offline mode").
 */

import { useState } from 'react';
import { Switch, Text, View } from 'react-native';
import { getStrandOfflineMode, setStrandOfflineMode } from './cadre-phone';
import { controlStyles, errorMessage } from './settings-controls';
import { TEST_IDS } from './test-ids';

/** Shown while the node runs; the kit applies the choice to every strand at once and saves it for the next start. */
export function OfflineModeSwitch({ showAlert }: { showAlert: (title: string, message: string) => void }) {
	const [offline, setOffline] = useState(() => getStrandOfflineMode() === 'offline');
	const [busy, setBusy] = useState(false);

	const change = async (next: boolean) => {
		setBusy(true);
		try {
			await setStrandOfflineMode(next ? 'offline' : 'online');
			setOffline(next);
		} catch (err) {
			showAlert('Could not change offline mode', errorMessage(err));
		} finally {
			setBusy(false);
		}
	};

	return (
		<View style={{ marginTop: 8 }}>
			<View style={controlStyles.switchRow}>
				<Text style={controlStyles.switchLabel}>Offline mode</Text>
				<Switch value={offline} onValueChange={(next) => void change(next)} disabled={busy} testID={TEST_IDS.settings.offlineModeSwitch} />
			</View>
			<Text style={controlStyles.hint}>
				On: a message counts as sent once this phone has saved it, and goes to the chat&apos;s
				other members, in order, when they can be reached. Off: it counts as sent once the
				members this phone can reach hold it. Turning it off leaves messages already waiting
				where they are, and later ones wait behind them.
			</Text>
		</View>
	);
}
