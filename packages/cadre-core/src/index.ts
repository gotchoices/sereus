// Core types
export * from './types.js';

// Canonical JSON serialization (shared signing payload format)
export { canonicalJson } from './canonical-json.js';

// Main CadreNode class
export { CadreNode } from './cadre-node.js';

// Control database
export { ControlDatabase, buildAuthorizationMessage, type ControlDatabaseConfig } from './control-database.js';

// Authority key bridge (libp2p Ed25519 -> base64url authority keypair)
export { authorityKeyFromLibp2p, type AuthorityKeyPair } from './authority-key.js';

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
  type StrandProvisioner,
  type FormationSigner,
  type FormationResponseValidator,
  type StrandSolicitationServiceOptions
} from './strand-solicitation.js';

// DB-backed FormationUsageRecorder (reads/writes the real CadreControl tables)
export { ControlFormationUsageRecorder } from './control-formation-recorder.js';

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
  type FormationMode,
  type FormationParty,
  type FormationContactMessage,
  type FormationResultMessage,
  type FormationDatabaseMessage,
  type FormationProvisionResult,
  type FormationStrandInfo,
  type FormationDbConnectionInfo,
  type FormationListenerOptions,
  type FormationDialOptions
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
