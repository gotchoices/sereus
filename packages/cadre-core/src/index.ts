// Core types
export * from './types.js';

// Canonical JSON serialization (shared signing payload format)
export { canonicalJson } from './canonical-json.js';

// Main CadreNode class
export { CadreNode } from './cadre-node.js';

// Control database
export { ControlDatabase, type ControlDatabaseConfig } from './control-database.js';

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

// Seed Bootstrap
export {
  SeedBootstrapService,
  SEED_PROTOCOL,
  type SeedBootstrapConfig,
  type SeedEventCallbacks
} from './seed-bootstrap.js';

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
