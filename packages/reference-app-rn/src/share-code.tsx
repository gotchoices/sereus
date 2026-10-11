/**
 * share-code.tsx — text another app or device has to receive, shown three ways: as a QR
 * code to scan, through a Copy button, and as selectable text.
 *
 * The QR code is one `<Path>` built from the encoder's module matrix: an invitation is up
 * to about 2,000 characters, a code of about 150×150 modules, and one path keeps that cheap
 * to draw. Error correction level L keeps the modules as large as the text allows.
 *
 * `react-native-svg` and `expo-clipboard` are native modules: a dev client built before
 * they were added fails as this file loads, which is when Settings loads
 * (docs/reference-app-rn.md → "When Native Rebuild Is Needed").
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import Svg, { Path, Rect } from 'react-native-svg';
import * as Clipboard from 'expo-clipboard';
import { create as createQrCode } from 'qrcode/lib/core/qrcode';
import { Btn, controlStyles } from './settings-controls';
import { TEST_IDS } from './test-ids';

/** The light border a scanner needs around the code, in modules (the QR specification's minimum). */
const QUIET_ZONE = 4;
/** Widest the code is drawn, in layout points; a narrower screen draws it at the content width. */
const QR_MAX_SIDE = 320;
/** The horizontal padding of the Settings screen's content, which the code must fit inside. */
const SCREEN_PADDING = 32;
/** How long the Copy button says how the last copy went. */
const COPY_RESULT_MS = 2_000;

type CopyResult = 'copied' | 'failed' | null;

const COPY_LABEL: Record<Exclude<CopyResult, null>, string> = {
	copied: 'Copied',
	failed: 'Could not copy; select the text below instead',
};

interface QrDrawing {
	/** Modules per side, quiet zone excluded. */
	size: number;
	/** The dark modules as one SVG path, one unit per module. */
	path: string;
}

export function ShareCode({ title, text, testIDPrefix }: { title: string; text: string; testIDPrefix: string }) {
	const qr = useMemo(() => drawQrCode(text), [text]);
	const { width } = useWindowDimensions();
	const side = Math.min(width - SCREEN_PADDING, QR_MAX_SIDE);
	const [copy, copyResult] = useCopy(text);

	return (
		<View style={styles.box}>
			<Text style={styles.title}>{title}</Text>
			{qr ? (
				<View style={styles.qr}>
					<Svg width={side} height={side} viewBox={`${-QUIET_ZONE} ${-QUIET_ZONE} ${qr.size + 2 * QUIET_ZONE} ${qr.size + 2 * QUIET_ZONE}`}>
						<Rect x={-QUIET_ZONE} y={-QUIET_ZONE} width={qr.size + 2 * QUIET_ZONE} height={qr.size + 2 * QUIET_ZONE} fill="#fff" />
						<Path d={qr.path} fill="#000" />
					</Svg>
				</View>
			) : (
				<Text style={controlStyles.slowHint}>Too long for a QR code; use Copy instead.</Text>
			)}
			<Btn label={copyResult ? COPY_LABEL[copyResult] : 'Copy'} onPress={copy} testID={TEST_IDS.settings.shareCodeCopyBtn(testIDPrefix)} />
			<ScrollView style={styles.textScroll} nestedScrollEnabled>
				<Text style={styles.text} selectable testID={TEST_IDS.settings.shareCodeText(testIDPrefix)}>{text}</Text>
			</ScrollView>
		</View>
	);
}

/** The QR code for `text`, or null when the text is too long for any QR code version. */
function drawQrCode(text: string): QrDrawing | null {
	let modules: ReturnType<typeof createQrCode>['modules'];
	try {
		modules = createQrCode(text, { errorCorrectionLevel: 'L' }).modules;
	} catch (err) {
		console.warn(`[share-code] no QR code for ${text.length} characters:`, err);
		return null;
	}
	return { size: modules.size, path: darkModulesPath(modules.size, modules.data) };
}

/** Each row's runs of dark modules as rectangles, so a run of ten is one subpath, not ten. */
function darkModulesPath(size: number, data: Uint8Array): string {
	const parts: string[] = [];
	for (let row = 0; row < size; row++) {
		let col = 0;
		while (col < size) {
			if (!data[row * size + col]) {
				col++;
				continue;
			}
			const start = col;
			while (col < size && data[row * size + col]) col++;
			parts.push(`M${start} ${row}h${col - start}v1H${start}z`);
		}
	}
	return parts.join('');
}

/** A Copy action for `text`, and how a copy within the last {@link COPY_RESULT_MS} went. */
function useCopy(text: string): [() => void, CopyResult] {
	const [result, setResult] = useState<CopyResult>(null);
	const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
	useEffect(() => () => {
		if (timer.current) clearTimeout(timer.current);
	}, []);
	// A copy of the previous text says nothing about this one.
	useEffect(() => {
		setResult(null);
	}, [text]);

	const show = (next: CopyResult) => {
		setResult(next);
		if (timer.current) clearTimeout(timer.current);
		timer.current = setTimeout(() => setResult(null), COPY_RESULT_MS);
	};

	const copy = () => {
		void (async () => {
			try {
				await Clipboard.setStringAsync(text);
				show('copied');
			} catch (err) {
				console.warn('[share-code] copying to the clipboard failed:', err);
				show('failed');
			}
		})();
	};
	return [copy, result];
}

const styles = StyleSheet.create({
	box: { marginBottom: 8 },
	title: { color: '#fff', fontSize: 15, fontWeight: '600', marginBottom: 8 },
	qr: { alignItems: 'center', marginBottom: 4 },
	textScroll: { maxHeight: 120, marginTop: 8, backgroundColor: '#2a2a3e', borderRadius: 8 },
	text: { color: '#ccc', fontSize: 11, padding: 8 },
});
