// Core types
export * from './types.js';

// Canonical JSON serialization (shared signing payload format)
export { canonicalJson } from './canonical-json.js';

// Main CadreNode class
export { CadreNode } from './cadre-node.js';

// Control database
export { ControlDatabase, MissingHostStrandError, buildAuthorizationMessage, formationVouchMessage, formationConsentMessage, type ControlDatabaseConfig, type ControlTable, type RevocableTable, type FormationUsageResult, type MembershipChangeListener } from './control-database.js';

// Bounded retry for transient control-write failures (classifier + loop behind
// ControlDatabase.lockedWithRetry; exported so the integration package can drive the
// classifier against real engine errors)
export {
  CONTROL_WRITE_ATTEMPTS,
  CONTROL_WRITE_RETRY_BUDGET_MS,
  isRetriableControlWriteFailure,
  retryControlWrite,
  type ControlWriteRetryOptions
} from './control-write-retry.js';

// Control-plane authorization field vector (the domain/action tagging every signer shares)
export { controlAuthorizationFields, type ControlDomain, type ControlAction } from './control-authorization.js';

// Ed25519 key bridge (libp2p Ed25519 -> base64url keypair)
export { ed25519KeyPairFromLibp2p, ed25519PublicKeyFromPrivate, requireEd25519PublicKeyB64, type Ed25519KeyPair } from './ed25519-key.js';

// Pluggable key store (backend-agnostic identity/owner key material seam).
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

// Node-local trusted-owner anchor: the NON-replicated, per-party record of
// out-of-band-established owner keys (the trust anchor the replicated OwnerKey
// table cannot be). Cross-platform: interface + in-memory store only — the
// file-backed store is the Node-only subpath
// '@serfab/cadre-core/trusted-owner-store-file' (same isolation as
// key-store-file) so node:fs never lands in this graph.
export {
  MemoryTrustedOwnerStore,
  PersistentTrustedOwnerStore,
  type TrustedOwnerStore,
  type TrustSource
} from './trusted-owner-store.js';

// The one platform-specific piece of a persistent node-local store: a single
// durable text slot the embedding app supplies (IndexedDB / SecureStore /
// SQLite / a file). Everything else — envelope, load policy, snapshot write
// chain — is cross-platform in node-local-snapshot.ts.
export type { DurableSlot } from './node-local-snapshot.js';

// Node-local cold-start bootstrap-peer store: the dial targets retained from an
// applied seed so a node that could not connect on its first try keeps retrying
// across restarts. Same cross-platform split as the trusted-owner anchor above —
// interface + in-memory store here, Node-only file backend behind the subpath
// '@serfab/cadre-core/bootstrap-peer-store-file'.
export {
  MemoryBootstrapPeerStore,
  PersistentBootstrapPeerStore,
  type BootstrapPeerStore,
  type BootstrapPeerEntry
} from './bootstrap-peer-store.js';

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
  type FormationResponseValidator,
  type StrandSolicitationServiceOptions
} from './strand-solicitation.js';

// Formation approval client: asks an invite's ValidationUrl hook whether ONE redemption
// may proceed, and checks the answer against the bytes the control database will verify.
export {
  createHttpFormationApprover,
  signFormationApproval,
  verifyFormationApproval,
  FormationApprovalError,
  type FormationApprovalRequest,
  type FormationVouchFields,
  type FormationApproval,
  type FormationApprover,
  type FormationApprovalFailure
} from './formation-approval.js';

// DB-backed FormationUsageRecorder (reads/writes the real CadreControl tables)
export { ControlFormationUsageRecorder } from './control-formation-recorder.js';

// Closed-strand member key generation (ed25519 protobuf, base64) + the
// protobuf->base64url bridge that derives the founding Member/Manager key.
export { generateStrandMemberKey, strandMemberKeyPair } from './strand-member-key.js';

// Strand membership writer (founder bootstrap, invite issuance/consumption,
// manager-admit, member-peer registration, manager rotation, + shared signing
// primitives reused across the flows).
export {
  signStrandPayload,
  verifyStrandPayload,
  signStrandApproval,
  generateStrandStampId,
  bootstrapFounderMembership,
  issueInvite,
  consumeInvite,
  cancelInvite,
  listOutstandingInvites,
  addMemberByManager,
  revokeMember,
  leaveStrand,
  registerMemberPeer,
  listMemberPeers,
  removeMemberPeer,
  addManager,
  admitManager,
  removeManager,
  STRAND_ENGINE,
  STRAND_ENGINE_VERSION,
  type FounderBootstrapParams,
  type IssueInviteParams,
  type IssuedInvite,
  type ConsumeInviteParams,
  type CancelInviteParams,
  type OutstandingInvite,
  type AddMemberByManagerParams,
  type RevokeMemberParams,
  type LeaveStrandParams,
  type RegisterMemberPeerParams,
  type RemoveOwnPeerParams,
  type RemoveMemberPeerByManagerParams,
  type RemoveMemberPeerParams,
  type AddManagerParams,
  type AdmitManagerParams,
  type RemoveManagerParams
} from './strand-membership-writer.js';

// Engine-canonical datetime helper (shared by control + strand signed-write flows
// so a signed timestamp byte-matches the datetime-coerced column the CHECK sees).
export { canonicalDatetime } from './canonical-datetime.js';

// Strand-DB-backed EnrollmentService backing: concrete MemberRegistry +
// MemberVerifier that write/read the real Strand.* membership tables.
export {
  StrandMemberRegistry,
  StrandMemberVerifier,
  memberRegistrationPayload,
  type StrandAdmission
} from './strand-member-registry.js';

// Seed Bootstrap
export {
  SeedBootstrapService,
  SEED_PROTOCOL,
  ed25519PublicKeyB64FromPeerId,
  type SeedBootstrapConfig,
  type SeedEventCallbacks
} from './seed-bootstrap.js';

// Peer Authorization (shared owner-signature digest + offline verifier)
export {
  peerAuthorizationDigest,
  cadrePeerVoucherDigest,
  cadrePeerRemoveDigest,
  deviceTokenAddDigest,
  deviceTokenRemoveDigest,
  formationConsentDigest,
  verifyPeerAuthorization,
  verifyCadrePeerVoucher,
  verifyFormationConsent,
  type DeviceTokenAuthorizedRow
} from './peer-authorization.js';

// Strand Wake (control-network push-wake protocol)
export {
  StrandWakeService,
  dialWake,
  WAKE_PROTOCOL,
  type StrandWakeServiceOptions,
  type DialWakeOptions
} from './strand-wake-protocol.js';

// Strand Address (control-network strand-address RPC) — wire types come via
// `export * from './types.js'` (StrandAddrRequest / StrandAddrResponse).
export {
  StrandAddrService,
  collectStrandAddrs,
  STRAND_ADDR_PROTOCOL,
  type StrandAddrServiceOptions,
  type StrandAddrPeer,
  type CollectStrandAddrsOptions
} from './strand-addr-protocol.js';

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

// Platform push delivery — the cross-platform `PushNotifier` *contract* only.
// The FCM/APNs implementations (node:http2/node:crypto) and the
// `createPushNotifier` router that builds them live behind the Node-only subpath
// `@serfab/cadre-core/push-node` (`push-node.ts`), never in this graph. A Node
// host constructs a notifier from that subpath and injects the instance into
// `CadreNodeConfig.push.notifier`. These re-exports are type-only (erased at
// emit), so the RN/browser entry graph never pulls the Node modules in.
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

// Control-cohort dial selection (backbone-preferential, bounded out-degree) +
// the cadence/degree defaults the proactive reconcile routine reads.
export {
  selectControlCohortDials,
  DEFAULT_CONTROL_COHORT_RECONCILE_MS,
  DEFAULT_CONTROL_COHORT_TARGET_DEGREE,
  type ControlCohortSelection
} from './control-cohort.js';

// Seed trust policy (trust anchor for incoming seeds)
export {
  anchoredTrustPolicy,
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

// Control-network inbound connection gate (membership defense-in-depth)
export {
  createMembershipConnectionGater,
  STRANGER_OPEN_PROTOCOLS,
  DEFAULT_ENROLLMENT_WINDOW_MS,
  ADMISSION_DECISION_TIMEOUT_MS,
  type InboundAdmissionPolicy
} from './membership-connection-gater.js';

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
