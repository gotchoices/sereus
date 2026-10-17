/**
 * join-cadre-section.tsx — Settings → "Join my existing cadre": this app joins the cadre another
 * Sereus app already holds, moves its chats there and removes its own cadre from this phone
 * (docs/reference-app-rn.md → "Joining an existing cadre"). The other side is the owner app's
 * "Add a device or app" (`add-device-section.tsx`).
 *
 * "Choose the app that holds your cadre" opens an owner app on this phone with this app's request
 * (the hook's `askOwnerApp`); its answer comes back as a link Settings takes, since this section
 * may not be mounted then. The request and the paste field below it are the way in from another
 * device, and the fallback. The field also takes an owner grant, which makes this app an owner
 * too: how an app with chats of its own brings them. A pasted or scanned response enters through
 * the hook's `joinExistingCadre`, which also refuses a response made for another app. From Join
 * on, the flow the hook holds replaces the inputs.
 */

import { useEffect, useState } from 'react';
import { Platform, StyleSheet, Text, View } from 'react-native';
import { CADRE_INVITATION_PREFIX, OWNER_GRANT_PREFIX } from '@serfab/cadre-core';
import type { SereusApp } from '@serfab/cadre-rn/app-link';
import { useCadre } from './cadre-context';
import { CodeScanner } from './code-scanner';
import { joinFailureAlert } from './join-failure';
import { joinFlowText, type JoinFlow } from './join-flow';
import { COPY_REQUEST_LINE, installedOwnerApps } from './join-link';
import { isOwnerKeyText, OWNER_KEY_SCANNED_LINE } from './owner-keys';
import { Btn, controlStyles, Fact, LabelledInput, Section, shortPeerId } from './settings-controls';
import { ShareCode } from './share-code';
import { TEST_IDS } from './test-ids';

const INTRO_LINE = 'If another Sereus app already holds your cadre, this app can join it. Its chats move with it, and its own cadre is then removed from this phone.';
const FIRST_LAUNCH_LINE = 'If another Sereus app already holds your cadre, this app can join it.';

const SCAN_HINT = 'Point the camera at the invitation or owner grant the app holding your cadre shows.';
const SCAN_OTHER_CODE_HINT = 'That is not an invitation or an owner grant. Point the camera at what the app holding your cadre shows under Add a device or app, or under Owner keys → Add an owner key.';

/** Where an owner grant comes from, and why this app would want one. */
const OWNER_GRANT_LINE = 'To bring this app\'s chats along, it joins as an owner: in the app that holds your cadre, make an owner grant (a code that makes the app that uses it an owner) under Owner keys → Add an owner key, and paste it below.';
const FIRST_LAUNCH_OWNER_GRANT_LINE = 'To make this app an owner of your cadre too, paste an owner grant (a code that makes the app that uses it an owner) below instead, made in the app that holds your cadre under Owner keys → Add an owner key.';

const NO_OTHER_APP_LINE = `No other Sereus app is installed on this phone. ${COPY_REQUEST_LINE}`;
const CAME_BACK_LINE = 'That opened this app again. Choose the app that holds your cadre, or copy this app\'s request into it.';

type ShowAlert = (title: string, message: string, detail?: string) => void;

type JoinRequest =
	| { state: 'reading' }
	| { state: 'ready'; text: string; peerId: string }
	| { state: 'failed'; error: string };

export function JoinCadreSection({ showAlert, firstLaunch = false }: {
	showAlert: ShowAlert;
	/** This app has no cadre of its own yet, so nothing moves and nothing is removed. */
	firstLaunch?: boolean;
}) {
	const cadre = useCadre();
	// Kept here, not in the inputs, which unmount while a flow shows: a failed join keeps the paste.
	const [invitationText, setInvitationText] = useState('');
	const [scannerOpen, setScannerOpen] = useState(false);

	const join = async (text: string) => {
		const encoded = text.trim();
		if (!encoded) return;
		try {
			await cadre.joinExistingCadre(encoded);
			setInvitationText('');
			// Joined: a request still open to an owner app would show as waiting, and its answer would join again.
			void cadre.cancelLinkRequest();
		} catch (err) {
			console.warn('[settings] joining a cadre failed:', err);
			const { title, message } = joinFailureAlert(err);
			showAlert(title, message);
		}
	};

	const handleScanned = (text: string) => {
		setScannerOpen(false);
		setInvitationText(text);
		void join(text);
	};

	return (
		<Section title="Join my existing cadre">
			<Text style={controlStyles.hint}>{firstLaunch ? FIRST_LAUNCH_LINE : INTRO_LINE}</Text>
			{cadre.joinFlow ? (
				<JoinFlowView flow={cadre.joinFlow} />
			) : (
				<>
					<AskOwnerApp showAlert={showAlert} />
					<RequestView />
					<Text style={controlStyles.hint}>{firstLaunch ? FIRST_LAUNCH_OWNER_GRANT_LINE : OWNER_GRANT_LINE}</Text>
					<LabelledInput label="Paste response, invitation or owner grant" value={invitationText} onChangeText={setInvitationText} placeholder="sereus-invite:1.… or sereus-owner-grant:1.…" multiline testID={TEST_IDS.settings.cadreInvitationInput} />
					<Btn label="Scan" onPress={() => setScannerOpen(true)} color="#444" testID={TEST_IDS.settings.scanCadreInvitationBtn} />
					<Btn label="Join" onPress={() => void join(invitationText)} disabled={!invitationText.trim()} testID={TEST_IDS.settings.joinCadreBtn} />
				</>
			)}
			<CodeScanner
				visible={scannerOpen}
				accepts={isJoinCredential}
				hint={SCAN_HINT}
				otherCodeHint={(text) => isOwnerKeyText(text) ? OWNER_KEY_SCANNED_LINE : SCAN_OTHER_CODE_HINT}
				onScanned={handleScanned}
				onClose={() => setScannerOpen(false)}
			/>
		</Section>
	);
}

/**
 * Opens the app holding the cadre with this app's request: on Android through the system chooser,
 * on iOS from a list of the other Sereus apps installed here. Then the waiting line, with Cancel.
 */
function AskOwnerApp({ showAlert }: { showAlert: ShowAlert }) {
	const cadre = useCadre();
	// iOS: the installed apps to choose from, while the list is open.
	const [apps, setApps] = useState<SereusApp[] | 'reading' | null>(null);

	const ask = async (app: SereusApp | null) => {
		setApps(null);
		await askOwnerAppOrAlert(cadre.askOwnerApp, app, showAlert);
	};

	const choose = async () => {
		if (Platform.OS !== 'ios') {
			await ask(null);
			return;
		}
		setApps('reading');
		try {
			setApps(await installedOwnerApps());
		} catch (err) {
			console.warn('[settings] could not list the Sereus apps on this phone:', err);
			setApps(null);
			showAlert('Could not list the apps on this phone', COPY_REQUEST_LINE, err instanceof Error ? err.message : String(err));
		}
	};

	return (
		<View>
			<Btn label="Choose the app that holds your cadre" onPress={() => void choose()} disabled={apps === 'reading'} testID={TEST_IDS.settings.chooseOwnerAppBtn} />
			{Array.isArray(apps) ? <OwnerAppList apps={apps} onPick={(app) => void ask(app)} onClose={() => setApps(null)} /> : null}
			<LinkRequestStatus />
		</View>
	);
}

/**
 * Open the app holding the cadre with this app's request through the hook's `askOwnerApp`: `app` by
 * its scheme, or Android's chooser for null. On Android, an app that would not open by its scheme is
 * looked for in the chooser. An alert says when nothing opened, with the copy-and-paste way in.
 */
export async function askOwnerAppOrAlert(
	askOwnerApp: (app: SereusApp | null) => Promise<boolean>,
	app: SereusApp | null,
	showAlert: ShowAlert,
): Promise<void> {
	try {
		if (await askOwnerApp(app)) return;
		if (app && Platform.OS === 'android' && await askOwnerApp(null)) return;
		showAlert(`Could not open ${app?.name ?? 'an app that holds your cadre'}`, COPY_REQUEST_LINE);
	} catch (err) {
		console.warn('[settings] could not ask the app holding the cadre:', err);
		showAlert('Could not ask the app that holds your cadre', COPY_REQUEST_LINE, err instanceof Error ? err.message : String(err));
	}
}

function OwnerAppList({ apps, onPick, onClose }: { apps: SereusApp[]; onPick: (app: SereusApp) => void; onClose: () => void }) {
	return (
		<View style={styles.appList}>
			{apps.length === 0 ? (
				<Text style={controlStyles.hint} testID={TEST_IDS.settings.ownerAppListEmpty}>{NO_OTHER_APP_LINE}</Text>
			) : (
				<>
					<Text style={controlStyles.label}>Which app holds your cadre?</Text>
					{apps.map((app) => (
						<Btn key={app.scheme} label={app.name} onPress={() => onPick(app)} color="#2a2a3e" testID={TEST_IDS.settings.ownerAppOption(app.scheme)} />
					))}
				</>
			)}
			<Btn label="Close" onPress={onClose} color="#444" testID={TEST_IDS.settings.ownerAppListCloseBtn} />
		</View>
	);
}

/** The open request's waiting line and Cancel, or the line saying this app's own request opened it. */
function LinkRequestStatus() {
	const { linkRequest, linkRequestReturned, cancelLinkRequest } = useCadre();
	if (linkRequest) {
		return (
			<>
				<Text style={controlStyles.slowHint} testID={TEST_IDS.settings.linkRequestWaiting}>
					Waiting for {linkRequest.ownerAppName ?? 'the app you chose'} to answer…
				</Text>
				<Btn label="Cancel" onPress={() => void cancelLinkRequest()} color="#444" testID={TEST_IDS.settings.cancelLinkRequestBtn} />
			</>
		);
	}
	if (linkRequestReturned) return <Text style={controlStyles.slowHint} testID={TEST_IDS.settings.linkRequestReturned}>{CAME_BACK_LINE}</Text>;
	return null;
}

function RequestView() {
	const request = useJoinRequest();
	if (request.state === 'reading') return <Text style={controlStyles.hint}>Reading this app&apos;s identity…</Text>;
	if (request.state === 'failed') {
		return <Text style={controlStyles.slowHint}>Could not read this app&apos;s identity, so it has no request to show: {request.error}</Text>;
	}
	return (
		<View>
			<ShareCode title="This app's request" text={request.text} testIDPrefix={TEST_IDS.settings.joinRequestShare} />
			<Fact
				label="Code"
				value={shortPeerId(request.peerId)}
				note="The app holding your cadre shows this code when it asks you to add this app; check that they match."
			/>
			<Text style={controlStyles.hint}>
				Paste this in the app that holds your cadre, under Add a device or app → Paste request. Or ask that app for an open invitation.
			</Text>
		</View>
	);
}

function JoinFlowView({ flow }: { flow: JoinFlow }) {
	const { line, detail } = joinFlowText(flow);
	return (
		<View>
			<Text style={styles.line} testID={TEST_IDS.settings.joinFlowLine}>{line}</Text>
			{detail ? <Text style={controlStyles.hint} testID={TEST_IDS.settings.joinFlowDetail}>{detail}</Text> : null}
			<FlowActions flow={flow} />
		</View>
	);
}

/** No action while the app is admitted and the kit is still moving or removing: none of it rolls back. */
function FlowActions({ flow }: { flow: JoinFlow }) {
	const cadre = useCadre();
	switch (flow.step) {
		case 'joining':
			return <Btn label="Cancel" onPress={cadre.cancelJoin} color="#444" testID={TEST_IDS.settings.cancelJoinBtn} />;
		case 'move-incomplete':
			return (
				<>
					<Btn label="Retry moving" onPress={() => void cadre.retryStrandMove()} testID={TEST_IDS.settings.retryStrandMoveBtn} />
					<Btn label="Later" onPress={cadre.dismissJoinFlow} color="#444" testID={TEST_IDS.settings.joinFlowLaterBtn} />
				</>
			);
		case 'confirm-discard':
			return (
				<>
					<Btn
						label="Delete them"
						onPress={() => void cadre.removeOldCadre([...flow.strandIds, ...flow.pendingJoinIds])}
						color="#f44336"
						testID={TEST_IDS.settings.discardOldCadreItemsBtn}
					/>
					<Btn label="Keep old cadre" onPress={cadre.keepOldCadre} color="#444" testID={TEST_IDS.settings.keepOldCadreBtn} />
				</>
			);
		case 'old-cadre-remains':
			return (
				<>
					<Btn label="Remove it now" onPress={() => void cadre.removeOldCadre()} testID={TEST_IDS.settings.removeOldCadreBtn} />
					<Btn label="Later" onPress={cadre.dismissJoinFlow} color="#444" testID={TEST_IDS.settings.joinFlowLaterBtn} />
				</>
			);
		case 'old-cadre-kept':
		case 'done':
			return <Btn label="OK" onPress={cadre.dismissJoinFlow} testID={TEST_IDS.settings.joinFlowOkBtn} />;
		default:
			return null;
	}
}

/** This app's join request and its peer id, read once the section shows; neither changes, whichever party runs. */
function useJoinRequest(): JoinRequest {
	const { identityPeerId, joinRequestText } = useCadre();
	const [request, setRequest] = useState<JoinRequest>({ state: 'reading' });
	useEffect(() => {
		let current = true;
		const read = async () => {
			try {
				const [peerId, text] = await Promise.all([identityPeerId(), joinRequestText()]);
				if (current) setRequest({ state: 'ready', text, peerId });
			} catch (err) {
				console.warn('[settings] could not read this app\'s identity for its join request:', err);
				if (current) setRequest({ state: 'failed', error: err instanceof Error ? err.message : String(err) });
			}
		};
		void read();
		return () => {
			current = false;
		};
	}, [identityPeerId, joinRequestText]);
	return request;
}

function isJoinCredential(text: string): boolean {
	const trimmed = text.trim();
	return trimmed.startsWith(CADRE_INVITATION_PREFIX) || trimmed.startsWith(OWNER_GRANT_PREFIX);
}

const styles = StyleSheet.create({
	line: { color: '#fff', fontSize: 14, lineHeight: 20, marginBottom: 8 },
	appList: { marginTop: 8, marginBottom: 4 },
});
