/**
 * Settings screen — connect to cadre, apply seed, create strand.
 */

import { useState, useCallback } from 'react';
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useCadre } from '../src/cadre-context';
import { TEST_IDS } from '../src/test-ids';
import { uuid } from '../src/uuid';

export default function SettingsScreen() {
  const cadre = useCadre();

  const [partyId, setPartyId] = useState('');
  const [bootstrapAddr, setBootstrapAddr] = useState('');
  const [seedInput, setSeedInput] = useState('');
  const [peerAddr, setPeerAddr] = useState('');
  const [inviteInput, setInviteInput] = useState('');
  const [modal, setModal] = useState<{ title: string; message: string } | null>(null);

  const showAlert = useCallback((title: string, message: string) => {
    setModal({ title, message });
  }, []);

  // ── Connect / Disconnect ───────────────────────────────────────────────

  const handleConnect = async () => {
    const pid = partyId.trim() || uuid();
    setPartyId(pid);
    const addrs = bootstrapAddr.trim() ? [bootstrapAddr.trim()] : [];
    try {
      await cadre.start({ partyId: pid, bootstrapAddrs: addrs });
    } catch (err) {
      showAlert('Connection failed', String(err));
    }
  };

  const handleDisconnect = async () => {
    await cadre.stop();
  };

  // ── Seed ───────────────────────────────────────────────────────────────

  const handleApplySeed = async () => {
    const seed = seedInput.trim();
    if (!seed) return;
    try {
      await cadre.applySeed(seed);
      setSeedInput('');
      showAlert('Seed applied', 'Peer cache updated');
    } catch (err) {
      showAlert('Seed failed', String(err));
    }
  };

  // ── Add Peer ──────────────────────────────────────────────────────────

  const handleDialPeer = async () => {
    const addr = peerAddr.trim();
    if (!addr) return;
    try {
      await cadre.dialPeer(addr);
      setPeerAddr('');
      showAlert('Peer connected', 'Dialed successfully');
    } catch (err) {
      showAlert('Dial failed', String(err));
    }
  };

  // ── Strand ─────────────────────────────────────────────────────────────

  const handleCreateStrand = async () => {
    try {
      const id = uuid();
      await cadre.createStrand(id);
      showAlert('Strand created', `ID: ${id.slice(0, 8)}…`);
    } catch (err) {
      showAlert('Strand creation failed', String(err));
    }
  };

  // ── Closed strand (trust model) ─────────────────────────────────────────

  const handleCreateClosedStrand = async () => {
    try {
      const encoded = await cadre.createClosedStrandWithInvite();
      showAlert('Closed strand + invite', encoded);
    } catch (err) {
      showAlert('Closed strand failed', String(err));
    }
  };

  const handleJoinViaInvite = async () => {
    const encoded = inviteInput.trim();
    if (!encoded) return;
    try {
      await cadre.joinViaInvite(encoded);
      setInviteInput('');
      showAlert('Joined closed strand', 'Consent handshake completed; strand attached');
    } catch (err) {
      showAlert('Join via invite failed', String(err));
    }
  };

  // ── Render ─────────────────────────────────────────────────────────────

  const connected = cadre.status === 'connected';

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      {/* Node info */}
      <Section title="Node">
        {connected ? (
          <>
            <InfoRow label="Status" value="Connected" color="#4caf50" />
            <InfoRow label="Peer ID" value={cadre.peerId ?? '—'} />
            <InfoRow label="Strands" value={String(cadre.strands.size)} />
            <Btn label="Disconnect" onPress={handleDisconnect} color="#f44336" testID={TEST_IDS.settings.disconnectBtn} />
          </>
        ) : (
          <>
            <InfoRow label="Status" value={cadre.status} color="#ff9800" />
            <LabelledInput label="Party ID" value={partyId} onChangeText={setPartyId} placeholder="auto-generated if empty" testID={TEST_IDS.settings.partyIdInput} />
            <LabelledInput label="Bootstrap addr" value={bootstrapAddr} onChangeText={setBootstrapAddr} placeholder="/ip4/…/tcp/…/ws/p2p/…" testID={TEST_IDS.settings.bootstrapAddrInput} />
            <Btn label="Connect" onPress={handleConnect} disabled={cadre.status === 'connecting'} testID={TEST_IDS.settings.connectBtn} />
          </>
        )}
      </Section>

      {/* Add Peer */}
      {connected && (
        <Section title="Add Peer">
          <LabelledInput label="Multiaddr" value={peerAddr} onChangeText={setPeerAddr} placeholder="/ip4/…/tcp/…/ws/p2p/…" testID={TEST_IDS.settings.addPeerInput} />
          <Btn label="Dial Peer" onPress={handleDialPeer} disabled={!peerAddr.trim()} testID={TEST_IDS.settings.addPeerBtn} />
        </Section>
      )}

      {/* Seed */}
      {connected && (
        <Section title="Seed Bootstrap">
          <LabelledInput label="Paste seed" value={seedInput} onChangeText={setSeedInput} placeholder="base64url seed string" multiline testID={TEST_IDS.settings.seedInput} />
          <Btn label="Apply Seed" onPress={handleApplySeed} disabled={!seedInput.trim()} testID={TEST_IDS.settings.applySeedBtn} />
        </Section>
      )}

      {/* Strand */}
      {connected && (
        <Section title="Strands">
          {[...cadre.strands.entries()].map(([id, s]) => (
            <InfoRow key={id} label={id.slice(0, 8)} value={s.status} />
          ))}
          <Btn label="Create Chat Strand" onPress={handleCreateStrand} testID={TEST_IDS.settings.createStrandBtn} />
        </Section>
      )}

      {/* Closed strand (trust model) */}
      {connected && (
        <Section title="Closed Strand (Invite-Only)">
          <Text style={styles.hint}>
            Host: create a closed strand and an invitation to share out-of-band.
            Invitee: paste an invitation to consent + join. Requires the host
            reachable via a relay/drone.
          </Text>
          <Btn label="Create Closed Strand + Invite" onPress={handleCreateClosedStrand} testID={TEST_IDS.settings.createClosedStrandBtn} />
          <LabelledInput label="Paste invite" value={inviteInput} onChangeText={setInviteInput} placeholder="base64url invitation" multiline testID={TEST_IDS.settings.inviteInput} />
          <Btn label="Join via Invite" onPress={handleJoinViaInvite} disabled={!inviteInput.trim()} testID={TEST_IDS.settings.joinViaInviteBtn} />
        </Section>
      )}

      {cadre.error && <Text style={styles.error}>{cadre.error}</Text>}

      {/* Selectable-text alert modal */}
      <Modal visible={modal !== null} transparent animationType="fade" onRequestClose={() => setModal(null)}>
        <View style={styles.modalOverlay}>
          <View style={styles.modalBox}>
            <Text style={styles.modalTitle} testID={TEST_IDS.settings.modalTitle}>{modal?.title}</Text>
            <ScrollView style={styles.modalScroll}>
              <Text style={styles.modalMessage} selectable>{modal?.message}</Text>
            </ScrollView>
            <Btn label="OK" onPress={() => setModal(null)} testID={TEST_IDS.settings.modalOkBtn} />
          </View>
        </View>
      </Modal>
    </ScrollView>
  );
}

// ── Reusable sub-components ──────────────────────────────────────────────────

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {children}
    </View>
  );
}

function InfoRow({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <View style={styles.row}>
      <Text style={styles.label}>{label}</Text>
      <Text style={[styles.value, color ? { color } : null]} numberOfLines={1}>{value}</Text>
    </View>
  );
}

function LabelledInput(props: { label: string; value: string; onChangeText: (t: string) => void; placeholder?: string; multiline?: boolean; testID?: string }) {
  return (
    <View style={{ marginBottom: 8 }}>
      <Text style={styles.label}>{props.label}</Text>
      <TextInput style={styles.input} value={props.value} onChangeText={props.onChangeText} placeholder={props.placeholder} placeholderTextColor="#666" multiline={props.multiline} testID={props.testID} />
    </View>
  );
}

function Btn({ label, onPress, disabled, color, testID }: { label: string; onPress: () => void; disabled?: boolean; color?: string; testID?: string }) {
  return (
    <Pressable style={[styles.btn, { backgroundColor: color ?? '#6c63ff' }, disabled && styles.btnDisabled]} onPress={onPress} disabled={disabled} testID={testID}>
      <Text style={styles.btnText}>{label}</Text>
    </Pressable>
  );
}

// ── Styles ─────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0f0f1a' },
  content: { padding: 16 },
  section: { marginBottom: 24 },
  sectionTitle: { color: '#6c63ff', fontSize: 16, fontWeight: '700', marginBottom: 12 },
  row: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 6 },
  label: { color: '#aaa', fontSize: 13, marginBottom: 4 },
  hint: { color: '#888', fontSize: 12, lineHeight: 17, marginBottom: 10 },
  value: { color: '#fff', fontSize: 13, flexShrink: 1, textAlign: 'right' },
  input: { backgroundColor: '#2a2a3e', color: '#fff', borderRadius: 8, paddingHorizontal: 12, paddingVertical: 8, fontSize: 14 },
  btn: { borderRadius: 8, paddingVertical: 10, alignItems: 'center', marginTop: 8 },
  btnDisabled: { opacity: 0.4 },
  btnText: { color: '#fff', fontWeight: '600', fontSize: 14 },
  error: { color: '#f44336', textAlign: 'center', marginTop: 12 },
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'center', alignItems: 'center' },
  modalBox: { backgroundColor: '#1e1e2e', borderRadius: 12, padding: 20, width: '85%', maxHeight: '60%' },
  modalTitle: { color: '#fff', fontSize: 16, fontWeight: '700', marginBottom: 12 },
  modalScroll: { maxHeight: 200, marginBottom: 8 },
  modalMessage: { color: '#ccc', fontSize: 14, lineHeight: 20 },
});

