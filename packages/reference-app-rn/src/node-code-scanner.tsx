/**
 * node-code-scanner.tsx — a full-screen camera that reads the QR code a cadre-host shows
 * for a node waiting to be claimed, and hands back its text.
 *
 * `expo-camera` is a native module: a dev client built before it was added throws
 * "Cannot find native module 'ExpoCamera'" as this file loads, which is when Settings loads
 * (docs/reference-app-rn.md → "When Native Rebuild Is Needed").
 */

import { useEffect, useRef, useState } from 'react';
import { Linking, Modal, SafeAreaView, StyleSheet, Text, View } from 'react-native';
import { CameraView, PermissionStatus, useCameraPermissions, type BarcodeScanningResult } from 'expo-camera';
import { NODE_CODE_SCHEME } from './node-claim';
import { Btn, controlStyles } from './settings-controls';
import { TEST_IDS } from './test-ids';

export function NodeCodeScanner({ visible, onScanned, onClose }: {
	visible: boolean;
	/** The scanned text, which starts with `sereus-join:`; the scanner has closed. */
	onScanned: (text: string) => void;
	onClose: () => void;
}) {
	return (
		<Modal visible={visible} animationType="slide" onRequestClose={onClose}>
			{/* Mounted only while open, so every opening starts unlatched and asks for the camera afresh. */}
			{visible && <ScannerBody onScanned={onScanned} onClose={onClose} />}
		</Modal>
	);
}

function ScannerBody({ onScanned, onClose }: { onScanned: (text: string) => void; onClose: () => void }) {
	const [permission, requestPermission] = useCameraPermissions();
	const [sawOtherCode, setSawOtherCode] = useState(false);
	// `onBarcodeScanned` fires many times a second while a code is in view: the first node
	// code wins, and the ones queued behind it are dropped.
	const latched = useRef(false);

	useEffect(() => {
		if (permission?.status === PermissionStatus.UNDETERMINED) void requestPermission();
	}, [permission, requestPermission]);

	const handleScan = ({ data }: BarcodeScanningResult) => {
		if (latched.current) return;
		if (!data.trim().startsWith(NODE_CODE_SCHEME)) {
			setSawOtherCode(true);
			return;
		}
		latched.current = true;
		onScanned(data);
	};

	return (
		<SafeAreaView style={styles.screen}>
			{permission?.granted ? (
				<CameraView
					style={styles.camera}
					facing="back"
					barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
					onBarcodeScanned={handleScan}
				/>
			) : (
				<PermissionNotice
					denied={permission?.status === PermissionStatus.DENIED}
					canAskAgain={permission?.canAskAgain ?? true}
					onAsk={() => void requestPermission()}
				/>
			)}
			<View style={styles.footer}>
				<Text style={controlStyles.hint}>
					{sawOtherCode
						? 'That is not a node code. Point the camera at the code cadre-host shows under Join a cadre.'
						: 'Point the camera at the code cadre-host shows under Join a cadre.'}
				</Text>
				<Btn label="Cancel" onPress={onClose} color="#444" testID={TEST_IDS.settings.scannerCloseBtn} />
			</View>
		</SafeAreaView>
	);
}

function PermissionNotice({ denied, canAskAgain, onAsk }: { denied: boolean; canAskAgain: boolean; onAsk: () => void }) {
	if (!denied) {
		return <View style={styles.notice}><Text style={styles.noticeText}>Waiting for camera permission…</Text></View>;
	}
	return (
		<View style={styles.notice}>
			<Text style={styles.noticeText}>
				This app may not use the camera, so it cannot scan the code. Allow the camera, or close
				this and paste the code&apos;s text into the field under Add an always-on node instead.
			</Text>
			{canAskAgain
				? <Btn label="Allow camera" onPress={onAsk} />
				: <Btn label="Open system settings" onPress={() => void Linking.openSettings()} />}
		</View>
	);
}

const styles = StyleSheet.create({
	screen: { flex: 1, backgroundColor: '#0f0f1a' },
	camera: { flex: 1 },
	notice: { flex: 1, justifyContent: 'center', padding: 24 },
	noticeText: { color: '#ccc', fontSize: 14, lineHeight: 20, marginBottom: 12 },
	footer: { padding: 16 },
});
