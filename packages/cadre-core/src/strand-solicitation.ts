import debug from 'debug';
import { toString as uint8ArrayToString } from 'uint8arrays';
import { generateKeyPair, privateKeyToProtobuf } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import type { Libp2p } from '@libp2p/interface';
import type {
  OpenInvitation,
  FormStrandResult,
  ValidateFormationResult,
  StrandFormationDisclosure
} from './types.js';
import {
  StrandFormationManager,
  type StrandFormationManagerConfig
} from './strand-formation-manager.js';
import {
  isValidResponderCreatesResult,
  type FormationResultMessage,
  type FormationDatabaseMessage
} from './strand-formation-protocol.js';

const log = debug('sereus:cadre:solicitation');

/**
 * Interface for validating formation disclosures
 */
export interface DisclosureValidator {
  /**
   * Validate the disclosure provided by an initiator
   * @param token The invitation token
   * @param disclosure The disclosure object from the initiator
   * @returns Whether the disclosure is acceptable
   */
  validateDisclosure(token: string, disclosure: StrandFormationDisclosure): Promise<boolean>;
}

/**
 * Interface for recording formation usage
 */
export interface FormationUsageRecorder {
  /**
   * Record that a formation invite was used
   */
  recordUsage(token: string, initiatorKey: string, strandId: string): Promise<void>;

  /**
   * Check if a token has already been used (for single-use invites)
   */
  isTokenUsed(token: string): Promise<boolean>;

  /**
   * Check if a token is valid and not expired
   */
  isTokenValid(token: string): Promise<{ valid: boolean; invitation?: OpenInvitation }>;
}

/**
 * Interface for strand provisioning during formation
 */
export interface StrandProvisioner {
  /**
   * Provision a new strand after formation is validated
   */
  provisionStrand(
    sAppId: string,
    initiatorKey: string,
    responderKey: string
  ): Promise<{ strandId: string }>;
}

/**
 * Interface for signing formation approvals
 */
export interface FormationSigner {
  /**
   * Sign a formation approval
   */
  signFormation(token: string, disclosure: StrandFormationDisclosure): Promise<{
    validationKey: string;
    validationSignature: string;
  }>;
}

/**
 * Interface for validating the responder's formation result on the initiator side.
 *
 * Symmetric to {@link DisclosureValidator} (which runs responder→initiator): it lets
 * the initiator verify the responder's disclosed identity, cadre, and provisioned
 * strand against the invitation/disclosure it used to form the strand. The manager
 * owns one dialer session per `formStrand` call, so the per-session invitation +
 * disclosure context is local — no hook-signature gymnastics needed.
 */
export interface FormationResponseValidator {
  /** Validate the responder's result against the invitation/disclosure used to form the strand. */
  validateResponse(ctx: {
    invitation: OpenInvitation;
    disclosure: StrandFormationDisclosure;
    response: FormationResultMessage;
  }): Promise<boolean>;
  /** initiatorCreates mode: validate the strand/db result the responder echoes back. */
  validateDatabaseResult?(ctx: {
    invitation: OpenInvitation;
    expected: FormationDatabaseMessage;
    received: unknown;
  }): Promise<boolean>;
}

/**
 * Built-in structural {@link FormationResponseValidator}.
 *
 * `validateResponse` rejects when the responder did not approve, omitted a disclosed
 * identity, returned no/placeholder cadre addresses, or returned a missing/empty or
 * non-responder-created strand (see {@link isValidResponderCreatesResult}).
 * `validateDatabaseResult` confirms the echoed strand id matches what was provisioned.
 * Apps can supply a stricter validator via {@link StrandSolicitationServiceOptions}.
 */
export function createDefaultFormationResponseValidator(): FormationResponseValidator {
  return {
    async validateResponse({ response }) {
      return isValidResponderCreatesResult(response);
    },
    async validateDatabaseResult({ expected, received }) {
      const result = received as FormationDatabaseMessage | null | undefined;
      return !!result?.strand?.strandId && result.strand.strandId === expected.strand.strandId;
    }
  };
}

export interface StrandSolicitationServiceOptions {
  disclosureValidator?: DisclosureValidator;
  formationUsageRecorder?: FormationUsageRecorder;
  strandProvisioner?: StrandProvisioner;
  formationSigner?: FormationSigner;
  /** Validates the responder's result on the initiator side (defaults to a structural check) */
  formationResponseValidator?: FormationResponseValidator;
  /** Party ID for this node (used in protocol messages) */
  partyId?: string;
  /** Cadre peer addresses for this node */
  cadrePeerAddrs?: string[];
  /** Configuration for the formation manager */
  formationConfig?: StrandFormationManagerConfig;
}

/**
 * Strand Solicitation API for forming strands via open invitations.
 *
 * This service handles the high-level API defined in api.md:
 * - formStrand(invitation, disclosure, node) - called by initiator
 * - validateStrandFormation(token, disclosure) - called by responder
 *
 * When a libp2p node is provided, the underlying protocol is handled by the
 * native cadre-core formation transport via StrandFormationManager.
 */
export class StrandSolicitationService {
  private readonly disclosureValidator?: DisclosureValidator;
  private readonly formationUsageRecorder?: FormationUsageRecorder;
  private readonly strandProvisioner?: StrandProvisioner;
  private readonly formationSigner?: FormationSigner;
  private readonly formationResponseValidator?: FormationResponseValidator;
  private readonly partyId: string;
  private readonly cadrePeerAddrs: string[];
  private formationManager?: StrandFormationManager;
  private readonly formationConfig?: StrandFormationManagerConfig;

  constructor(options?: StrandSolicitationServiceOptions) {
    this.disclosureValidator = options?.disclosureValidator;
    this.formationUsageRecorder = options?.formationUsageRecorder;
    this.strandProvisioner = options?.strandProvisioner;
    this.formationSigner = options?.formationSigner;
    this.formationResponseValidator = options?.formationResponseValidator;
    this.partyId = options?.partyId ?? `party-${Date.now()}`;
    this.cadrePeerAddrs = options?.cadrePeerAddrs ?? [];
    this.formationConfig = options?.formationConfig;
    log('StrandSolicitationService created for party: %s', this.partyId);
  }

  /**
   * Get or create the StrandFormationManager.
   * Lazily initialized to allow configuration after construction.
   */
  private getFormationManager(): StrandFormationManager {
    if (!this.formationManager) {
      this.formationManager = new StrandFormationManager({
        disclosureValidator: this.disclosureValidator,
        formationUsageRecorder: this.formationUsageRecorder,
        strandProvisioner: this.strandProvisioner,
        formationResponseValidator: this.formationResponseValidator,
        partyId: this.partyId,
        cadrePeerAddrs: this.cadrePeerAddrs,
        config: this.formationConfig
      });
    }
    return this.formationManager;
  }

  /**
   * Register as a responder on a libp2p node.
   * This enables the node to handle incoming strand formation requests.
   */
  registerResponder(node: Libp2p): void {
    this.getFormationManager().registerResponder(node);
    log('Registered as responder');
  }

  /**
   * Unregister as a responder from a libp2p node.
   */
  unregisterResponder(node: Libp2p): void {
    this.getFormationManager().unregisterResponder(node);
    log('Unregistered as responder');
  }

  /**
   * Form a strand with a responder via an open invitation.
   *
   * Called by the initiator (the party who received an out-of-band invitation).
   * This generates a member key, contacts the responder's cadre, and negotiates
   * strand formation.
   *
   * @param invitation The open invitation (or just token for legacy API)
   * @param disclosure Identity/context information to share with the responder
   * @param node Optional libp2p node for real protocol handling
   * @returns The member key and strand info if successful
   */
  async formStrand(
    invitation: OpenInvitation | string,
    disclosure: StrandFormationDisclosure,
    node?: Libp2p
  ): Promise<FormStrandResult> {
    // Handle legacy API where just token was passed
    const token = typeof invitation === 'string' ? invitation : invitation.token;
    log('Forming strand with token: %s', token);

    // Generate a new keypair for this strand membership
    const privateKey = await generateKeyPair('Ed25519');
    const peerId = peerIdFromPrivateKey(privateKey);
    const privateKeyBytes = privateKeyToProtobuf(privateKey);

    const memberKey = peerId.toString();
    const invitePrivateKey = uint8ArrayToString(privateKeyBytes, 'base64');

    log('Generated member key: %s', memberKey);

    // If we have a full invitation and a node, use the real protocol
    if (typeof invitation !== 'string' && node) {
      log('Using native cadre-core formation transport');
      const result = await this.getFormationManager().formStrand(
        invitation,
        { ...disclosure, partyId: memberKey },
        node
      );
      return {
        memberKey,
        invitePrivateKey,
        strandId: result.strandId
      };
    }

    // Fallback: placeholder strandId (for testing without network)
    log('No node provided, using placeholder strandId');
    const strandId = `strand-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    return {
      memberKey,
      invitePrivateKey,
      strandId
    };
  }

  /**
   * Validate a strand formation request.
   *
   * Called by the responder (the party who created the open invitation) when
   * an initiator contacts them to form a strand. Validates the disclosure
   * and returns a signed approval.
   *
   * @param token The invitation token being used
   * @param disclosure The disclosure from the initiator
   * @returns Validation key and signature if approved
   * @throws If validation fails or token is invalid
   */
  async validateStrandFormation(
    token: string,
    disclosure: StrandFormationDisclosure
  ): Promise<ValidateFormationResult> {
    log('Validating strand formation for token: %s', token);

    // Check token validity
    if (this.formationUsageRecorder) {
      const tokenCheck = await this.formationUsageRecorder.isTokenValid(token);
      if (!tokenCheck.valid) {
        log('Token invalid or expired: %s', token);
        throw new Error('Invalid or expired token');
      }

      // Check if already used (for single-use tokens)
      const isUsed = await this.formationUsageRecorder.isTokenUsed(token);
      if (isUsed) {
        log('Token already used: %s', token);
        throw new Error('Token has already been used');
      }
    }

    // Validate the disclosure
    if (this.disclosureValidator) {
      const isValid = await this.disclosureValidator.validateDisclosure(token, disclosure);
      if (!isValid) {
        log('Disclosure validation failed for token: %s', token);
        throw new Error('Disclosure validation failed');
      }
    }

    // Sign the formation approval
    if (!this.formationSigner) {
      throw new Error('FormationSigner not configured');
    }

    const { validationKey, validationSignature } = await this.formationSigner.signFormation(
      token,
      disclosure
    );

    log('Formation validated, key: %s', validationKey);

    return {
      validationKey,
      validationSignature
    };
  }

  /**
   * Create an open invitation for others to form strands with this party.
   *
   * @param sAppId The sApp to use for formed strands
   * @param expirationMs How long the invitation is valid (ms from now)
   * @param bootstrap Bootstrap addresses for contacting this party's cadre
   * @returns The open invitation to share out-of-band
   */
  async createOpenInvitation(
    sAppId: string,
    expirationMs: number,
    bootstrap: string[]
  ): Promise<OpenInvitation> {
    // Generate a unique token
    const token = `invite-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
    const expiration = new Date(Date.now() + expirationMs);

    log('Created open invitation: %s (expires %s)', token, expiration.toISOString());

    return {
      token,
      sAppId,
      expiration,
      bootstrap
    };
  }

  /**
   * Record that a formation was completed successfully.
   * Called after strand provisioning to track usage.
   */
  async recordFormationComplete(
    token: string,
    initiatorKey: string,
    strandId: string
  ): Promise<void> {
    if (this.formationUsageRecorder) {
      await this.formationUsageRecorder.recordUsage(token, initiatorKey, strandId);
      log('Recorded formation usage: token=%s strand=%s', token, strandId);
    }
  }
}

