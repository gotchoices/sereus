/**
 * recommend-app-section.tsx — Settings → Add a device or app → "Recommend an app": the owner allows
 * another Sereus app to join this cadre before it asks, then opens that app, or its store page to
 * get it (docs/architecture.md → "Recommending another app"). When that app's join request arrives
 * as a link within the hour, `AddDeviceSection` answers it without a prompt.
 *
 * A permission given here lets this app mint an invitation without asking: log app names only.
 */

import { useEffect, useState } from 'react';
import { Modal, ScrollView, Text, View } from 'react-native';
import { RECOMMENDATION_TTL_MS, type AppRecommendation } from '@serfab/cadre-rn/app-link';
import { recommendations } from './cadre-phone';
import { openRecommendedApp, recommendableApps, type RecommendableApp } from './join-link';
import { Btn, controlStyles, errorMessage, validUntilText } from './settings-controls';
import { TEST_IDS } from './test-ids';

// The kit's RECOMMENDATION_TTL_MS in words: change the two together.
const TTL_WORDS = 'the next hour';

const INTRO_LINE = `Allow another Sereus app to join this cadre, then get it or open it. When it asks to join within ${TTL_WORDS}, it is let in with nothing to copy.`;

type ShowAlert = (title: string, message: string, detail?: string) => void;

export function RecommendAppSection({ partyId, busy, refreshKey, showAlert }: {
	/** The party the connected node runs: the only one a permission given here admits to. */
	partyId: string;
	/** An invitation is being made: the app buttons wait for it. */
	busy: boolean;
	/** Changed by the parent to read both lists again: its Refresh, and a permission used up. */
	refreshKey: number;
	showAlert: ShowAlert;
}) {
	// Null while the first read runs, and after a read failed.
	const [apps, setApps] = useState<RecommendableApp[] | null>(null);
	const [appsError, setAppsError] = useState<string | null>(null);
	const [allowed, setAllowed] = useState<AppRecommendation[]>([]);
	const [allowedError, setAllowedError] = useState<string | null>(null);
	// The app the prompt is for; the prompt shows while it is set.
	const [choosing, setChoosing] = useState<RecommendableApp | null>(null);

	const readApps = async () => {
		try {
			setApps(await recommendableApps());
			setAppsError(null);
		} catch (err) {
			console.warn('[settings] could not list the Sereus apps to recommend:', err);
			setApps(null);
			setAppsError(errorMessage(err));
		}
	};

	const readAllowed = async () => {
		try {
			setAllowed(await recommendations.live(partyId));
			setAllowedError(null);
		} catch (err) {
			console.warn('[settings] could not read the apps allowed to join:', err);
			setAllowed([]);
			setAllowedError(errorMessage(err));
		}
	};

	useEffect(() => {
		void readApps();
		void readAllowed();
	}, [refreshKey, partyId]);

	// Saved before the app opens, since it may ask before this app is in front again.
	const allow = async (target: RecommendableApp) => {
		const { app } = target;
		try {
			await recommendations.approve({ scheme: app.scheme, appName: app.name, partyId });
		} catch (err) {
			console.warn(`[settings] could not save that ${app.name} may join:`, err);
			showAlert(`Could not allow ${app.name} to join`, errorMessage(err));
			return;
		}
		console.info(`[settings] allowed ${app.name} to join for ${TTL_WORDS}`);
		void readAllowed();
		if (!await openRecommendedApp(target)) {
			const yourself = target.installed ? 'Open it yourself' : 'Install it and open it yourself';
			showAlert(
				target.installed ? `Could not open ${app.name}` : `Could not open the store page of ${app.name}`,
				`${app.name} is still allowed to join for ${TTL_WORDS}. ${yourself}, or withdraw it under Allowed to join.`,
			);
		}
	};

	const handleAllow = () => {
		const target = choosing;
		setChoosing(null);
		if (target) void allow(target);
	};

	// No confirmation: nothing has been issued yet, and the app can be recommended again.
	const withdraw = async (entry: AppRecommendation) => {
		try {
			await recommendations.withdraw(entry.scheme);
			console.info(`[settings] withdrew the permission for ${entry.appName} to join`);
		} catch (err) {
			console.warn(`[settings] could not withdraw the permission for ${entry.appName} to join:`, err);
			showAlert(`Could not withdraw ${entry.appName}`, errorMessage(err));
		}
		await readAllowed();
	};

	return (
		<View>
			<Text style={controlStyles.subTitle}>Recommend an app</Text>
			<Text style={controlStyles.hint}>{INTRO_LINE}</Text>
			{appsError && <Text style={controlStyles.slowHint}>Could not list the Sereus apps: {appsError}</Text>}
			{apps?.length === 0 && <Text style={controlStyles.hint}>No other Sereus app to recommend.</Text>}
			{apps?.map((target) => (
				<Btn
					key={target.app.scheme}
					label={`${target.installed ? 'Open' : 'Get'} ${target.app.name}`}
					onPress={() => setChoosing(target)}
					disabled={busy}
					testID={TEST_IDS.settings.recommendAppBtn(target.app.scheme)}
				/>
			))}
			<AllowedApps allowed={allowed} error={allowedError} onWithdraw={(entry) => void withdraw(entry)} />
			<RecommendPrompt target={choosing} onAllow={handleAllow} onCancel={() => setChoosing(null)} />
		</View>
	);
}

/** The apps allowed to join that have not asked yet; nothing while there are none. */
function AllowedApps({ allowed, error, onWithdraw }: {
	allowed: AppRecommendation[];
	error: string | null;
	onWithdraw: (entry: AppRecommendation) => void;
}) {
	if (!error && allowed.length === 0) return null;
	return (
		<View>
			<Text style={controlStyles.subTitle}>Allowed to join</Text>
			{error && <Text style={controlStyles.slowHint}>Could not read the apps allowed to join: {error}</Text>}
			{allowed.map((entry) => (
				<View key={entry.scheme} style={controlStyles.listRow}>
					<View style={controlStyles.listRowText}>
						<Text style={controlStyles.listRowTitle}>{entry.appName}</Text>
						<Text style={controlStyles.listRowMeta}>{validUntilText(entry.approvedAtMs + RECOMMENDATION_TTL_MS)}</Text>
					</View>
					<View style={controlStyles.listRowBtn}>
						<Btn label="Withdraw" onPress={() => onWithdraw(entry)} color="#444" testID={TEST_IDS.settings.withdrawRecommendationBtn(entry.scheme)} />
					</View>
				</View>
			))}
		</View>
	);
}

/** Nothing is saved or opened until the owner allows it here; the system back button cancels. */
function RecommendPrompt({ target, onAllow, onCancel }: {
	target: RecommendableApp | null;
	onAllow: () => void;
	onCancel: () => void;
}) {
	const name = target?.app.name ?? '';
	return (
		<Modal visible={target !== null} transparent animationType="fade" onRequestClose={onCancel}>
			<View style={controlStyles.modalOverlay}>
				<View style={controlStyles.modalBox}>
					<Text style={controlStyles.modalTitle}>{`Let ${name} join your cadre?`}</Text>
					<ScrollView>
						<Text style={controlStyles.promptText}>{`If ${name} asks to join within ${TTL_WORDS}, this app lets it in without asking again.`}</Text>
					</ScrollView>
					<Btn label={`Allow and ${target?.installed ? 'open' : 'get'} ${name}`} onPress={onAllow} testID={TEST_IDS.settings.allowRecommendedAppBtn} />
					<Btn label="Cancel" onPress={onCancel} color="#444" testID={TEST_IDS.settings.cancelRecommendedAppBtn} />
				</View>
			</View>
		</Modal>
	);
}
