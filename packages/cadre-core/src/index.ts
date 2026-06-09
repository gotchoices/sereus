// Core types
export * from './types.js';

// Canonical JSON serialization (shared signing payload format)
export { canonicalJson } from './canonical-json.js';

// Main CadreNode class
export { CadreNode } from './cadre-node.js';

// Control database
export { ControlDatabase, buildAuthorizationMessage, type ControlDatabaseConfig, type ControlTable } from './control-database.js';

// Authority key bridge (libp2p Ed25519 -> base64url authority keypair)
export { authorityKeyFromLibp2p, authorityPublicKeyFromPrivate, type AuthorityKeyPair } from './authority-key.js';

// Pluggable key store (backend-agnostic identity/authority key material seam).
// Dependency-free: the interface, error, default slot id, and in-memory backend
// are safe in every (RN/browser/Node) entry graph. The Node FileKeyStore is a
// separate subpath module ('@serfab/cadre-core/key-store-file') so its node:fs
// import never lands here.
export {
  InMemoryKeyStore,
  KeyStoreAccessError,
  DEFAULT_IDENTITY_KEY_ID,
  type KeyStore,
  type KeyId
} from './key-store.js';

// Strand database
export { StrandDatabase, type StrandDatabaseConfig } from './strand-database.js';

// Strand management
export {
  StrandWatcher,
  type StrandWatcherCallbacks,
  type StrandQueryable,
  type SAppIdLookup,
  type StrandRowWithApp
} from './strand-watcher.js';
export {
  StrandInstanceManager,
  type StartStrandConfig,
  type ResumeStrandOverrides,
  getStrandStoragePath
} from './strand-instance-manager.js';

// Hibernation
export {
  HibernationManager,
  type HibernationCallbacks
} from './hibernation-manager.js';

// Arachnode (stub)
export {
  ArachnodeStub,
  createArachnodeStub,
  type RingConfig
} from './arachnode-stub.js';

// Enrollment
export {
  EnrollmentService,
  type MemberVerifier,
  type MemberRegistry
} from './enrollment.js';

// Strand Solicitation
export {
  StrandSolicitationService,
  createDefaultFormationResponseValidator,
  type DisclosureValidator,
  type FormationUsageRecorder,
  type ResolvedHostStrand,
  type StrandProvisioner,
  type FormationSigner,
  type FormationResponseValidator,
  type StrandSolicitationServiceOptions
} from './strand-solicitation.js';

// DB-backed FormationUsageRecorder (reads/writes the real CadreControl tables)
export { ControlFormationUsageRecorder } from './control-formation-recorder.js';

// Closed-strand member key generation (ed25519 protobuf, base64)
export { generateStrandMemberKey } from './strand-member-key.js';

// Seed Bootstrap
export {
  SeedBootstrapService,
  SEED_PROTOCOL,
  ed25519PublicKeyB64FromPeerId,
  type SeedBootstrapConfig,
  type SeedEventCallbacks
} from './seed-bootstrap.js';

// Peer Authorization (shared authority-signature digest + offline verifier)
export {
  peerAuthorizationDigest,
  verifyPeerAuthorization
} from './peer-authorization.js';

// Strand Wake (control-network push-wake protocol)
export {
  StrandWakeService,
  dialWake,
  WAKE_PROTOCOL,
  type StrandWakeServiceOptions,
  type DialWakeOptions
} from './strand-wake-protocol.js';

// Peer-address record (self-published, signed, freshness-stamped CadrePeer row)
export {
  peerRecordSignedPayload,
  signPeerRecord,
  verifyPeerRecordSignature,
  isPeerRecordFresh,
  isSignalingAddr,
  orderSignalingFirst,
  currentMemberTrustPolicy,
  DEFAULT_PEER_RECORD_MAX_AGE_MS,
  DEFAULT_PEER_RECORD_HEARTBEAT_MS
} from './peer-record.js';

// Device-token record (self-published, signed FCM/APNs push token — CadrePeer sibling)
export {
  deviceTokenSignedPayload,
  signDeviceTokenRecord,
  verifyDeviceTokenSignature,
  isPushPlatform
} from './device-token.js';

// Strand-wake payload contract (canonical; shared by the server sender + RN receiver)
export { STRAND_WAKE_TYPE, type StrandWakePayload } from './strand-wake-payload.js';

// Platform push delivery — server-only PushNotifier (FCM HTTP v1 / APNs HTTP/2).
// TYPES ONLY here: the implementations import node:http2/node:crypto and are
// constructed solely by `CadreNode.start` (via a guarded dynamic import) when
// push credentials are configured. A type-only re-export is erased at emit, so the
// cross-platform (RN/browser) entry graph never pulls these modules in.
// `createPushNotifier` is imported directly from './push-notifier.js' only by that
// dynamic import, never re-exported as a runtime value.
export type { PushNotifier, PushMessage, PushSendResult } from './push-notifier.js';

// Push-credential validation + log redaction. Dependency-free (type-only imports),
// so a provisioner (cadre-host / cadre-provider) can reject a partial credential
// set and produce a key-safe log view without pulling the FCM/APNs sender graph.
export { validatePushCredentials, redactPushCredentials, REDACTED } from './push-credentials.js';

// Server-side push-wake trigger policy + fan-out (who/when to wake). Cross-platform
// clean — it imports only the PushNotifier *type*, so exporting it as a runtime
// value pulls no node:http2/node:crypto edge into the RN/browser graph.
export {
  PushFanoutService,
  DEFAULT_PUSH_COOLDOWN_MS,
  DEFAULT_PUSH_DEBOUNCE_MS,
  type PushFanoutOptions,
  type FanoutMember
} from './push-fanout.js';

// Seed trust policy (trust anchor for incoming seeds)
export {
  dbAnchoredTrustPolicy,
  pinnedKeyTrustPolicy,
  tofuTrustPolicy,
  type SeedTrustPolicy,
  type SeedTrustContext,
  type SeedTrustDecision
} from './seed-trust-policy.js';

// Schema Verification
export {
  signSchema,
  verifySchema,
  assertSchemaSignature,
  SchemaVerificationError
} from './schema-verification.js';

// Strand Formation transport (native cadre-core protocol)
export {
  FormationListener,
  dialFormation,
  isValidResponderCreatesResult,
  FORMATION_PROTOCOL,
  type FormationParty,
  type FormationContactMessage,
  type FormationResultMessage,
  type FormationProvisionResult,
  type FormationStrandInfo,
  type FormationDbConnectionInfo,
  type FormationListenerOptions,
  type FormationDialOptions,
  type ResponderProvisionOutcome
} from './strand-formation-protocol.js';

// Strand Formation manager (drives the native transport)
export {
  StrandFormationManager,
  createStrandFormationManager,
  type StrandFormationManagerConfig,
  type StrandFormationManagerOptions
} from './strand-formation-manager.js';

// Connection-path diagnostics (relayed vs direct classification + summary)
export {
  classifyTransport,
  classifyConnectionPath,
  summarizeConnectionPaths,
  emptyConnectionPathSummary,
  DEFAULT_SETTLE_WINDOW_MS,
  type ConnectionPathKind,
  type ConnectionTransport,
  type ConnectionPath,
  type ConnectionPathSummary,
  type ConnectionLike
} from './diagnostics/connection-path.js';
