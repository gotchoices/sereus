/**
 * owner-keys-section.tsx — Settings → "Owner keys": this cadre's owner keys; on an owner device,
 * Make a backup key, Export this device's key and Remove; and Import on any device
 * (docs/reference-app-rn.md → "Owner Keys"; docs/architecture.md → "Owner Keys"). The words are
 * `owner-keys.ts`'s. Also `SigningKeyFact`, the line the approval prompts name the signing key with.
 *
 * An export's text is the private key, and so is the text pasted into Import: log neither, nor a
 * passphrase. Log a key's fingerprint.
 */

import { useEffect, useRef, useState } from 'react';
import { Modal, ScrollView, Share, Switch, Text, View } from 'react-native';
import {
	decodeOwnerKeyExport,
	LOCKED_OWNER_KEY_EXPORT_PREFIX,
	OwnerKeyRemovalRefusedError,
	type CadreMachine,
	type CadreOwnerKey,
	type ImportedOwnerKey,
	type OwnerKeyRemovalPlan,
} from '@serfab/cadre-core';
import { useCadre } from './cadre-context';
import { CodeScanner } from './code-scanner';
import { ownerFingerprint } from './node-claim';
import {
	DEFAULT_BACKUP_LABEL,
	dependentRows,
	describeOwnerKeyFailure,
	EXPORT_WARNING,
	exportFormProblem,
	exportOptions,
	importOutcome,
	importOutcomeAlert,
	isOwnerKeyText,
	OWN_KEY_LINE,
	ownerKeyFacts,
	ownerKeyName,
	ownerKeyTitle,
	REMOVAL_REFUSAL_LINE,
	revouchOf,
	signingKeyText,
	type DependentRow,
	type ExportForm,
} from './owner-keys';
import { standingLine, useOwnerStanding } from './owner-standing';
import { Btn, controlStyles, errorMessage, Fact, LabelledInput, Section, useExclusive } from './settings-controls';
import { ShareCode } from './share-code';
import { TEST_IDS } from './test-ids';

type ShowAlert = (title: string, message: string, detail?: string) => void;

/** What the section shows in place of its controls: a form, or an export shown once. */
type Panel =
	| { kind: 'backup-form' }
	| { kind: 'export-form'; ownKey: CadreOwnerKey }
	| { kind: 'export'; title: string; text: string };

/** The removal the confirmation prompt is for. */
interface PendingRemoval {
	ownerKey: CadreOwnerKey;
	plan: OwnerKeyRemovalPlan;
	rows: DependentRow[];
	/** The ids of the rows whose Keep switch is on; every row until switched off. */
	kept: ReadonlySet<string>;
}

// NOTE: screen state, as in AddDeviceSection: the tab navigator keeps Settings mounted, so an export
// on screen stays across a tab switch. The section unmounts with the connected view, so a backup
// key's export on screen when the node stops is gone with it, and the key stays an owner nobody
// holds until it is removed here. If that is seen in practice, hold the export in the cadre context.
export function OwnerKeysSection({ showAlert, onOwnerKeysChanged }: {
	showAlert: ShowAlert;
	/** After a key is added, imported or removed here: Devices and nodes re-reads which machines are trusted. */
	onOwnerKeysChanged: () => void;
}) {
	const cadre = useCadre();
	// Refresh re-reads the standing too, so an unreadable one is not stuck until the next join.
	const [refreshes, setRefreshes] = useState(0);
	const standing = useOwnerStanding(refreshes);
	const [keys, setKeys] = useState<CadreOwnerKey[]>([]);
	const [listError, setListError] = useState<string | null>(null);
	const [panel, setPanel] = useState<Panel | null>(null);
	const [confirming, setConfirming] = useState<PendingRemoval | null>(null);
	// A backup, an export, an import, a plan read or a removal, one at a time.
	const { busy, exclusive } = useExclusive();
	// The node now, so a read that finishes after a join or a stop replaced it is dropped.
	const nodeRef = useRef(cadre.node);
	nodeRef.current = cadre.node;

	/** The cadre's owner keys, shown and returned; null when the read failed or the node was replaced meanwhile. */
	const refresh = async (): Promise<CadreOwnerKey[] | null> => {
		const node = nodeRef.current;
		try {
			const listed = await cadre.listOwnerKeys();
			if (nodeRef.current !== node) return null;
			setKeys(listed);
			setListError(null);
			return listed;
		} catch (err) {
			console.warn('[settings] could not read this cadre\'s owner keys:', err);
			if (nodeRef.current === node) setListError(errorMessage(err));
			return null;
		}
	};

	// A join replaces the node, and an import changes the key this device signs with.
	useEffect(() => {
		void refresh();
	}, [cadre.node, cadre.ownerPublicKey]);

	const changed = () => {
		onOwnerKeysChanged();
		void refresh();
	};

	const makeBackup = (form: ExportForm) => void exclusive(async () => {
		try {
			const { publicKey, exportText } = await cadre.addBackupOwnerKey(exportOptions(form));
			console.info(`[settings] added backup owner key ${ownerFingerprint(publicKey)}`);
			setPanel({ kind: 'export', title: `New owner key ${ownerKeyName({ key: publicKey, label: form.label.trim() || null })}`, text: exportText });
			changed();
		} catch (err) {
			console.warn('[settings] making a backup owner key failed:', err);
			showAlert('Could not make a backup key', describeOwnerKeyFailure(err));
		}
	});

	const exportOwn = (ownKey: CadreOwnerKey, form: ExportForm) => void exclusive(async () => {
		try {
			const text = await cadre.exportOwnerKey(exportOptions(form));
			console.info(`[settings] exported this device's owner key ${ownerFingerprint(ownKey.key)}`);
			setPanel({ kind: 'export', title: `Owner key ${ownerKeyName(ownKey)}`, text });
		} catch (err) {
			console.warn('[settings] exporting this device\'s owner key failed:', err);
			showAlert('Could not export this device\'s key', describeOwnerKeyFailure(err));
		}
	});

	const runImport = (text: string, passphrase: string | undefined, onImported: () => void) => void exclusive(async () => {
		let imported: ImportedOwnerKey;
		try {
			imported = await cadre.importOwnerKey(text, passphrase);
		} catch (err) {
			// The refusals never carry key material.
			console.warn('[settings] importing an owner key failed:', err);
			showAlert('Could not import the key', describeOwnerKeyFailure(err));
			return;
		}
		console.info(`[settings] imported owner key ${ownerFingerprint(imported.publicKey)} (wired ${imported.wired})`);
		onImported();
		onOwnerKeysChanged();
		const listed = await refresh();
		if (listed === null && !imported.wired) {
			showAlert('Owner key imported', `This phone keeps the key (${ownerFingerprint(imported.publicKey)}). Could not read this cadre's owner keys to say whether it is one of them; see the list once it reads again.`);
			return;
		}
		const { title, message } = importOutcomeAlert(importOutcome(imported, listed ?? []), imported, listed ?? []);
		showAlert(title, message);
	});

	const requestRemoval = (ownerKey: CadreOwnerKey) => void exclusive(async () => {
		const node = nodeRef.current;
		let plan: OwnerKeyRemovalPlan;
		try {
			plan = await cadre.planOwnerKeyRemoval(ownerKey.key);
		} catch (err) {
			console.warn(`[settings] could not read what removing owner key ${ownerFingerprint(ownerKey.key)} would do:`, err);
			showAlert('Could not prepare the removal', errorMessage(err));
			return;
		}
		const machines = plan.dependents.peers.length > 0 ? await readMachinesQuietly(cadre.listMachines) : [];
		if (nodeRef.current !== node) return;
		if (plan.ownerKey === null) {
			showAlert('Already removed', `${ownerKeyName(ownerKey)} is no longer an owner key of this cadre.`);
			void refresh();
			return;
		}
		const rows = dependentRows(plan, keys, machines);
		setConfirming({ ownerKey: plan.ownerKey, plan, rows, kept: new Set(rows.map((row) => row.id)) });
	});

	const remove = ({ ownerKey, rows, kept }: PendingRemoval) => void exclusive(async () => {
		const revouch = revouchOf(rows, kept);
		try {
			const result = await cadre.removeOwner(ownerKey.key, { revouch });
			if (result.removed) {
				console.info(`[settings] removed owner key ${ownerFingerprint(ownerKey.key)} (kept ${revouch.peers.length} devices, ${revouch.owners.length} keys)`);
			} else {
				showAlert('Already removed', `${ownerKeyName(ownerKey)} is no longer an owner key of this cadre.`);
			}
		} catch (err) {
			console.warn(`[settings] removing owner key ${ownerFingerprint(ownerKey.key)} failed:`, err);
			const gone = err instanceof OwnerKeyRemovalRefusedError && err.code === 'unknown';
			showAlert(gone ? 'Already removed' : 'Could not remove it', describeOwnerKeyFailure(err));
		}
		changed();
	});

	const handleConfirmRemoval = () => {
		const removal = confirming;
		setConfirming(null);
		if (removal) remove(removal);
	};

	const handleKeep = (id: string, keep: boolean) => setConfirming((current) => {
		if (!current) return current;
		const kept = new Set(current.kept);
		if (keep) kept.add(id);
		else kept.delete(id);
		return { ...current, kept };
	});

	const handleRefresh = () => {
		setRefreshes((n) => n + 1);
		void refresh();
	};

	const owner = standing === 'owner';
	const ownKey = keys.find((key) => key.heldHere) ?? null;
	return (
		<Section title="Owner keys">
			{(standing === 'member' || standing === 'unreadable') && <Text style={controlStyles.hint}>{standingLine(standing, 'add or remove owner keys')}</Text>}
			{listError && <Text style={controlStyles.slowHint}>Could not read the cadre&apos;s owner keys: {listError}</Text>}
			{keys.map((key) => (
				<OwnerKeyRow
					key={key.key}
					ownerKey={key}
					onRemove={owner && !key.heldHere ? () => requestRemoval(key) : undefined}
					ownLine={owner && key.heldHere}
					busy={busy}
				/>
			))}
			<Btn label="Refresh" onPress={handleRefresh} color="#444" testID={TEST_IDS.settings.refreshOwnerKeysBtn} />

			{panel?.kind === 'export' ? (
				<ExportView title={panel.title} text={panel.text} onDone={() => setPanel(null)} />
			) : panel?.kind === 'backup-form' ? (
				<ExportFormView
					title="Make a backup key"
					intro="A new owner key for this cadre, to keep somewhere safe. It is shown once; this phone keeps no copy."
					defaultLabel={DEFAULT_BACKUP_LABEL}
					submitLabel="Make backup key"
					busy={busy}
					onSubmit={makeBackup}
					onCancel={() => setPanel(null)}
				/>
			) : panel?.kind === 'export-form' ? (
				<ExportFormView
					title="Export this device's key"
					intro="The owner key this device signs with, to import on another device or keep as a backup."
					defaultLabel={panel.ownKey.label ?? ''}
					submitLabel="Export"
					busy={busy}
					onSubmit={(form) => exportOwn(panel.ownKey, form)}
					onCancel={() => setPanel(null)}
				/>
			) : (
				<>
					{owner && <Btn label="Make a backup key" onPress={() => setPanel({ kind: 'backup-form' })} disabled={busy} testID={TEST_IDS.settings.makeBackupKeyBtn} />}
					{owner && ownKey && (
						<Btn label="Export this device's key" onPress={() => setPanel({ kind: 'export-form', ownKey })} disabled={busy} color="#444" testID={TEST_IDS.settings.exportOwnKeyBtn} />
					)}
					<ImportForm busy={busy} onImport={runImport} />
				</>
			)}

			<RemovePrompt removal={confirming} onKeep={handleKeep} onConfirm={handleConfirmRemoval} onCancel={() => setConfirming(null)} />
		</Section>
	);
}

/** The machines, for naming a removal's dependents, or none, logged: names fall back to peer ids rather than the removal failing. */
async function readMachinesQuietly(listMachines: () => Promise<CadreMachine[]>): Promise<CadreMachine[]> {
	try {
		return await listMachines();
	} catch (err) {
		console.warn('[settings] could not read this cadre\'s machines to name them:', err);
		return [];
	}
}

function OwnerKeyRow({ ownerKey, onRemove, ownLine, busy }: {
	ownerKey: CadreOwnerKey;
	/** Absent where the key may not be removed here: this device's own, or a member's view. */
	onRemove?: () => void;
	/** Say how this device's own key is removed, under its row in an owner's view. */
	ownLine: boolean;
	busy: boolean;
}) {
	return (
		<View testID={TEST_IDS.settings.ownerKeyListRow(ownerKey.key)}>
			<View style={controlStyles.listRow}>
				<View style={controlStyles.listRowText}>
					<Text style={controlStyles.listRowTitle}>{ownerKeyTitle(ownerKey)}</Text>
					<Text style={controlStyles.listRowMeta}>{ownerKeyFacts(ownerKey)}</Text>
					{!ownerKey.trusted && <Text style={controlStyles.slowHint}>Not trusted here</Text>}
				</View>
				{onRemove && (
					<View style={controlStyles.listRowBtn}>
						<Btn label="Remove" onPress={onRemove} disabled={busy} color="#444" testID={TEST_IDS.settings.removeOwnerKeyBtn(ownerKey.key)} />
					</View>
				)}
			</View>
			{ownLine && <Text style={controlStyles.hint}>{OWN_KEY_LINE}</Text>}
		</View>
	);
}

/** A name, and a passphrase typed twice unless Protect with a passphrase is off; nothing is sent while the form has a problem. */
function ExportFormView({ title, intro, defaultLabel, submitLabel, busy, onSubmit, onCancel }: {
	title: string;
	intro: string;
	defaultLabel: string;
	submitLabel: string;
	busy: boolean;
	onSubmit: (form: ExportForm) => void;
	onCancel: () => void;
}) {
	const [form, setForm] = useState<ExportForm>({ label: defaultLabel, locked: true, passphrase: '', repeat: '' });
	const problem = exportFormProblem(form);
	const update = (fields: Partial<ExportForm>) => setForm((current) => ({ ...current, ...fields }));
	return (
		<View>
			<Text style={controlStyles.subTitle}>{title}</Text>
			<Text style={controlStyles.hint}>{intro}</Text>
			<LabelledInput label="Name" value={form.label} onChangeText={(label) => update({ label })} testID={TEST_IDS.settings.ownerKeyLabelInput} />
			<View style={controlStyles.switchRow}>
				<Text style={controlStyles.switchLabel}>Protect with a passphrase</Text>
				<Switch value={form.locked} onValueChange={(locked) => update({ locked })} testID={TEST_IDS.settings.ownerKeyPassphraseSwitch} />
			</View>
			{form.locked ? (
				<>
					<LabelledInput label="Passphrase" value={form.passphrase} onChangeText={(passphrase) => update({ passphrase })} secureTextEntry testID={TEST_IDS.settings.ownerKeyPassphraseInput} />
					<LabelledInput label="Passphrase again" value={form.repeat} onChangeText={(repeat) => update({ repeat })} secureTextEntry testID={TEST_IDS.settings.ownerKeyPassphraseRepeatInput} />
				</>
			) : (
				<Text style={controlStyles.slowHint}>Without a passphrase, anyone who sees the text or the QR code holds the key.</Text>
			)}
			{problem && <Text style={controlStyles.hint}>{problem}</Text>}
			<Btn label={busy ? 'Working…' : submitLabel} onPress={() => onSubmit(form)} disabled={busy || problem !== null} testID={TEST_IDS.settings.confirmOwnerKeyExportBtn} />
			<Btn label="Cancel" onPress={onCancel} disabled={busy} color="#444" testID={TEST_IDS.settings.cancelOwnerKeyExportBtn} />
		</View>
	);
}

// NOTE: the export is not hidden from screenshots, screen recording or the app switcher's
// snapshot: Android's FLAG_SECURE and iOS's app-switcher cover need `expo-screen-capture`, a native
// module this app does not include (tickets/backlog/feat-rn-owner-key-export-hidden-from-screen-capture.md).
/** The export, the one time it is shown: the warning, the QR code, Copy, Share and the text, until Done. */
function ExportView({ title, text, onDone }: { title: string; text: string; onDone: () => void }) {
	const share = () => {
		void Share.share({ message: text }).catch((err: unknown) => {
			console.warn('[settings] sharing an owner key export failed:', err);
		});
	};
	return (
		<View>
			<Text style={controlStyles.slowHint}>{EXPORT_WARNING}</Text>
			<ShareCode title={title} text={text} testIDPrefix={TEST_IDS.settings.ownerKeyExportShare} />
			<Btn label="Share" onPress={share} color="#444" testID={TEST_IDS.settings.shareOwnerKeyExportBtn} />
			<Btn label="Done" onPress={onDone} testID={TEST_IDS.settings.ownerKeyExportDoneBtn} />
		</View>
	);
}

/** Paste or scan an export; a locked one asks for its passphrase. */
function ImportForm({ busy, onImport }: {
	busy: boolean;
	/** `onImported` clears the form, once the key is stored. */
	onImport: (text: string, passphrase: string | undefined, onImported: () => void) => void;
}) {
	const [text, setText] = useState('');
	const [passphrase, setPassphrase] = useState('');
	const [scannerOpen, setScannerOpen] = useState(false);
	const locked = text.trim().startsWith(LOCKED_OWNER_KEY_EXPORT_PREFIX);

	const clear = () => {
		setText('');
		setPassphrase('');
	};

	const handleImport = (pasted: string) => {
		onImport(pasted, pasted.trim().startsWith(LOCKED_OWNER_KEY_EXPORT_PREFIX) ? passphrase : undefined, clear);
	};

	// A plain export is imported at once; a locked one waits for its passphrase.
	const handleScanned = (scanned: string) => {
		setScannerOpen(false);
		setText(scanned);
		if (!scanned.trim().startsWith(LOCKED_OWNER_KEY_EXPORT_PREFIX)) handleImport(scanned);
	};

	return (
		<View>
			<Text style={controlStyles.subTitle}>Import an owner key</Text>
			<Text style={controlStyles.hint}>
				An owner key exported on another device, or a backup key. This phone keeps it, and is an owner of every cadre that lists it.
			</Text>
			<LabelledInput label="Owner key" value={text} onChangeText={setText} placeholder="sereus-owner-key…" multiline testID={TEST_IDS.settings.importOwnerKeyInput} />
			<Btn label="Scan owner key" onPress={() => setScannerOpen(true)} disabled={busy} color="#444" testID={TEST_IDS.settings.scanOwnerKeyBtn} />
			{locked && (
				<LabelledInput label="Its passphrase" value={passphrase} onChangeText={setPassphrase} secureTextEntry testID={TEST_IDS.settings.importOwnerKeyPassphraseInput} />
			)}
			<Btn
				label="Import"
				onPress={() => handleImport(text)}
				disabled={busy || !text.trim() || (locked && passphrase === '')}
				testID={TEST_IDS.settings.importOwnerKeyBtn}
			/>
			<CodeScanner
				visible={scannerOpen}
				accepts={isOwnerKeyText}
				hint="Point the camera at the owner key's QR code."
				otherCodeHint={notAnOwnerKeyLine}
				onScanned={handleScanned}
				onClose={() => setScannerOpen(false)}
			/>
		</View>
	);
}

/**
 * The scanner's line for a code that is not an owner key: the owner-key decoder's own refusal,
 * which names an invitation, a join request or a node code.
 */
function notAnOwnerKeyLine(text: string): string {
	try {
		decodeOwnerKeyExport(text);
	} catch (err) {
		return describeOwnerKeyFailure(err);
	}
	return 'Point the camera at the owner key\'s QR code.';
}

/**
 * What removing the key does, read from the plan, with one Keep switch per row it added. A refused
 * removal shows why and only Close. The system back button cancels.
 */
function RemovePrompt({ removal, onKeep, onConfirm, onCancel }: {
	removal: PendingRemoval | null;
	onKeep: (id: string, keep: boolean) => void;
	onConfirm: () => void;
	onCancel: () => void;
}) {
	const refusal = removal?.plan.refusal ?? null;
	return (
		<Modal visible={removal !== null} transparent animationType="fade" onRequestClose={onCancel}>
			<View style={controlStyles.modalOverlay}>
				<View style={controlStyles.modalBox}>
					<Text style={controlStyles.modalTitle}>{removal ? `Remove owner key ${ownerKeyName(removal.ownerKey)}?` : ''}</Text>
					<ScrollView>
						{refusal !== null && <Text style={controlStyles.promptText}>{REMOVAL_REFUSAL_LINE[refusal]}</Text>}
						{removal && refusal === null && <RemovalDetails removal={removal} onKeep={onKeep} />}
					</ScrollView>
					{refusal === null && <Btn label="Remove" onPress={onConfirm} color="#f44336" testID={TEST_IDS.settings.confirmRemoveOwnerKeyBtn} />}
					<Btn label={refusal === null ? 'Cancel' : 'Close'} onPress={onCancel} color="#444" testID={TEST_IDS.settings.cancelRemoveOwnerKeyBtn} />
				</View>
			</View>
		</Modal>
	);
}

function RemovalDetails({ removal, onKeep }: { removal: PendingRemoval; onKeep: (id: string, keep: boolean) => void }) {
	const { plan, rows, kept } = removal;
	return (
		<>
			<Text style={controlStyles.promptText}>
				Whoever holds this key can no longer act as an owner of this cadre. The devices it was used on stay in the cadre.
			</Text>
			{rows.length > 0 && (
				<>
					<Text style={controlStyles.promptText}>These were added with this key. Keep each one?</Text>
					{rows.map((row) => (
						<View key={row.id} style={controlStyles.switchRow}>
							<Text style={controlStyles.switchLabel}>{`${row.kind === 'device' ? 'Device' : 'Owner key'} ${row.name}`}</Text>
							<Switch value={kept.has(row.id)} onValueChange={(keep) => onKeep(row.id, keep)} testID={TEST_IDS.settings.keepDependentSwitch(row.id)} />
						</View>
					))}
					<Text style={controlStyles.hint}>
						A kept one is vouched for again by this device&apos;s key first. A device not kept stops counting as a member of this cadre; an owner key not kept stays trusted only by the machines that already trust it.
					</Text>
				</>
			)}
			{plan.ownDependency && (
				<Text style={controlStyles.hint}>
					This device&apos;s own owner key was added with this key. It stays an owner on the machines that already trust it, and another owner key can vouch for it again later.
				</Text>
			)}
		</>
	);
}

/**
 * The owner key that signs an approval, as Owner keys names it ("Backup (1a2b3c4d)"), for the
 * prompts that add a node. Read when the prompt opens; its fingerprint alone until then, or when the
 * read fails.
 */
export function SigningKeyFact({ note }: { note?: string }) {
	const cadre = useCadre();
	const [keys, setKeys] = useState<CadreOwnerKey[]>([]);
	useEffect(() => {
		let stale = false;
		cadre.listOwnerKeys().then(
			(listed) => {
				if (!stale) setKeys(listed);
			},
			(err: unknown) => console.warn('[settings] could not read this cadre\'s owner keys to name the signing key:', err),
		);
		return () => {
			stale = true;
		};
	}, [cadre.node]);
	return <Fact label="Owner key" value={signingKeyText(keys, cadre.ownerPublicKey)} note={note} />;
}
