/**
 * Settings screen — connect to cadre, join a cadre, apply seed, create strand, add an
 * always-on node.
 */

import { useState, useCallback, useEffect, useRef } from 'react';
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import type { RedeemCadreInvitationResult, RelayReservationStatus } from '@serfab/cadre-core';
import type { NoiseCryptoMode } from '@serfab/cadre-rn/noise-crypto';
import { AddNodeSection } from '../src/add-node-section';
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
import { describeJoinFailure } from '../src/join-failure';
import { defaultNoiseCryptoMode } from '../src/noise-crypto-config';
import { NOISE_CRYPTO_MODES, type PhoneNodeOptions } from '@serfab/cadre-rn/phone-node';
import { resolveRelayAddrs, splitRelayAddrs } from '../src/relay-config';
import { Btn, controlStyles, LabelledInput, Section } from '../src/settings-controls';
import { TEST_IDS } from '../src/test-ids';
import { uuid } from '../src/uuid';

/**
 * Plain-language label for the relay-reservation posture, shown on the connected
 * Node card. `reserved` is the only posture in which this phone has an address a
 * stranger could dial, which is what "Create Closed Strand + Invite" needs.
 */
const RELAY_STATUS_LABEL: Record<RelayReservationStatus, string> = {
  reserved: 'Yes — via relay',
  dialing: 'Reserving a relay slot…',
  retrying: 'No — relay not answering (retrying)',
  error: 'No — relay reservation gave up',
  none: 'No — no relay configured',
};

/**
 * Plain-language label for each Noise crypto mode: the options of the "Connection
 * encryption" choice, and the connected Node card's readout of the running node's mode.
 */
const NOISE_CRYPTO_LABEL: Record<NoiseCryptoMode, string> = {
  symmetric: 'Native, symmetric only',
  full: 'Native, including key exchange',
  off: 'Pure JavaScript',
};

/** The "Joined cadre" alert body: who admitted this phone, and with what standing. */
function joinedCadreMessage(result: RedeemCadreInvitationResult): string {
  const member = result.peerId ?? 'a member';
  const standing = result.grantsOwner ? 'This device is now an owner.' : 'This device is a member, not an owner.';
  return `Admitted by ${member}. ${standing}`;
}

/** What the disconnected Node form shows for each field. */
interface ConnectForm {
  partyId: string;
  bootstrapAddr: string;
  relayAddr: string;
  noiseCryptoMode: NoiseCryptoMode;
}

/**
 * The Node form's starting values: the options the node last started with when the app
 * remembered them, else the build defaults — `EXPO_PUBLIC_RELAY_ADDR` so a build that
 * ships a relay needs no typing, and `EXPO_PUBLIC_NOISE_CRYPTO`, else the kit's
 * `symmetric` (a misspelt env value throws here, naming the three allowed values).
 * A saved empty relay list shows the build default, which is what Connect would use.
 */
function connectFormFrom(saved: PhoneNodeOptions | null): ConnectForm {
  return {
    partyId: saved?.partyId ?? '',
    bootstrapAddr: saved?.bootstrapAddrs.join(', ') ?? '',
    relayAddr: resolveRelayAddrs(saved?.relayAddrs).join(', '),
    noiseCryptoMode: saved?.noiseCryptoMode ?? defaultNoiseCryptoMode(),
  };
}

export default function SettingsScreen() {
  const cadre = useCadre();

  // Computed once on mount — re-resolving per render would fight the user's edits.
  const [initialForm] = useState(() => connectFormFrom(cadre.savedStartOptions));
  const [partyId, setPartyId] = useState(initialForm.partyId);
  const [bootstrapAddr, setBootstrapAddr] = useState(initialForm.bootstrapAddr);
  const [relayAddr, setRelayAddr] = useState(initialForm.relayAddr);
  const [noiseCryptoMode, setNoiseCryptoMode] = useState(initialForm.noiseCryptoMode);
  // The saved options are read once at launch, and that read can resolve after this
  // screen mounted; apply them when it does. The hook sets them exactly once, so this
  // never overwrites an edit made afterwards.
  const { savedStartOptions } = cadre;
  useEffect(() => {
    if (!savedStartOptions) return;
    const form = connectFormFrom(savedStartOptions);
    setPartyId(form.partyId);
    setBootstrapAddr(form.bootstrapAddr);
    setRelayAddr(form.relayAddr);
    setNoiseCryptoMode(form.noiseCryptoMode);
  }, [savedStartOptions]);
  const [seedInput, setSeedInput] = useState('');
  const [cadreInvitationInput, setCadreInvitationInput] = useState('');
  const [peerAddr, setPeerAddr] = useState('');
  const [inviteInput, setInviteInput] = useState('');
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
  const [linkedNodeCode, setLinkedNodeCode] = useLinkedNodeCode();

  const showAlert = useCallback((title: string, message: string, detail?: string) => {
    setModal({ title, message, detail });
  }, []);

  // ── Connect / Disconnect ───────────────────────────────────────────────

  const handleConnect = async () => {
    const pid = partyId.trim() || uuid();
    setPartyId(pid);
    // Comma-separated, like Relay, so a remembered list of several round-trips.
    const addrs = splitRelayAddrs(bootstrapAddr);
    // The typed value wins over the build-time default. Emptying the field asks for
    // that default BACK rather than for "no relay" — `resolveRelayAddrs` falls through
    // to `EXPO_PUBLIC_RELAY_ADDR` — so a build that ships none is the only way to run
    // with none. A malformed entry is rejected by cadre-core at config resolution;
    // `cadre.start` records that as `status: 'error'` plus the red message under this
    // card (it does not throw), so the field can be corrected and Connect retried
    // without a restart.
    const relayAddrs = resolveRelayAddrs(splitRelayAddrs(relayAddr));
    try {
      await cadre.start({ partyId: pid, bootstrapAddrs: addrs, relayAddrs, noiseCryptoMode });
    } catch (err) {
      showAlert('Connection failed', String(err));
    }
  };

  const handleDisconnect = async () => {
    await cadre.stop();
  };

  // ── Seed ───────────────────────────────────────────────────────────────

  // Apply a cold-start seed. The node accepts it only when its anchor already
  // holds the signer's key (see the hint beside the field); the alert on refusal
  // carries the node's own reason.
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

  // ── Join a cadre ──────────────────────────────────────────────────────

  // The field is cleared on success only: a failed join keeps the paste, so the
  // retry the alert may suggest costs no re-paste.
  const handleJoinCadre = async () => {
    const encoded = cadreInvitationInput.trim();
    if (!encoded) return;
    try {
      const result = await cadre.joinCadre(encoded);
      setCadreInvitationInput('');
      showAlert('Joined cadre', joinedCadreMessage(result));
    } catch (err) {
      showAlert('Join failed', describeJoinFailure(err));
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
            <InfoRow label="Party ID" value={cadre.node?.partyId ?? '—'} />
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
            <InfoRow
              label="Encryption"
              value={cadre.noiseCryptoMode ? NOISE_CRYPTO_LABEL[cadre.noiseCryptoMode] : '—'}
              testID={TEST_IDS.settings.noiseCryptoRow}
            />
            <InfoRow label="Reachable" value={RELAY_STATUS_LABEL[cadre.relayStatus]} color={cadre.relayStatus === 'reserved' ? '#4caf50' : '#ff9800'} />
            <Btn label="Disconnect" onPress={handleDisconnect} color="#f44336" testID={TEST_IDS.settings.disconnectBtn} />
          </>
        ) : (
          <>
            <InfoRow label="Status" value={cadre.status} color="#ff9800" />
            <LabelledInput label="Party ID" value={partyId} onChangeText={setPartyId} placeholder="auto-generated if empty" testID={TEST_IDS.settings.partyIdInput} />
            <LabelledInput label="Bootstrap addr" value={bootstrapAddr} onChangeText={setBootstrapAddr} placeholder="/ip4/…/tcp/…/ws/p2p/…" testID={TEST_IDS.settings.bootstrapAddrInput} />
            <LabelledInput label="Relay" value={relayAddr} onChangeText={setRelayAddr} placeholder="/ip4/…/tcp/…/ws/p2p/… (comma-separated)" testID={TEST_IDS.settings.relayAddrInput} />
            <Text style={controlStyles.hint}>
              A phone cannot accept incoming connections, so the only address other
              people can dial it at is one a relay forwards. Without a relay this app
              still works — it just cannot invite anyone into a private chat.
            </Text>
            <NoiseCryptoChoice value={noiseCryptoMode} onChange={setNoiseCryptoMode} />
            <Btn label="Connect" onPress={handleConnect} disabled={cadre.status === 'connecting'} testID={TEST_IDS.settings.connectBtn} />
            {linkedNodeCode !== null && (
              <Text style={controlStyles.slowHint} testID={TEST_IDS.settings.waitingNodeCode}>
                {cadre.status === 'connecting'
                  ? 'A node code is waiting. The prompt to add the node opens once this phone connects.'
                  : 'A node code is waiting. Connect first, and the prompt to add the node opens.'}
              </Text>
            )}
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
          <Text style={controlStyles.hint}>
            A seed only works when this phone already trusts its signer: it founded
            the cadre, or the signer&apos;s key was pinned. To join someone else&apos;s
            cadre, paste a cadre invitation below instead.
          </Text>
          <Btn label="Apply Seed" onPress={handleApplySeed} disabled={!seedInput.trim()} testID={TEST_IDS.settings.applySeedBtn} />
        </Section>
      )}

      {/* Join a cadre (redeem an owner's invitation at one of its members) */}
      {connected && (
        <Section title="Join a Cadre">
          <Text style={controlStyles.hint}>
            Paste an invitation an owner of the cadre issued. Joining pins that
            owner&apos;s keys and admits this phone at one of the members the
            invitation names. Distinct from the closed-strand &quot;Paste invite&quot; below.
          </Text>
          <LabelledInput label="Paste cadre invitation" value={cadreInvitationInput} onChangeText={setCadreInvitationInput} placeholder="base64url cadre invitation" multiline testID={TEST_IDS.settings.cadreInvitationInput} />
          <Btn label="Join cadre" onPress={handleJoinCadre} disabled={!cadreInvitationInput.trim()} testID={TEST_IDS.settings.joinCadreBtn} />
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

      {/* Add an always-on node (claim a cadre-host node by its code) */}
      {connected && (
        <AddNodeSection
          showAlert={showAlert}
          linkedCode={linkedNodeCode}
          onLinkedCodeTaken={() => setLinkedNodeCode(null)}
        />
      )}

      {/* Closed strand (trust model) */}
      {connected && (
        <Section title="Closed Strand (Invite-Only)">
          <Text style={controlStyles.hint}>
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
        <View style={controlStyles.modalOverlay}>
          <View style={controlStyles.modalBox}>
            <Text style={controlStyles.modalTitle} testID={TEST_IDS.settings.modalTitle}>{modal?.title}</Text>
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

function InfoRow({ label, value, color, onPress, testID }: { label: string; value: string; color?: string; onPress?: () => void; testID?: string }) {
  const valueText = (
    <Text style={[styles.value, color ? { color } : null]} numberOfLines={1} testID={onPress ? undefined : testID}>{value}</Text>
  );
  return (
    <View style={styles.row}>
      <Text style={controlStyles.label}>{label}</Text>
      {onPress ? (
        <Pressable style={styles.valuePress} onPress={onPress} testID={testID}>{valueText}</Pressable>
      ) : valueText}
    </View>
  );
}

/**
 * The "Connection encryption" choice. The node reads the mode when it is built, and
 * this form shows only while disconnected, so switching is Disconnect → choose →
 * Connect.
 */
function NoiseCryptoChoice({ value, onChange }: { value: NoiseCryptoMode; onChange: (mode: NoiseCryptoMode) => void }) {
  return (
    <View style={{ marginBottom: 8 }}>
      <Text style={controlStyles.label}>Connection encryption</Text>
      {NOISE_CRYPTO_MODES.map((mode) => (
        <Pressable
          key={mode}
          style={[styles.option, mode === value && styles.optionSelected]}
          onPress={() => onChange(mode)}
          accessibilityRole="radio"
          accessibilityState={{ selected: mode === value }}
          testID={TEST_IDS.settings.noiseCryptoOption(mode)}
        >
          <Text style={styles.optionText}>{NOISE_CRYPTO_LABEL[mode]}</Text>
        </Pressable>
      ))}
      <Text style={controlStyles.hint}>
        Native runs the connection&apos;s encryption in compiled code: symmetric only
        covers the cost paid on every message, and including key exchange also moves
        the connection handshake. Pure JavaScript is the old, slow path, kept to
        reproduce the dropped connections it caused. The node reads this choice when it
        starts; to change it later, Disconnect, choose again, and Connect.
      </Text>
    </View>
  );
}

function SlowFoundingHint() {
  return (
    <Text style={controlStyles.slowHint}>
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

/**
 * A node code opened from another app (`app/+native-intent.tsx` routes it here as the
 * `nodeCode` parameter), held until the add-node section takes it. The parameter is
 * cleared as soon as it is read, so coming back to Settings does not prompt again and
 * the claim secret does not stay in navigation state.
 */
function useLinkedNodeCode(): [string | null, (code: string | null) => void] {
  const { nodeCode } = useLocalSearchParams<{ nodeCode?: string }>();
  const router = useRouter();
  const [code, setCode] = useState<string | null>(null);
  useEffect(() => {
    if (typeof nodeCode !== 'string' || !nodeCode) return;
    setCode(nodeCode);
    router.setParams({ nodeCode: undefined });
  }, [nodeCode, router]);
  return [code, setCode];
}

// ── Styles ─────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0f0f1a' },
  content: { padding: 16 },
  row: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 6 },
  value: { color: '#fff', fontSize: 13, flexShrink: 1, textAlign: 'right' },
  valuePress: { flexShrink: 1, flexDirection: 'row', justifyContent: 'flex-end' },
  option: { backgroundColor: '#2a2a3e', borderRadius: 8, borderWidth: 1, borderColor: '#2a2a3e', paddingHorizontal: 12, paddingVertical: 8, marginBottom: 6 },
  optionSelected: { borderColor: '#6c63ff' },
  optionText: { color: '#fff', fontSize: 14 },
  error: { color: '#f44336', textAlign: 'center', marginTop: 12 },
  modalDetail: { color: '#aaa', fontSize: 13, marginTop: -6, marginBottom: 12 },
  modalScroll: { maxHeight: 200, marginBottom: 8 },
  modalMessage: { color: '#ccc', fontSize: 14, lineHeight: 20 },
});

