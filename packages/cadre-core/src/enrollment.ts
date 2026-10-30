import debug from 'debug';
import { generateKeyPair, privateKeyToProtobuf } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import type {
  CreatePeerResult,
  MemberRegistration,
  MemberRegistrationResult
} from './types.js';
import { describeThrown } from './describe-thrown.js';

const log = debug('sereus:cadre:enrollment');

/**
 * Interface for verifying member signatures for strand joining
 */
export interface MemberVerifier {
  /**
   * Verify that the signature is valid for the given member registration
   * @param registration The member registration data
   * @param signature The signature to verify
   * @returns true if signature is valid
   */
  verifyMember(registration: MemberRegistration, signature: string): Promise<boolean>;

  /**
   * Check if the member key is authorized to join the strand
   * (e.g., was invited via FormationInvite)
   */
  isAuthorizedToJoin(strandId: string, memberKey: string): Promise<boolean>;
}

/**
 * Interface for registering members in a strand
 */
export interface MemberRegistry {
  /**
   * Register a member in the strand's member list
   */
  registerMember(strandId: string, memberKey: string, peerIds: string[]): Promise<void>;

  /**
   * Check if a member is already registered in the strand
   */
  isMemberRegistered(strandId: string, memberKey: string): Promise<boolean>;
}

/**
 * Enrollment API for creating peer identities and managing strand membership
 *
 * Peer Creation:
 *   `createCadrePeer()` generates an Ed25519 keypair for a new node.
 *   For cadre peer authorization, use the Seed Bootstrap API instead.
 *
 * Member Registration:
 *   Accept invitations to join strands as a member.
 */
export class EnrollmentService {
  private readonly memberVerifier?: MemberVerifier;
  private readonly memberRegistry?: MemberRegistry;

  constructor(options?: {
    memberVerifier?: MemberVerifier;
    memberRegistry?: MemberRegistry;
  }) {
    this.memberVerifier = options?.memberVerifier;
    this.memberRegistry = options?.memberRegistry;
    log('EnrollmentService created');
  }

  /**
   * Create a new cadre peer identity
   *
   * Generates a new Ed25519 keypair for a cadre node.
   * The private key should be stored securely by the node.
   * The PeerId can be used with the Seed Bootstrap API for authorization.
   */
  async createCadrePeer(): Promise<CreatePeerResult> {
    log('Creating new cadre peer identity');

    // Generate Ed25519 keypair (same as libp2p uses)
    const privateKey = await generateKeyPair('Ed25519');
    const peerId = peerIdFromPrivateKey(privateKey);

    // Export private key as protobuf bytes for storage
    const privateKeyBytes = privateKeyToProtobuf(privateKey);

    log('Created peer with ID: %s', peerId.toString());

    return {
      peerId,
      privateKey: privateKeyBytes
    };
  }

  // ============================================================================
  // Member Registration API
  // ============================================================================

  /**
   * Register a member into a strand.
   *
   * Called by an invited party to accept an invitation and join as a member.
   * The signature proves ownership of the member key.
   *
   * @param registration The member registration data (strandId, key, peerIds)
   * @param signature Signature over the registration proving key ownership
   * @returns Success/failure with optional reason
   */
  async registerMember(
    registration: MemberRegistration,
    signature: string
  ): Promise<MemberRegistrationResult> {
    const { strandId, key, peerIds } = registration;

    log('Registering member %s for strand %s with %d peers', key, strandId, peerIds.length);

    // Check required dependencies
    if (!this.memberVerifier) {
      log('MemberVerifier not configured');
      return { success: false, reason: 'MemberVerifier not configured' };
    }

    if (!this.memberRegistry) {
      log('MemberRegistry not configured');
      return { success: false, reason: 'MemberRegistry not configured' };
    }

    // Verify the signature
    const isValidSignature = await this.memberVerifier.verifyMember(registration, signature);
    if (!isValidSignature) {
      log('Invalid signature for member registration: %s', key);
      return { success: false, reason: 'Invalid signature' };
    }

    // Check if member is authorized to join (e.g., has a valid invitation)
    const isAuthorized = await this.memberVerifier.isAuthorizedToJoin(strandId, key);
    if (!isAuthorized) {
      log('Member %s not authorized to join strand %s', key, strandId);
      return { success: false, reason: 'Not authorized to join strand' };
    }

    // Check if already registered
    const alreadyRegistered = await this.memberRegistry.isMemberRegistered(strandId, key);
    if (alreadyRegistered) {
      log('Member %s already registered in strand %s', key, strandId);
      return { success: false, reason: 'Member already registered' };
    }

    // Register the member
    try {
      await this.memberRegistry.registerMember(strandId, key, peerIds);
      log('Member %s successfully registered in strand %s', key, strandId);
      return { success: true };
    } catch (error) {
      const message = describeThrown(error);
      log('Failed to register member %s: %s', key, message);
      return { success: false, reason: `Registration failed: ${message}` };
    }
  }

  /**
   * Validate a member registration without actually registering
   * Useful for pre-flight checks
   */
  async validateMemberRegistration(
    registration: MemberRegistration,
    signature: string
  ): Promise<{ valid: boolean; reason?: string }> {
    const { strandId, key } = registration;

    if (!this.memberVerifier) {
      return { valid: false, reason: 'MemberVerifier not configured' };
    }

    if (!this.memberRegistry) {
      return { valid: false, reason: 'MemberRegistry not configured' };
    }

    // Verify signature
    const isValidSignature = await this.memberVerifier.verifyMember(registration, signature);
    if (!isValidSignature) {
      return { valid: false, reason: 'Invalid signature' };
    }

    // Check authorization
    const isAuthorized = await this.memberVerifier.isAuthorizedToJoin(strandId, key);
    if (!isAuthorized) {
      return { valid: false, reason: 'Not authorized to join strand' };
    }

    // Check if already registered
    const alreadyRegistered = await this.memberRegistry.isMemberRegistered(strandId, key);
    if (alreadyRegistered) {
      return { valid: false, reason: 'Member already registered' };
    }

    return { valid: true };
  }
}

