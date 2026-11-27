/**
 * Example (React Native): beside an invitation the app has just minted. Copy and adapt; it is not
 * built or published.
 *
 * - Whether it is ready to hand out: a cadron holds the strand, so it can answer a join while
 *   this phone sleeps (`invitationReadinessStore`).
 * - "What's in this invitation": the addresses it names, in words (`invitations.describe`).
 * - The QR code, which a tap opens full screen (dark on white, the largest the screen allows).
 *
 * Props: `token` is what `node.encodeInvitation(...)` returned (after `invitations.withBootstrap`),
 * `link` the text actually shared (the URL the QR code carries), `strandId` the invitation's strand,
 * `newStrand` true when the invitation founded it just now.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import QRCode from 'react-native-qrcode-svg';
import { invitationReadinessStore, type InvitationText } from '@serfab/cadre-client';
import type { CadreClient } from '@serfab/cadre-client/sereus';
import { useStore } from './useStore';

interface Props {
	client: CadreClient;
	token: string;
	link: string;
	strandId: string;
	newStrand: boolean;
}

const READINESS = {
	ready: 'Ready to hand out: your machine can answer even while this phone sleeps.',
	waiting: 'Getting ready to hand out… your machine is taking a copy of the conversation.',
	'no-cadron': 'Only this phone can answer it: keep the app open until they join, or add a machine that stays on.',
} as const;

const KIND = {
	public: 'public address', name: 'public name', relay: 'relayed', webrtc: 'relayed, then direct if possible',
	private: 'home network only', loopback: 'this machine only',
} as const;

export function InvitationPanel({ client, token, link, strandId, newStrand }: Props) {
	const store = useMemo(() => invitationReadinessStore(client, strandId, { newStrand }), [client, strandId, newStrand]);
	const readiness = useStore(store);
	return (
		<View style={styles.panel}>
			<InvitationQr value={link} />
			<Text style={readiness === 'ready' ? styles.ready : styles.muted}>{READINESS[readiness]}</Text>
			<InvitationDetails client={client} token={token} link={link} />
		</View>
	);
}

function InvitationDetails({ client, token, link }: { client: CadreClient; token: string; link: string }) {
	const [open, setOpen] = useState(false);
	const [text, setText] = useState<InvitationText | null>(null);
	useEffect(() => {
		if (!open) return;
		let live = true;
		void client.invitations.describe(token, link).then(r => { if (live && r.ok) setText(r.value); });
		return () => { live = false; };
	}, [open, client, token, link]);
	return (
		<View>
			<Pressable onPress={() => setOpen(o => !o)}><Text style={styles.link}>{open ? 'Hide the details' : "What's in this invitation"}</Text></Pressable>
			{open && text && (
				<View style={styles.details}>
					{text.addresses.map(a => (
						<Text key={a.addr} style={a.reachesAnywhere ? undefined : styles.muted}>
							{(a.thisDevice ? 'this phone' : a.label) + ' · ' + (a.kind ? KIND[a.kind] : 'not usable by a phone') + ' · '
								+ (a.via === 'relay' ? `through relay ${a.host}` : `${a.host}, port ${a.port ?? '?'}`)}
						</Text>
					))}
					<Text style={styles.muted}>Expires {new Date(text.expiresAt).toLocaleString()}</Text>
					<Text style={styles.muted}>
						Link {text.linkLength} characters · {text.qrVersion ? `QR code size ${text.qrVersion}` : 'too long for one QR code'}
					</Text>
				</View>
			)}
		</View>
	);
}

function InvitationQr({ value }: { value: string }) {
	const { width, height } = useWindowDimensions();
	const [full, setFull] = useState(false);
	return (
		<>
			<Pressable onPress={() => setFull(true)} style={styles.center}>
				<QRCode value={value} size={180} />
				<Text style={styles.muted}>Tap the code to enlarge it</Text>
			</Pressable>
			<Modal visible={full} animationType="fade" onRequestClose={() => setFull(false)} supportedOrientations={['portrait', 'landscape']}>
				<Pressable style={styles.full} onPress={() => setFull(false)}>
					<QRCode value={value} size={Math.floor(Math.min(width, height) * 0.9)} backgroundColor="#ffffff" color="#000000" />
					<Text style={styles.muted}>Close</Text>
				</Pressable>
			</Modal>
		</>
	);
}

const styles = StyleSheet.create({
	panel: { gap: 10, padding: 16 },
	center: { alignItems: 'center', gap: 6 },
	full: { flex: 1, backgroundColor: '#ffffff', alignItems: 'center', justifyContent: 'center', gap: 16 },
	details: { gap: 4 },
	ready: { color: '#2c8a3f' },
	muted: { color: '#777777' },
	link: { color: '#0066cc' },
});
