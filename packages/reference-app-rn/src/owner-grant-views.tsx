/**
 * owner-grant-views.tsx — the owner-grant parts of Settings → "Owner keys" (`owner-keys-section.tsx`
 * holds their state): the form for Add an owner key and Make a backup, the grant shown once, the
 * outstanding grants with Withdraw, and Redeem an owner grant (docs/reference-app-rn.md → "Owner
 * Keys"). The words are `owner-keys.ts`'s.
 *
 * A grant's text makes whoever holds it an owner: log the grant's key, never the text.
 */

import { useState } from 'react';
import { Share, Text, View } from 'react-native';
import { decodeOwnerGrant, parseNullableStoredDatetimeMs, type CadreInvitationReach, type OwnerGrantStatus } from '@serfab/cadre-core';
import { CodeScanner } from './code-scanner';
import {
	BACKUP_NEEDS_A_MACHINE,
	BACKUP_WARNING,
	DEFAULT_BACKUP_LABEL,
	describeOwnerKeyFailure,
	GRANT_WARNING,
	GRANT_WHERE_LINE,
	grantReachLine,
	grantTitle,
	isOwnerGrantText,
	labelProblem,
	OWNER_GRANT_MEANING,
	usesLeftText,
} from './owner-keys';
import { Btn, ConfirmPrompt, controlStyles, LabelledInput, validUntilText } from './settings-controls';
import { ShareCode } from './share-code';
import { TEST_IDS } from './test-ids';

/** A grant just made, the one time its text is shown. */
export interface ShownGrant {
	backup: boolean;
	title: string;
	text: string;
	expiresAtMs: number | null;
	reach: CadreInvitationReach;
}

/** The name, and Make it; nothing is sent while the name is too long. */
export function GrantFormView({ backup, busy, onSubmit, onCancel }: {
	backup: boolean;
	busy: boolean;
	onSubmit: (label: string) => void;
	onCancel: () => void;
}) {
	const [label, setLabel] = useState(backup ? DEFAULT_BACKUP_LABEL : '');
	const problem = labelProblem(label);
	return (
		<View>
			<Text style={controlStyles.subTitle}>{backup ? 'Make a backup' : 'Add an owner key'}</Text>
			<Text style={controlStyles.hint}>{OWNER_GRANT_MEANING}</Text>
			<Text style={controlStyles.hint}>
				{backup
					? 'A backup is an owner grant with no expiry, to print or save, so a new device can become an owner of this cadre if you lose this one. It is shown once.'
					: 'For another device or another app of yours: whichever uses this grant first becomes an owner of this cadre, with a key of its own. It works once, within 15 minutes.'}
			</Text>
			<LabelledInput label="Name" value={label} onChangeText={setLabel} placeholder={backup ? undefined : 'tablet'} testID={TEST_IDS.settings.ownerGrantLabelInput} />
			<Text style={controlStyles.hint}>The owner key it adds is listed under this name.</Text>
			{problem && <Text style={controlStyles.hint}>{problem}</Text>}
			<Btn
				label={busy ? 'Working…' : backup ? 'Make backup' : 'Make owner grant'}
				onPress={() => onSubmit(label)}
				disabled={busy || problem !== null}
				testID={TEST_IDS.settings.confirmOwnerGrantBtn}
			/>
			<Btn label="Cancel" onPress={onCancel} disabled={busy} color="#444" testID={TEST_IDS.settings.cancelOwnerGrantBtn} />
		</View>
	);
}

// NOTE: as the key export (`ExportView`), the grant is not hidden from screenshots, screen
// recording or the app switcher's snapshot (tickets/backlog/feat-rn-owner-key-export-hidden-from-screen-capture.md),
// and Copy leaves it on the clipboard until something else is copied.
/** The grant, the one time it is shown: the warning, the QR code, Copy, Share and the text, until Done. */
export function GrantView({ grant, onDone }: { grant: ShownGrant; onDone: () => void }) {
	const reachLine = grantReachLine(grant.reach, grant.backup);
	const share = () => {
		void Share.share({ message: grant.text }).catch((err: unknown) => {
			console.warn('[settings] sharing an owner grant failed:', err);
		});
	};
	return (
		<View>
			<Text style={controlStyles.slowHint}>{grant.backup ? BACKUP_WARNING : GRANT_WARNING}</Text>
			<Text style={controlStyles.hint}>{grant.backup ? BACKUP_NEEDS_A_MACHINE : `${validUntilText(grant.expiresAtMs)}, once. ${GRANT_WHERE_LINE}`}</Text>
			{reachLine && <Text style={reachLine.warning ? controlStyles.slowHint : controlStyles.hint}>{reachLine.text}</Text>}
			<ShareCode title={grant.title} text={grant.text} testIDPrefix={TEST_IDS.settings.ownerGrantShare} />
			<Btn label="Share" onPress={share} color="#444" testID={TEST_IDS.settings.shareOwnerGrantBtn} />
			<Btn label="Done" onPress={onDone} testID={TEST_IDS.settings.ownerGrantDoneBtn} />
		</View>
	);
}

/** The live grants, each with Withdraw, which asks once. */
export function OutstandingGrants({ grants, listError, busy, onWithdraw }: {
	grants: OwnerGrantStatus[];
	listError: string | null;
	busy: boolean;
	onWithdraw: (key: string) => void;
}) {
	const [withdrawing, setWithdrawing] = useState<string | null>(null);
	const confirm = () => {
		const key = withdrawing;
		setWithdrawing(null);
		if (key) onWithdraw(key);
	};
	return (
		<View>
			<Text style={controlStyles.subTitle}>Outstanding owner grants</Text>
			{listError && <Text style={controlStyles.slowHint}>Could not read the owner grants: {listError}</Text>}
			{!listError && grants.length === 0 && <Text style={controlStyles.hint}>None.</Text>}
			{grants.map(({ grant, usesRecorded }) => (
				<View key={grant.key} style={controlStyles.listRow} testID={TEST_IDS.settings.ownerGrantRow(grant.key)}>
					<View style={controlStyles.listRowText}>
						<Text style={controlStyles.listRowTitle}>{grantTitle(grant)}</Text>
						<Text style={controlStyles.listRowMeta}>
							{grant.expiresAt === null ? 'Never expires' : validUntilText(parseNullableStoredDatetimeMs(grant.expiresAt))} · {usesLeftText(grant.totalUses, usesRecorded)}
						</Text>
					</View>
					<View style={controlStyles.listRowBtn}>
						<Btn label="Withdraw" onPress={() => setWithdrawing(grant.key)} disabled={busy} color="#444" testID={TEST_IDS.settings.withdrawOwnerGrantBtn(grant.key)} />
					</View>
				</View>
			))}
			<ConfirmPrompt
				open={withdrawing !== null}
				title="Withdraw this owner grant?"
				text="Nobody can become an owner with it afterwards. Owner keys it already added stay owners; remove those above."
				confirmLabel="Withdraw"
				onConfirm={confirm}
				onCancel={() => setWithdrawing(null)}
				confirmTestID={TEST_IDS.settings.confirmWithdrawOwnerGrantBtn}
				cancelTestID={TEST_IDS.settings.cancelWithdrawOwnerGrantBtn}
			/>
		</View>
	);
}

/** Paste or scan a grant; a scanned one is redeemed at once. */
export function RedeemForm({ busy, onRedeem }: {
	busy: boolean;
	/** `onRedeemed` clears the form, once this device is an owner. */
	onRedeem: (text: string, onRedeemed: () => void) => void;
}) {
	const [text, setText] = useState('');
	const [scannerOpen, setScannerOpen] = useState(false);
	const clear = () => setText('');

	const handleScanned = (scanned: string) => {
		setScannerOpen(false);
		setText(scanned);
		onRedeem(scanned, clear);
	};

	return (
		<View>
			<Text style={controlStyles.subTitle}>Redeem an owner grant</Text>
			<Text style={controlStyles.hint}>
				Made under Add an owner key or Make a backup on an owner device of this cadre. Redeeming it makes this device an owner, with this device&apos;s owner key, or a new one when it holds none.
			</Text>
			<LabelledInput label="Owner grant" value={text} onChangeText={setText} placeholder="sereus-owner-grant:1.…" multiline testID={TEST_IDS.settings.redeemOwnerGrantInput} />
			<Btn label="Scan owner grant" onPress={() => setScannerOpen(true)} disabled={busy} color="#444" testID={TEST_IDS.settings.scanOwnerGrantBtn} />
			<Btn label="Redeem" onPress={() => onRedeem(text, clear)} disabled={busy || !text.trim()} testID={TEST_IDS.settings.redeemOwnerGrantBtn} />
			<CodeScanner
				visible={scannerOpen}
				accepts={isOwnerGrantText}
				hint="Point the camera at the owner grant's QR code."
				otherCodeHint={notAnOwnerGrantLine}
				onScanned={handleScanned}
				onClose={() => setScannerOpen(false)}
			/>
		</View>
	);
}

/** The scanner's line for a code that is not an owner grant: the decoder's own refusal, which names an owner key, an invitation or a join request. */
function notAnOwnerGrantLine(text: string): string {
	try {
		decodeOwnerGrant(text);
	} catch (err) {
		return describeOwnerKeyFailure(err);
	}
	return 'Point the camera at the owner grant\'s QR code.';
}
