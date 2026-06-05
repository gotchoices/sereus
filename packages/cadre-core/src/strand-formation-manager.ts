import debug from 'debug';
import type { Libp2p } from '@libp2p/interface';
import type {
  OpenInvitation,
  FormStrandResult,
  StrandFormationDisclosure
} from './types.js';
import type {
  DisclosureValidator,
  FormationUsageRecorder,
  StrandProvisioner,
  FormationResponseValidator
} from './strand-solicitation.js';
import {
  FormationListener,
  dialFormation,
  isValidResponderCreatesResult,
  type FormationContactMessage,
  type FormationProvisionResult,
  type FormationResultMessage,
  type FormationMode
} from './strand-formation-protocol.js';

const log = debug('sereus:cadre:formation-manager');

/**
 * Configuration for StrandFormationManager
 */
export interface StrandFormationManagerConfig {
  /** Session timeout in milliseconds */
  sessionTimeoutMs?: number;
  /** Step timeout in milliseconds */
  stepTimeoutMs?: number;
  /** Maximum concurrent sessions */
  maxConcurrentSessions?: number;
  /** Enable debug logging */
  enableDebugLogging?: boolean;
  /** Protocol ID override */
  protocolId?: string;
}

/**
 * Options for creating a StrandFormationManager
 */
export interface StrandFormationManagerOptions {
  /** Validates disclosures from initiators (responder side) */
  disclosureValidator?: DisclosureValidator;
  /** Records and validates token usage (responder side) */
  formationUsageRecorder?: FormationUsageRecorder;
  /** Provisions strands after validation (responder side) */
  strandProvisioner?: StrandProvisioner;
  /** Validates the responder's result (initiator side); defaults to a structural check */
  formationResponseValidator?: FormationResponseValidator;
  /** This party's ID for identification */
  partyId: string;
  /** This party's cadre peer addresses */
  cadrePeerAddrs?: string[];
  /** Configuration options */
  config?: StrandFormationManagerConfig;
}

/**
 * StrandFormationManager drives the native cadre-core formation transport
 * (`strand-formation-protocol.ts`) from cadre-core's strand-solicitation interfaces.
 *
 * Responder side: a {@link FormationListener} wires the inbound protocol to
 * {@link FormationUsageRecorder} (token), {@link DisclosureValidator} (identity),
 * and {@link StrandProvisioner} (provisioning), disclosing this party's real
 * identity + cadre only after validation.
 *
 * Initiator side: {@link formStrand} dials the responder carrying the real
 * disclosure/token/cadre, then validates the responder's result via the
 * {@link FormationResponseValidator} (or a built-in structural check).
 */
export class StrandFormationManager {
  private readonly disclosureValidator?: DisclosureValidator;
  private readonly formationUsageRecorder?: FormationUsageRecorder;
  private readonly strandProvisioner?: StrandProvisioner;
  private readonly formationResponseValidator?: FormationResponseValidator;
  private readonly partyId: string;
  private readonly cadrePeerAddrs: string[];
  private readonly config: StrandFormationManagerConfig;
  private readonly listener: FormationListener;
  private readonly registeredNodes = new Set<Libp2p>();
  private dialerSessions = 0;

  constructor(options: StrandFormationManagerOptions) {
    this.disclosureValidator = options.disclosureValidator;
    this.formationUsageRecorder = options.formationUsageRecorder;
    this.strandProvisioner = options.strandProvisioner;
    this.formationResponseValidator = options.formationResponseValidator;
    this.partyId = options.partyId;
    this.cadrePeerAddrs = options.cadrePeerAddrs ?? [];
    this.config = options.config ?? {};

    this.listener = new FormationListener({
      validateToken: (token) => this.validateToken(token),
      validateDisclosure: (token, disclosure) => this.validateDisclosure(token, disclosure),
      provisionStrand: (token, initiatorPartyId, disclosure) =>
        this.provisionAsResponder(token, initiatorPartyId, disclosure),
      getResponderIdentity: () => ({ partyId: this.partyId, cadrePeerAddrs: this.cadrePeerAddrs }),
      sessionTimeoutMs: this.config.sessionTimeoutMs,
      stepTimeoutMs: this.config.stepTimeoutMs,
      maxConcurrentSessions: this.config.maxConcurrentSessions
    });

    log('StrandFormationManager created for party: %s', this.partyId);
  }

  /**
   * Register this manager as a protocol handler on a libp2p node.
   * Call this on the control network node to handle incoming formation requests.
   */
  registerResponder(node: Libp2p, protocolId?: string): void {
    if (this.registeredNodes.has(node)) {
      log('Node already registered');
      return;
    }
    this.listener.register(node, protocolId ?? this.config.protocolId);
    this.registeredNodes.add(node);
    log('Registered as responder on node');
  }

  /**
   * Unregister the protocol handler from a libp2p node.
   */
  unregisterResponder(node: Libp2p, protocolId?: string): void {
    if (!this.registeredNodes.has(node)) {
      return;
    }
    this.listener.unregister(node, protocolId ?? this.config.protocolId);
    this.registeredNodes.delete(node);
    log('Unregistered from node');
  }

  /**
   * Form a strand with a responder via an open invitation (initiator side).
   *
   * Builds a contact message carrying the real token + disclosure + this party's
   * real cadre addresses, dials the responder over the native protocol, and
   * validates the responder's result before returning.
   */
  async formStrand(
    invitation: OpenInvitation,
    disclosure: StrandFormationDisclosure,
    node: Libp2p
  ): Promise<FormStrandResult> {
    log('Forming strand with invitation token: %s', invitation.token);

    const contact: FormationContactMessage = {
      token: invitation.token,
      partyId: disclosure.partyId ?? this.partyId,
      disclosure,
      cadrePeerAddrs: this.cadrePeerAddrs
    };

    this.dialerSessions++;
    try {
      const provision = await dialFormation(node, {
        contact,
        responderAddrs: invitation.bootstrap,
        mode: 'responderCreates',
        validateResponse: (response) => this.validateResponse(invitation, disclosure, response),
        sessionTimeoutMs: this.config.sessionTimeoutMs,
        stepTimeoutMs: this.config.stepTimeoutMs,
        protocolId: this.config.protocolId
      });

      log('Strand formed: %s', provision.strand.strandId);

      return {
        memberKey: contact.partyId,
        invitePrivateKey: '',
        strandId: provision.strand.strandId,
        // The host strand's membership key, delivered through the protocol (provision-then-record).
        // Undefined for an open strand. Kept separate from invitePrivateKey (the initiator's
        // generated signing key), which is set by the StrandSolicitationService layer.
        memberPrivateKey: provision.memberPrivateKey
      };
    } finally {
      this.dialerSessions--;
    }
  }

  /**
   * Get the number of active sessions
   */
  getActiveSessionCounts(): { listeners: number; dialers: number } {
    return { listeners: this.listener.activeCount, dialers: this.dialerSessions };
  }

  // ── Responder-side hooks ─────────────────────────────────────────────────────

  private async validateToken(token: string): Promise<{ valid: boolean; mode: FormationMode }> {
    const mode: FormationMode = 'responderCreates';
    if (!this.formationUsageRecorder) {
      // No recorder configured — accept all tokens.
      return { valid: true, mode };
    }

    const tokenCheck = await this.formationUsageRecorder.isTokenValid(token);
    if (!tokenCheck.valid) {
      log('Token invalid: %s', token);
      return { valid: false, mode };
    }

    if (await this.formationUsageRecorder.isTokenUsed(token)) {
      log('Token already used: %s', token);
      return { valid: false, mode };
    }

    return { valid: true, mode };
  }

  private async validateDisclosure(token: string, disclosure: StrandFormationDisclosure): Promise<boolean> {
    if (!this.disclosureValidator) {
      // No validator configured — accept all disclosures.
      return true;
    }
    return this.disclosureValidator.validateDisclosure(token, disclosure);
  }

  /**
   * Responder-side provisioning. Two paths, selected by whether the invite binds a
   * host strand:
   *
   * 1. **Provision-then-record** (invite carries a `StrandId`): the host strand already
   *    exists, so resolve it via the recorder, write the single `FormationUsage` consent
   *    row against it (record-only), and return that strand + its membership key. The
   *    key is a read-gating secret disclosed only here — `runSession` already gated this
   *    call behind token + disclosure validation.
   * 2. **Responder-provisions** fallback (no binding): provision a NEW strand via the
   *    wired {@link StrandProvisioner}, threading the invite's REAL `sAppId` (no longer
   *    `''`), or a structural placeholder when no provisioner is wired.
   */
  private async provisionAsResponder(
    token: string,
    initiatorPartyId: string,
    _disclosure: StrandFormationDisclosure
  ): Promise<FormationProvisionResult> {
    const recorder = this.formationUsageRecorder;
    if (recorder?.resolveStrand) {
      const resolved = await recorder.resolveStrand(token);
      if (resolved) {
        // Write the single FormationUsage consent row against the pre-existing host strand.
        await recorder.recordUsage(token, initiatorPartyId, resolved.strandId);
        return {
          strand: { strandId: resolved.strandId, createdBy: 'responder' },
          memberPrivateKey: resolved.memberPrivateKey ?? undefined,
          dbConnectionInfo: { endpoint: 'local', credentialsRef: '' }
        };
      }
    }

    if (!this.strandProvisioner) {
      // No provisioner — return a structural placeholder the initiator can still validate.
      const strandId = `strand-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      return {
        strand: { strandId, createdBy: 'responder' },
        dbConnectionInfo: { endpoint: 'local', credentialsRef: '' }
      };
    }

    const sAppId = await this.resolveInviteSAppId(token);
    const result = await this.strandProvisioner.provisionStrand(sAppId, initiatorPartyId, this.partyId);
    return {
      strand: { strandId: result.strandId, createdBy: 'responder' },
      dbConnectionInfo: { endpoint: 'local', credentialsRef: '' }
    };
  }

  /**
   * The invite's authoritative `sAppId` for the responder-provisions fallback, read back
   * from the recorder's `isTokenValid` invitation (the real `FormationInvite.sAppId`).
   * Empty string when no recorder is wired or the invitation omits it.
   */
  private async resolveInviteSAppId(token: string): Promise<string> {
    if (!this.formationUsageRecorder) return '';
    const check = await this.formationUsageRecorder.isTokenValid(token);
    return check.invitation?.sAppId ?? '';
  }

  // ── Initiator-side result validation ─────────────────────────────────────────

  private async validateResponse(
    invitation: OpenInvitation,
    disclosure: StrandFormationDisclosure,
    response: FormationResultMessage
  ): Promise<boolean> {
    if (this.formationResponseValidator) {
      return this.formationResponseValidator.validateResponse({ invitation, disclosure, response });
    }
    return isValidResponderCreatesResult(response);
  }
}

/**
 * Create a StrandFormationManager with the given options
 */
export function createStrandFormationManager(
  options: StrandFormationManagerOptions
): StrandFormationManager {
  return new StrandFormationManager(options);
}
