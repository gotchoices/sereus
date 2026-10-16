/**
 * code-scanner.tsx — a full-screen camera that reads a QR code and hands back its text,
 * once it is a code the caller accepts: a cadre-host node code (Add an always-on node), another
 * app's join request (Add a device or app), an invitation (Join my existing cadre) or an owner
 * key's export (Owner keys).
 *
 * `expo-camera` is a native module: a dev client built before it was added throws
 * "Cannot find native module 'ExpoCamera'" as this file loads, which is when Settings loads
 * (docs/reference-app-rn.md → "When Native Rebuild Is Needed").
 */

import { useEffect, useRef, useState } from 'react';
import { Linking, Modal, SafeAreaView, StyleSheet, Text, View } from 'react-native';
import { CameraView, PermissionStatus, useCameraPermissions, type BarcodeScanningResult } from 'expo-camera';
import { Btn, controlStyles } from './settings-controls';
import { TEST_IDS } from './test-ids';

interface ScannerProps {
	/** Whether a scanned text is the kind of code this scanner is open for. */
	accepts: (text: string) => boolean;
	/** The line under the camera: what to point it at. */
	hint: string;
	/** The line shown instead once a code `accepts` refused was in view; given the code, it can say what that code is. */
	otherCodeHint: string | ((text: string) => string);
	/** The scanned text, which `accepts` took; the scanner has closed. */
	onScanned: (text: string) => void;
	onClose: () => void;
}

export function CodeScanner({ visible, ...props }: ScannerProps & { visible: boolean }) {
	return (
		<Modal visible={visible} animationType="slide" onRequestClose={props.onClose}>
			{/* Mounted only while open, so every opening starts unlatched and asks for the camera afresh. */}
			{visible && <ScannerBody {...props} />}
		</Modal>
	);
}

function ScannerBody({ accepts, hint, otherCodeHint, onScanned, onClose }: ScannerProps) {
	const [permission, requestPermission] = useCameraPermissions();
	// What the last refused code in view was, in words; null until one was.
	const [otherCodeLine, setOtherCodeLine] = useState<string | null>(null);
	// `onBarcodeScanned` fires many times a second while a code is in view: the first
	// accepted code wins, and the ones queued behind it are dropped.
	const latched = useRef(false);

	useEffect(() => {
		if (permission?.status === PermissionStatus.UNDETERMINED) void requestPermission();
	}, [permission, requestPermission]);

	const handleScan = ({ data }: BarcodeScanningResult) => {
		if (latched.current) return;
		if (!accepts(data)) {
			setOtherCodeLine(typeof otherCodeHint === 'string' ? otherCodeHint : otherCodeHint(data));
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
				<Text style={controlStyles.hint}>{otherCodeLine ?? hint}</Text>
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
				this and paste the code&apos;s text into the field instead.
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
