/**
 * Settings screen — connect to cadre, apply seed, create strand.
 */

import { useState, useCallback, useEffect, useRef } from 'react';
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
import {
  foundingDetail,
  isSlowFounding,
  pendingLabel,
  traceFounding,
  type FoundingKind,
  type FoundingOutcome,
  type PendingFounding,
} from '../src/founding-progress';
import { HostNodeRequestError, type HostNodeRequestStage } from '../src/host-node-request';
import { TEST_IDS } from '../src/test-ids';
import { uuid } from '../src/uuid';

/** Plain-language label for each stage of a host-node request, for the progress line. */
const HOST_NODE_STAGE_LABEL: Record<HostNodeRequestStage, string> = {
  requesting: 'Asking the host for a node…',
  'waiting-for-node': 'Waiting for the node to start…',
  authorizing: 'Adding the node to this cadre…',
  seeding: 'Telling the node who its owner is…',
  connecting: 'Connecting to the node…',
  connected: 'Connected.',
};

export default function SettingsScreen() {
  const cadre = useCadre();

  const [partyId, setPartyId] = useState('');
  const [bootstrapAddr, setBootstrapAddr] = useState('');
  const [seedInput, setSeedInput] = useState('');
  const [enrollInviteInput, setEnrollInviteInput] = useState('');
  const [peerAddr, setPeerAddr] = useState('');
  const [inviteInput, setInviteInput] = useState('');
  const [hostUrl, setHostUrl] = useState('');
  const [hostToken, setHostToken] = useState('');
  // The stage a host-node request has reached, or null when none is running —
  // which is also what disables the button.
  const [hostNodeStage, setHostNodeStage] = useState<HostNodeRequestStage | null>(null);
  const [modal, setModal] = useState<{ title: string; message: string; detail?: string } | null>(null);
  // The strand founding in progress, if any. Both create buttons found a strand, so
  // both are disabled while either runs: one screen cannot start two foundings.
  //
  // NOTE: screen state. The tab navigator (app/_layout.tsx) keeps a visited screen
  // mounted, so a founding in flight keeps the buttons disabled across tab switches.
  // If Settings is ever unmounted on blur, a remount would re-enable them mid-founding;
  // move this into the cadre context then.
  const [founding, setFounding] = useState<PendingFounding | null>(null);
  // Catches the same-frame double tap that `disabled` cannot: the prop only takes
  // effect after the re-render `setFounding` schedules.
  const foundingRef = useRef(false);
  const foundingElapsedMs = useFoundingClock(founding);

  const showAlert = useCallback((title: string, message: string, detail?: string) => {
    setModal({ title, message, detail });
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

  // Apply a cold-start seed, optionally anchoring trust on the owner keys
  // carried by a pasted CadreInvite. A cold node has no foreign owner key in
  // its OwnerKey table, so the secure default rejects a seed signed by
  // another cadre; pinning the invite's keys lets the first seed through. An
  // empty/older invite yields no pins — the alert says so rather than implying a
  // pin succeeded.
  const handleApplySeed = async () => {
    const seed = seedInput.trim();
    if (!seed) return;
    try {
      const enrollInvite = enrollInviteInput.trim();
      const pins = enrollInvite
        ? cadre.ownerKeysFromInvite(enrollInvite)
        : undefined;
      await cadre.applySeed(seed, pins);
      setSeedInput('');
      setEnrollInviteInput('');
      showAlert(
        'Seed applied',
        pins?.length
          ? `Pinned ${pins.length} owner key(s); peer cache updated`
          : 'Peer cache updated (no owner keys pinned)',
      );
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

  // ── Host node (borrow a node from a cadre-host) ────────────────────────

  // Errors carry a message written for a person plus the host's own wording as
  // `detail`; show both, because the detail is what makes a bug report useful.
  // The hook holds the real re-entry guard — this only disables the button.
  const handleRequestHostNode = async () => {
    setHostNodeStage('requesting');
    try {
      const result = await cadre.requestHostNode(hostUrl, hostToken, setHostNodeStage);
      showAlert('Host node connected', `Peer ID: ${result.peerId}`, `Loan ${result.donationId}`);
    } catch (err) {
      const detail = err instanceof HostNodeRequestError ? err.detail : undefined;
      showAlert('Host node request failed', String(err instanceof Error ? err.message : err), detail);
    } finally {
      setHostNodeStage(null);
    }
  };

  // ── Strand founding (both create buttons) ──────────────────────────────

  // Run one founding with its progress state and log lines. Returns null, without
  // running `op`, while another founding from this screen is still in flight.
  //
  // NOTE: accepted tradeoff — nothing here rejects or aborts a slow founding.
  // `foundStrand` keeps running and is resumable, so reporting "failed" at a deadline
  // would leave a strand the user believes was never created, and re-enable the button
  // for a second founding. The UI bounds how long the user waits without an
  // explanation (the slow-founding hint after FOUNDING_SLOW_HINT_MS), not how long
  // founding takes. Revisit if founding ever becomes cancellable.
  async function runFounding<T>(
    kind: FoundingKind,
    label: string,
    op: () => Promise<T>,
  ): Promise<FoundingOutcome<T> | null> {
    if (foundingRef.current) {
      console.info(`${label} ignored: another strand creation is still running`);
      return null;
    }
    foundingRef.current = true;
    setFounding({ kind, startedAt: performance.now() });
    try {
      return await traceFounding(label, op);
    } finally {
      foundingRef.current = false;
      setFounding(null);
    }
  }

  const handleCreateStrand = async () => {
    const id = uuid();
    const outcome = await runFounding('open', `[settings] create strand ${id.slice(0, 8)}`,
      () => cadre.createStrand(id));
    if (!outcome) return;
    if (outcome.ok) {
      showAlert('Strand created', `ID: ${id.slice(0, 8)}…`, foundingDetail(outcome));
    } else {
      showAlert('Strand creation failed', String(outcome.error), foundingDetail(outcome));
    }
  };

  // ── Closed strand (trust model) ─────────────────────────────────────────

  const handleCreateClosedStrand = async () => {
    const id = uuid();
    const outcome = await runFounding('closed', `[settings] create closed strand ${id.slice(0, 8)}`,
      () => cadre.createClosedStrandWithInvite(id));
    if (!outcome) return;
    if (outcome.ok) {
      // The invitation stays the whole message so it can be selected and copied as-is.
      showAlert('Closed strand + invite', outcome.value, foundingDetail(outcome));
    } else {
      showAlert('Closed strand failed', String(outcome.error), foundingDetail(outcome));
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
    // `handled`: a tap on a button while the keyboard is up presses it, instead of only
    // dismissing the keyboard (Android swallowed the first Connect tap after typing).
    <ScrollView style={styles.container} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      {/* Node info */}
      <Section title="Node">
        {connected ? (
          <>
            <InfoRow label="Status" value="Connected" color="#4caf50" />
            <InfoRow label="Peer ID" value={cadre.peerId ?? '—'} />
            {/* Owner public key (base64url): share out-of-band for pairing /
                enrollment. Tap to view + select the full key. Read-only; the
                private half never leaves the secure enclave. */}
            <InfoRow
              label="Owner Key"
              value={cadre.ownerPublicKey ?? '—'}
              onPress={
                cadre.ownerPublicKey
                  ? () => showAlert('Owner Public Key', cadre.ownerPublicKey ?? '')
                  : undefined
              }
              testID={TEST_IDS.settings.ownerKeyRow}
            />
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
          <Text style={styles.hint}>
            Optional: paste an enrollment invite (CadreInvite) to pin its
            owner keys as the trust anchor for this seed. A cold node rejects
            a seed signed by another cadre unless its key is pinned. Distinct from
            the closed-strand "Paste invite" below.
          </Text>
          <LabelledInput label="Paste enrollment invite (for trust)" value={enrollInviteInput} onChangeText={setEnrollInviteInput} placeholder="base64url CadreInvite (optional)" multiline testID={TEST_IDS.settings.enrollInviteInput} />
          <Btn label="Apply Seed" onPress={handleApplySeed} disabled={!seedInput.trim()} testID={TEST_IDS.settings.applySeedBtn} />
        </Section>
      )}

      {/* Strand */}
      {connected && (
        <Section title="Strands">
          {[...cadre.strands.entries()].map(([id, s]) => (
            <InfoRow key={id} label={id.slice(0, 8)} value={s.status} />
          ))}
          <Btn
            label={founding?.kind === 'open' ? pendingLabel(foundingElapsedMs) : 'Create Chat Strand'}
            onPress={handleCreateStrand}
            disabled={founding !== null}
            testID={TEST_IDS.settings.createStrandBtn}
          />
          {founding?.kind === 'open' && isSlowFounding(foundingElapsedMs) && <SlowFoundingHint />}
        </Section>
      )}

      {/* Host node (borrow a node from a self-hosted cadre-host) */}
      {connected && (
        <Section title="Host Node">
          <Text style={styles.hint}>
            Ask a machine running cadre-host to lend this cadre an always-on node.
            Enter that host&apos;s address and a grant token its owner issued with
            &quot;cadre-host grant issue&quot;. The host only answers requests from
            itself, so on a phone forward its port with &quot;adb reverse&quot; and use
            a 127.0.0.1 address. Phone and host must be on the same Wi-Fi network.
          </Text>
          <LabelledInput label="Host URL" value={hostUrl} onChangeText={setHostUrl} placeholder="http://127.0.0.1:8088" testID={TEST_IDS.settings.hostUrlInput} />
          <LabelledInput label="Grant token" value={hostToken} onChangeText={setHostToken} placeholder="token from cadre-host grant issue" testID={TEST_IDS.settings.hostTokenInput} />
          <Btn
            label="Request Node"
            onPress={handleRequestHostNode}
            disabled={hostNodeStage !== null || !hostUrl.trim() || !hostToken.trim()}
            testID={TEST_IDS.settings.requestHostNodeBtn}
          />
          {hostNodeStage && (
            <Text style={styles.slowHint} testID={TEST_IDS.settings.hostNodeStage}>
              {HOST_NODE_STAGE_LABEL[hostNodeStage]}
            </Text>
          )}
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
          <Btn
            label={founding?.kind === 'closed' ? pendingLabel(foundingElapsedMs) : 'Create Closed Strand + Invite'}
            onPress={handleCreateClosedStrand}
            disabled={founding !== null}
            testID={TEST_IDS.settings.createClosedStrandBtn}
          />
          {founding?.kind === 'closed' && isSlowFounding(foundingElapsedMs) && <SlowFoundingHint />}
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
            {modal?.detail ? (
              <Text style={styles.modalDetail} testID={TEST_IDS.settings.modalDetail}>{modal.detail}</Text>
            ) : null}
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

function InfoRow({ label, value, color, onPress, testID }: { label: string; value: string; color?: string; onPress?: () => void; testID?: string }) {
  const valueText = (
    <Text style={[styles.value, color ? { color } : null]} numberOfLines={1}>{value}</Text>
  );
  return (
    <View style={styles.row}>
      <Text style={styles.label}>{label}</Text>
      {onPress ? (
        <Pressable style={styles.valuePress} onPress={onPress} testID={testID}>{valueText}</Pressable>
      ) : valueText}
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

function SlowFoundingHint() {
  return (
    <Text style={styles.slowHint}>
      Creating the strand is taking longer than expected. It is still running, and the
      result will appear here when it finishes.
    </Text>
  );
}

/**
 * Milliseconds since `founding` started, re-rendering once a second while one is in
 * progress; 0 when none is. The interval stops when founding settles (`founding`
 * becomes null) and when the screen unmounts.
 */
function useFoundingClock(founding: PendingFounding | null): number {
  const [now, setNow] = useState(() => performance.now());
  useEffect(() => {
    if (!founding) return;
    setNow(performance.now());
    const timer = setInterval(() => setNow(performance.now()), 1000);
    return () => clearInterval(timer);
  }, [founding]);
  return founding ? Math.max(0, now - founding.startedAt) : 0;
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
  valuePress: { flexShrink: 1, flexDirection: 'row', justifyContent: 'flex-end' },
  input: { backgroundColor: '#2a2a3e', color: '#fff', borderRadius: 8, paddingHorizontal: 12, paddingVertical: 8, fontSize: 14 },
  btn: { borderRadius: 8, paddingVertical: 10, alignItems: 'center', marginTop: 8 },
  btnDisabled: { opacity: 0.4 },
  btnText: { color: '#fff', fontWeight: '600', fontSize: 14 },
  slowHint: { color: '#ff9800', fontSize: 12, lineHeight: 17, marginTop: 6 },
  error: { color: '#f44336', textAlign: 'center', marginTop: 12 },
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'center', alignItems: 'center' },
  modalBox: { backgroundColor: '#1e1e2e', borderRadius: 12, padding: 20, width: '85%', maxHeight: '60%' },
  modalTitle: { color: '#fff', fontSize: 16, fontWeight: '700', marginBottom: 12 },
  modalDetail: { color: '#aaa', fontSize: 13, marginTop: -6, marginBottom: 12 },
  modalScroll: { maxHeight: 200, marginBottom: 8 },
  modalMessage: { color: '#ccc', fontSize: 14, lineHeight: 20 },
});

