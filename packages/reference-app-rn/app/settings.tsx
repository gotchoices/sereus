/**
 * Settings screen — connect to cadre, join an existing cadre (the app that recommended this one
 * among them), add a device or app, apply seed, create strand, add an always-on node.
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
import { decodeCadreJoinRequest, type CadreJoinRequest, type RelayReservationStatus } from '@serfab/cadre-core';
import type { SereusApp } from '@serfab/cadre-rn/app-link';
import type { NoiseCryptoMode } from '@serfab/cadre-rn/noise-crypto';
import { AddDeviceSection } from '../src/add-device-section';
import { AddNodeSection } from '../src/add-node-section';
import { useCadre } from '../src/cadre-context';
import { askOwnerAppOrAlert, JoinCadreSection } from '../src/join-cadre-section';
import { answerJoinRequest, isAnswerable, joinResponseAlert } from '../src/join-link';
import type { JoinResponseOutcome } from '../src/use-link-request';
import {
  foundingDetail,
  isSlowFounding,
  pendingLabel,
  traceFounding,
  type FoundingKind,
  type FoundingOutcome,
  type PendingFounding,
} from '../src/founding-progress';
import { defaultNoiseCryptoMode } from '../src/noise-crypto-config';
import { NOISE_CRYPTO_MODES, type PhoneNodeOptions } from '@serfab/cadre-rn/phone-node';
import { resolveRelayAddrs, splitRelayAddrs } from '../src/relay-config';
import { Btn, controlStyles, LabelledInput, Section } from '../src/settings-controls';
import { TEST_IDS } from '../src/test-ids';
import { useRecommendingApp } from '../src/use-recommending-app';
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

type ShowAlert = (title: string, message: string, detail?: string) => void;

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
  // The saved options are read at launch, and that read can resolve after this screen
  // mounted; apply them when it does. The hook also sets them after a join or a dissolve,
  // which switch or restart the node. Each happens while the Connect form is hidden, so
  // this never overwrites an edit.
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
  // Screen state, not saved: until a start is saved the question comes back on the next launch.
  const [firstLaunchAnswer, setFirstLaunchAnswer] = useState<FirstLaunchAnswer | null>(null);

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
  // A join or the old cadre's removal is stopping and starting the node; the join section says how far it got.
  const switching = cadre.status === 'connecting' && cadre.joinFlow !== null;
  // The launch read found no saved start (a founded or joined party saves one), so this app has no cadre yet.
  const noCadreYet = cadre.savedStartRead === 'read' && cadre.savedStartOptions === null;
  // Asked before Connect can found a cadre; a failed launch read is not asked about, its error line explains.
  // `error` too: a first-launch join whose start failed keeps the Yes state and its paste, not the Connect form.
  const asking = noCadreYet && (cadre.status === 'idle' || cadre.status === 'error') && cadre.joinFlow === null;
  const firstLaunchJoin = asking && firstLaunchAnswer === 'join';
  // Called after `asking`, which it reads: a request that arrives while this app has no cadre is answered at once.
  const [linkedRequest, clearLinkedRequest] = useLinkedJoinRequest(showAlert, cadre.identityPeerId, asking, cadre.linkRequestCameBack);
  // Not while the launch read or a start runs: the join would stop a node the hook has not finished showing.
  const startSettled = cadre.savedStartRead !== 'reading' && !(cadre.status === 'connecting' && cadre.joinFlow === null);
  useLinkedJoinResponse(showAlert, cadre.takeJoinResponse, startSettled);
  // A request to join already open, or a join on screen, wins over the app that recommended this one.
  const joinUnderWay = cadre.linkRequest !== null || cadre.joinFlow !== null;
  const recommending = useRecommendingApp(asking, startSettled, joinUnderWay, () => setFirstLaunchAnswer(null));
  const joinThrough = (app: SereusApp) => void askOwnerAppOrAlert(cadre.askOwnerApp, app, showAlert);
  const nodeCodeHint = linkedNodeCode !== null && (
    <Text style={controlStyles.slowHint} testID={TEST_IDS.settings.waitingNodeCode}>
      {cadre.status === 'connecting'
        ? 'A node code is waiting. The prompt to add the node opens once this phone connects.'
        : 'A node code is waiting. Connect first, and the prompt to add the node opens.'}
    </Text>
  );
  const joinRequestHint = linkedRequest !== null && (
    <Text style={controlStyles.slowHint} testID={TEST_IDS.settings.waitingJoinRequest}>
      {cadre.status === 'connecting'
        ? `A join request from ${linkedRequest.appName} is waiting. The prompt to answer it opens once this phone connects.`
        : `A join request from ${linkedRequest.appName} is waiting. Connect first, and the prompt to answer it opens.`}
    </Text>
  );
  const waitingHints = <>{nodeCodeHint}{joinRequestHint}</>;

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
        ) : switching ? (
          <>
            <InfoRow label="Status" value={noCadreYet ? 'Joining your cadre…' : 'Switching cadre…'} color="#ff9800" />
            {waitingHints}
          </>
        ) : cadre.savedStartRead === 'reading' ? (
          <InfoRow label="Status" value={cadre.status} color="#ff9800" />
        ) : asking && firstLaunchAnswer === null ? (
          <>
            {recommending.reading ? (
              <InfoRow label="Status" value={cadre.status} color="#ff9800" />
            ) : recommending.named ? (
              <RecommendedFirstLaunchQuestion
                app={recommending.named}
                onJoin={(app) => {
                  setFirstLaunchAnswer('join');
                  joinThrough(app);
                }}
                onOtherChoices={recommending.dropNamed}
              />
            ) : (
              <FirstLaunchQuestion onAnswer={setFirstLaunchAnswer} />
            )}
            {waitingHints}
          </>
        ) : firstLaunchJoin ? (
          <>
            <InfoRow label="Status" value={cadre.status} color="#ff9800" />
            <Text style={controlStyles.hint}>This app joins your cadre under Join my existing cadre below.</Text>
            <Btn label="Back" onPress={() => setFirstLaunchAnswer(null)} color="#444" testID={TEST_IDS.settings.firstLaunchBackBtn} />
            {waitingHints}
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
            {waitingHints}
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
            the cadre, or the signer&apos;s key was pinned. To join another cadre, use
            Join my existing cadre below instead.
          </Text>
          <Btn label="Apply Seed" onPress={handleApplySeed} disabled={!seedInput.trim()} testID={TEST_IDS.settings.applySeedBtn} />
        </Section>
      )}

      {/* Join my existing cadre; also while a join and what follows it are on screen, whatever the status, and on first launch after Yes */}
      {(connected || cadre.joinFlow !== null || firstLaunchJoin) && <JoinCadreSection showAlert={showAlert} firstLaunch={noCadreYet} />}

      {/* Add a device or app (an owner mints a cadre invitation for another app) */}
      {connected && <AddDeviceSection showAlert={showAlert} linkedRequest={linkedRequest} onLinkedRequestTaken={clearLinkedRequest} />}

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

      <RecommendedJoinPrompt
        app={recommending.suggested}
        onJoin={(app) => {
          recommending.dropSuggested();
          joinThrough(app);
        }}
        onNotNow={recommending.dropSuggested}
      />

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

type FirstLaunchAnswer = 'join' | 'fresh';

/** Asked in place of the Connect form while this app has no cadre, so it never founds one it would then leave. */
function FirstLaunchQuestion({ onAnswer }: { onAnswer: (answer: FirstLaunchAnswer) => void }) {
  return (
    <View>
      <Text style={styles.question}>Do you already use Sereus apps?</Text>
      <Text style={controlStyles.hint}>
        If another Sereus app, on this phone or another device, already holds your cadre,
        this app joins it instead of starting its own.
      </Text>
      <Btn label="Yes, join my cadre" onPress={() => onAnswer('join')} testID={TEST_IDS.settings.firstLaunchJoinBtn} />
      <Btn label="No, start fresh" onPress={() => onAnswer('fresh')} color="#444" testID={TEST_IDS.settings.firstLaunchFreshBtn} />
    </View>
  );
}

/** The first-launch question when another Sereus app recommended this one: join through it, or the plain question. */
function RecommendedFirstLaunchQuestion({ app, onJoin, onOtherChoices }: {
  app: SereusApp;
  onJoin: (app: SereusApp) => void;
  onOtherChoices: () => void;
}) {
  return (
    <View>
      <Text style={styles.question}>{`${app.name} suggested this app. Join the cadre it holds?`}</Text>
      <Text style={controlStyles.hint}>{`This app opens ${app.name} with its request to join, and joins when ${app.name} answers.`}</Text>
      <Btn label={`Join through ${app.name}`} onPress={() => onJoin(app)} testID={TEST_IDS.settings.firstLaunchRecommendedJoinBtn} />
      <Btn label="Other choices" onPress={onOtherChoices} color="#444" testID={TEST_IDS.settings.firstLaunchOtherChoicesBtn} />
    </View>
  );
}

/** Offered when an app that recommended this one opens it while it has a cadre; the system back button is Not now. */
function RecommendedJoinPrompt({ app, onJoin, onNotNow }: {
  app: SereusApp | null;
  onJoin: (app: SereusApp) => void;
  onNotNow: () => void;
}) {
  return (
    <Modal visible={app !== null} transparent animationType="fade" onRequestClose={onNotNow}>
      <View style={controlStyles.modalOverlay}>
        <View style={controlStyles.modalBox}>
          <Text style={controlStyles.modalTitle}>{`${app?.name ?? ''} suggests joining the cadre it holds`}</Text>
          <Text style={controlStyles.promptText}>This app&apos;s chats move into that cadre, and its own cadre is then removed from this phone.</Text>
          <Btn label={`Join through ${app?.name ?? ''}`} onPress={() => app && onJoin(app)} testID={TEST_IDS.settings.recommendedJoinBtn} />
          <Btn label="Not now" onPress={onNotNow} color="#444" testID={TEST_IDS.settings.recommendedNotNowBtn} />
        </View>
      </View>
    </Modal>
  );
}

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

/**
 * A join request another Sereus app on this phone opened this one with (`app/+native-intent.tsx`
 * routes it here as the `joinRequest` parameter), decoded and held until Add a device or app
 * takes it, which it does once the node is connected. The parameter is cleared as soon as it is
 * read, as `useLinkedNodeCode` does.
 *
 * Two cases are settled here, since that section is not mounted in either: this app's own
 * request (`onOwnRequest`: the user picked this app in Android's chooser, or it is the only app
 * there), and any request while this app has no cadre (`noCadre`), answered `no-cadre` when it
 * says where to. A request that does not decode gets no answer: its reply cannot be trusted.
 */
function useLinkedJoinRequest(
  showAlert: ShowAlert,
  identityPeerId: () => Promise<string>,
  noCadre: boolean,
  onOwnRequest: () => void,
): [CadreJoinRequest | null, () => void] {
  const { joinRequest } = useLocalSearchParams<{ joinRequest?: string }>();
  const router = useRouter();
  const [request, setRequest] = useState<CadreJoinRequest | null>(null);

  const hold = async (text: string) => {
    let decoded: CadreJoinRequest;
    try {
      decoded = decodeCadreJoinRequest(text);
    } catch (err) {
      showAlert('Cannot use this request', err instanceof Error ? err.message : String(err));
      return;
    }
    if (await isOwnRequest(decoded, identityPeerId)) {
      onOwnRequest();
      return;
    }
    setRequest(decoded);
  };

  useEffect(() => {
    if (typeof joinRequest !== 'string' || !joinRequest) return;
    router.setParams({ joinRequest: undefined });
    void hold(joinRequest);
  }, [joinRequest, router]);

  useEffect(() => {
    if (!request || !noCadre) return;
    setRequest(null);
    if (isAnswerable(request)) {
      void answerJoinRequest(request, { refused: 'no-cadre' });
    } else {
      showAlert('This app has no cadre yet', `It cannot add ${request.appName}. Copy that app's request into the app that holds your cadre.`);
    }
  }, [request, noCadre]);

  return [request, () => setRequest(null)];
}

/**
 * The answer to this app's own join request, which an owner app on this phone opened this one
 * with (`app/+native-intent.tsx` routes it here as the `joinResponse` parameter). The parameter is
 * cleared as soon as it is read, as `useLinkedNodeCode` does, so the invitation it may carry does
 * not stay in navigation state. Held until `ready`, then taken; the outcome's alert shows from
 * here, since Join my existing cadre may not be mounted.
 */
function useLinkedJoinResponse(
  showAlert: ShowAlert,
  takeJoinResponse: (text: string) => Promise<JoinResponseOutcome>,
  ready: boolean,
): void {
  const { joinResponse } = useLocalSearchParams<{ joinResponse?: string }>();
  const router = useRouter();
  const [response, setResponse] = useState<string | null>(null);

  useEffect(() => {
    if (typeof joinResponse !== 'string' || !joinResponse) return;
    router.setParams({ joinResponse: undefined });
    setResponse(joinResponse);
  }, [joinResponse, router]);

  useEffect(() => {
    if (response === null || !ready) return;
    setResponse(null);
    void takeJoinResponse(response).then((outcome) => {
      const alert = joinResponseAlert(outcome);
      if (alert) showAlert(alert.title, alert.message, alert.detail);
    });
  }, [response, ready, takeJoinResponse, showAlert]);
}

/** Whether this app made `request`. False when the identity cannot be read; Add a device or app checks again against the running node. */
async function isOwnRequest(request: CadreJoinRequest, identityPeerId: () => Promise<string>): Promise<boolean> {
  try {
    return request.peerId === await identityPeerId();
  } catch (err) {
    console.warn('[settings] could not read this app\'s peer id to check a join request:', err);
    return false;
  }
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
  question: { color: '#fff', fontSize: 15, fontWeight: '600', marginBottom: 6 },
  error: { color: '#f44336', textAlign: 'center', marginTop: 12 },
  modalDetail: { color: '#aaa', fontSize: 13, marginTop: -6, marginBottom: 12 },
  modalScroll: { maxHeight: 200, marginBottom: 8 },
  modalMessage: { color: '#ccc', fontSize: 14, lineHeight: 20 },
});

