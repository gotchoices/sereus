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
  ResolvedHostStrand,
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
  type FormationMode,
  type ResponderProvisionOutcome
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
   * Responder-side provisioning. Routes on how the invite resolves
   * ({@link ResolvedHostStrand}), and can REJECT post-validation by returning a
   * {@link ResponderProvisionOutcome} with `approved: false` — `runSession` turns that
   * into a clean, non-disclosing reply instead of a dropped result frame.
   *
   * - **bound** (host strand present): provision-then-record — write the single
   *   `FormationUsage` consent row against the pre-existing strand (record-only) and
   *   return it + its membership key (a read-gating secret disclosed only here, behind the
   *   token + disclosure validation `runSession` already enforced).
   * - **missing** (invite names a host strand absent on this responder, e.g. unconverged):
   *   reject cleanly + retryably, writing NO usage row — recording usage here would fail the
   *   deferred `StrandExists` CHECK at commit and drop the frame.
   * - **unbound** (no binding): the responder-provisions fallback — see {@link provisionUnbound}.
   *
   * Defense-in-depth: known provisioning/redeem failures (notably the concurrent
   * `(Token, UseNumber)` PK collision when two redemptions of one unbound single-use invite
   * race) are caught and mapped to a logged, retry-suggesting rejection rather than a thrown
   * insert + a silently-closed stream. The LOG-before-reject keeps this a deliberate
   * internal-error→protocol-rejection conversion (AGENTS.md: don't eat exceptions silently),
   * not control-flow-by-exception.
   */
  private async provisionAsResponder(
    token: string,
    initiatorPartyId: string,
    _disclosure: StrandFormationDisclosure
  ): Promise<ResponderProvisionOutcome> {
    const recorder = this.formationUsageRecorder;
    const resolved: ResolvedHostStrand = recorder?.resolveStrand
      ? await recorder.resolveStrand(token)
      : { kind: 'unbound' };

    try {
      switch (resolved.kind) {
        case 'bound': {
          // recorder is guaranteed non-null here: only resolveStrand can yield 'bound'.
          await recorder!.recordUsage(token, initiatorPartyId, resolved.strandId);
          return this.approve({
            strand: { strandId: resolved.strandId, createdBy: 'responder' },
            memberPrivateKey: resolved.memberPrivateKey ?? undefined,
            dbConnectionInfo: { endpoint: 'local', credentialsRef: '' }
          });
        }
        case 'missing': {
          log('Host strand %s not yet available on this responder; rejecting token %s', resolved.strandId, token);
          return { approved: false, reason: 'Host strand not yet available on this responder' };
        }
        case 'unbound':
          return await this.provisionUnbound(token, initiatorPartyId);
      }
    } catch (err) {
      log('provisionAsResponder failed for token %s: %o', token, err);
      return { approved: false, reason: 'Formation conflict, retry' };
    }
  }

  /**
   * Responder-provisions fallback (invite binds no host strand). Precedence:
   *
   * 1. `recorder.provisionAndRecord` present (a real DB recorder) → atomic create-strand +
   *    record-consent, so the unbound redemption is single-use just like the bound path.
   *    Returns the new strand (+ key, null for an open responder-provisioned strand).
   * 2. else `strandProvisioner` present → the legacy/mock contract: provision a bare strand,
   *    NO inline usage write (those callers record usage explicitly via
   *    `recordFormationComplete`, or assert transport invariants only). Threads the invite's
   *    REAL `sAppId`.
   * 3. else → a structural placeholder (no recorder + no provisioner ⇒ no single-use semantics
   *    exist to enforce).
   *
   * Plan tradeoff — option (a) "record usage on the fallback" over (b) "remove the fallback":
   * (a) closes the single-use hole with a targeted atomic create+record and leaves the
   * `StrandProvisioner` mock-transport tests untouched; (b) would delete the provisioner
   * surface and churn ~6 unit + ~6 integration sites for ZERO production benefit (production
   * — `cadre-web.ts` / `cadre-phone.ts` — always publishes strand-BOUND invites and treats
   * the responder-provisions placeholder as failure). The broader "should this fallback exist
   * at all?" question lives in backlog `formation-initiatorcreates-cover-or-remove`.
   */
  private async provisionUnbound(
    token: string,
    initiatorPartyId: string
  ): Promise<ResponderProvisionOutcome> {
    const recorder = this.formationUsageRecorder;
    if (recorder?.provisionAndRecord) {
      const sAppId = await this.resolveInviteSAppId(token);
      const provisioned = await recorder.provisionAndRecord(token, initiatorPartyId, sAppId);
      return this.approve({
        strand: { strandId: provisioned.strandId, createdBy: 'responder' },
        memberPrivateKey: provisioned.memberPrivateKey ?? undefined,
        dbConnectionInfo: { endpoint: 'local', credentialsRef: '' }
      });
    }

    if (this.strandProvisioner) {
      const sAppId = await this.resolveInviteSAppId(token);
      const result = await this.strandProvisioner.provisionStrand(sAppId, initiatorPartyId, this.partyId);
      return this.approve({
        strand: { strandId: result.strandId, createdBy: 'responder' },
        dbConnectionInfo: { endpoint: 'local', credentialsRef: '' }
      });
    }

    // No recorder + no provisioner — a structural placeholder the initiator can still validate.
    const strandId = `strand-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    return this.approve({
      strand: { strandId, createdBy: 'responder' },
      dbConnectionInfo: { endpoint: 'local', credentialsRef: '' }
    });
  }

  /** Wrap a provision result as an approving {@link ResponderProvisionOutcome}. */
  private approve(result: FormationProvisionResult): ResponderProvisionOutcome {
    return { approved: true, result };
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
