import debug from 'debug';
import { fromString as uint8ArrayFromString } from 'uint8arrays';
import type { Libp2p } from '@libp2p/interface';
import type {
  OpenInvitation,
  FormStrandResult,
  StrandFormationDisclosure
} from './types.js';
import {
  FormationApprovalError,
  type FormationApprovalFailure
} from './formation-approval.js';
// control-database does not import this manager, so this import introduces no cycle.
import { FormationAbortedError, InvitationExhaustedError } from './control-database.js';
import { canonicalJson } from './canonical-json.js';
import type {
  DisclosureValidator,
  FormationUsageRecorder,
  ResolvedHostStrand,
  StrandProvisioner,
  FormationResponseValidator
} from './strand-solicitation.js';
import {
  FormationListener,
  INVALID_TOKEN_REASON,
  PROVISION_RESPONSE_TRAVEL_MARGIN_MS,
  dialFormation,
  isValidResponderCreatesResult,
  type FormationContactMessage,
  type FormationProvisionResult,
  type FormationResultMessage,
  type ResponderProvisionOutcome
} from './strand-formation-protocol.js';

const log = debug('sereus:cadre:formation-manager');

/**
 * Largest serialized disclosure a responder will accept (8 KiB). The disclosure is
 * attacker-influenced text destined for a replicated table (`FormationUsage.Disclosure`)
 * and for the approval hook's signed digest — the cap bounds both, and is enforced BEFORE
 * any database read or hook contact so an oversized blob costs nothing downstream.
 */
const MAX_DISCLOSURE_BYTES = 8 * 1024;

/**
 * Rejection reason a would-be joiner is told for each approval-failure category
 * (see {@link FormationApprovalFailure}). Distinct per category on purpose: mapping any
 * of these onto the generic 'Formation conflict, retry' would tell an operator to retry
 * what retrying can never fix (e.g. a non-enrolled validation key).
 */
const APPROVAL_REJECTION_REASONS: Record<FormationApprovalFailure, string> = {
  refused: 'Formation approval refused',
  unavailable: 'Formation approval unavailable, retry',
  malformed: 'Formation approval invalid',
  unenrolled: 'Formation approval key is not enrolled',
  misconfigured: 'Formation approval misconfigured'
};

/**
 * Configuration for StrandFormationManager
 */
export interface StrandFormationManagerConfig {
  /** Session timeout in milliseconds */
  sessionTimeoutMs?: number;
  /** Step timeout in milliseconds */
  stepTimeoutMs?: number;
  /**
   * Provisioning budget in milliseconds for the RESPONDER's `provisionStrand` hook call.
   * The initiator's `await-response` wait is derived automatically from this value plus
   * `PROVISION_RESPONSE_TRAVEL_MARGIN_MS` (`strand-formation-protocol.ts`) — never set
   * directly — so the ordering documented there (approval hook < responder provisioning <
   * initiator await-response < session) cannot collapse when this is configured.
   */
  provisionTimeoutMs?: number;
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
      provisionStrand: (contact, signal) =>
        this.provisionAsResponder(contact, signal),
      getResponderIdentity: () => ({ partyId: this.partyId, cadrePeerAddrs: this.cadrePeerAddrs }),
      sessionTimeoutMs: this.config.sessionTimeoutMs,
      stepTimeoutMs: this.config.stepTimeoutMs,
      provisionTimeoutMs: this.config.provisionTimeoutMs,
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
   * real cadre addresses + the joiner's consent (minted and signed by the
   * solicitation layer — this manager only places it on the contact), dials the
   * responder over the native protocol, and validates the responder's result
   * before returning.
   */
  async formStrand(
    invitation: OpenInvitation,
    disclosure: StrandFormationDisclosure,
    consent: { peerKey: string; usageStampId: string; peerSignature: string },
    node: Libp2p
  ): Promise<FormStrandResult> {
    log('Forming strand with invitation token: %s', invitation.token);

    const contact: FormationContactMessage = {
      token: invitation.token,
      partyId: disclosure.partyId ?? this.partyId,
      peerKey: consent.peerKey,
      usageStampId: consent.usageStampId,
      peerSignature: consent.peerSignature,
      disclosure,
      cadrePeerAddrs: this.cadrePeerAddrs
    };

    this.dialerSessions++;
    try {
      const provision = await dialFormation(node, {
        contact,
        responderAddrs: invitation.bootstrap,
        validateResponse: (response) => this.validateResponse(invitation, disclosure, response),
        sessionTimeoutMs: this.config.sessionTimeoutMs,
        stepTimeoutMs: this.config.stepTimeoutMs,
        provisionTimeoutMs: this.initiatorProvisionTimeoutMs(),
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

  /**
   * Derive the initiator's await-response budget from the configured RESPONDER budget —
   * never the same number (see `StrandFormationManagerConfig.provisionTimeoutMs`). Mirrors
   * `resolveProvisionTimeoutMs`'s own "`0`/negative means unset" rule so an unset config
   * still lets both sides fall back to their own independent defaults; must NOT hardcode
   * `DEFAULT_PROVISION_TIMEOUT_MS` here, or the per-role clamping downstream is defeated.
   */
  private initiatorProvisionTimeoutMs(): number | undefined {
    const host = this.config.provisionTimeoutMs;
    return host && host > 0 ? host + PROVISION_RESPONSE_TRAVEL_MARGIN_MS : undefined;
  }

  // ── Responder-side hooks ─────────────────────────────────────────────────────

  private async validateToken(token: string): Promise<{ valid: boolean }> {
    if (!this.formationUsageRecorder) {
      // No recorder configured — accept all tokens.
      return { valid: true };
    }

    const tokenCheck = await this.formationUsageRecorder.isTokenValid(token);
    if (!tokenCheck.valid) {
      log('Token invalid: %s', token);
      return { valid: false };
    }

    if (await this.formationUsageRecorder.isTokenUsed(token)) {
      log('Token already used: %s', token);
      return { valid: false };
    }

    return { valid: true };
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
   * Defense-in-depth: known provisioning/redeem failures are caught and mapped to a logged
   * protocol rejection rather than a thrown insert + a silently-closed stream. The mapping is
   * per-failure, NOT blanket retry-suggesting: an exhausted invitation
   * ({@link InvitationExhaustedError}, raised by `ControlDatabase` whenever a redemption's use
   * number is past the invite's seat budget — including a first attempt racing another
   * redemption of the same token on this node, not only a retry) is reported as `'Invalid
   * token'`, because retrying it can never succeed. The
   * `(Token, UseNumber)` PK collision that concurrent redemptions of one invite used to
   * surface here is now retried a layer down and no longer reaches this method. The
   * LOG-before-reject keeps this a deliberate internal-error→protocol-rejection conversion
   * (AGENTS.md: don't eat exceptions silently), not control-flow-by-exception.
   */
  private async provisionAsResponder(
    contact: FormationContactMessage,
    signal?: AbortSignal
  ): Promise<ResponderProvisionOutcome> {
    const token = contact.token;
    // CANONICALLY serialized — both sides derive the identical string: this is the exact
    // text the joiner signed (consent), the approver signs (vouch), and the recorder writes
    // to `FormationUsage.Disclosure` — a re-serialization anywhere below would break the
    // signature-over-stored-bytes invariant.
    const disclosureText = canonicalJson(contact.disclosure);
    if (uint8ArrayFromString(disclosureText, 'utf8').byteLength > MAX_DISCLOSURE_BYTES) {
      log('Disclosure over %d bytes; rejecting token %s', MAX_DISCLOSURE_BYTES, token);
      return { approved: false, reason: 'Disclosure too large' };
    }

    const recorder = this.formationUsageRecorder;
    const resolved: ResolvedHostStrand = recorder?.resolveStrand
      ? await recorder.resolveStrand(token)
      : { kind: 'unbound' };

    try {
      switch (resolved.kind) {
        case 'bound': {
          // recorder is guaranteed non-null here: only resolveStrand can yield 'bound'.
          await recorder!.recordUsage({
            token,
            peerKey: contact.peerKey,
            peerSignature: contact.peerSignature,
            usageStampId: contact.usageStampId,
            strandId: resolved.strandId,
            disclosure: disclosureText,
            signal
          });
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
          return await this.provisionUnbound(contact, disclosureText, signal);
      }
    } catch (err) {
      if (err instanceof FormationAbortedError) {
        // The listener's timeout path owns the reply for an abandoned provisioning; mapping
        // this onto 'Formation conflict, retry' would misreport it as a conflict.
        throw err;
      }
      if (err instanceof FormationApprovalError) {
        log('approval failed (%s) for token %s: %o', err.failure, token, err);
        return { approved: false, reason: APPROVAL_REJECTION_REASONS[err.failure] };
      }
      if (err instanceof InvitationExhaustedError) {
        // Shares `INVALID_TOKEN_REASON` with the up-front `validateToken` rejection so the loser
        // of the race that exposed the spent invite — same-node, first attempt, or a retry that
        // ran out — sees exactly what a non-racing latecomer sees. No wire-visible distinction between "invalid" and "exhausted" — the
        // operator signal lives in this log line instead.
        // NOTE: if a joining client ever has to tell "never valid" from "used up" WITHOUT node
        // logs, that is a new protocol reason string, not a local change here.
        log(
          'invitation exhausted for token %s: use #%d past limit of %d',
          err.token,
          err.useNumber,
          err.totalUses
        );
        return { approved: false, reason: INVALID_TOKEN_REASON };
      }
      // An approval obtained before landing here is RETRIED, not discarded: the database
      // layer re-presents the same approver sign-off under a fresh use number when it loses
      // one to a writer its local write queue does not serialize — another node of the cadre,
      // another `Database` handle over the same store (see
      // `ControlDatabase.withUseNumberRetry`). Reaching this catch-all means either that retry
      // ran out (surfaced above as `InvitationExhaustedError`) or the failure was never
      // retryable to begin with.
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
    contact: FormationContactMessage,
    disclosureText: string,
    signal?: AbortSignal
  ): Promise<ResponderProvisionOutcome> {
    const token = contact.token;
    const recorder = this.formationUsageRecorder;
    if (recorder?.provisionAndRecord) {
      const sAppId = await this.resolveInviteSAppId(token);
      const provisioned = await recorder.provisionAndRecord({
        token,
        peerKey: contact.peerKey,
        peerSignature: contact.peerSignature,
        usageStampId: contact.usageStampId,
        sAppId,
        disclosure: disclosureText,
        signal
      });
      return this.approve({
        strand: { strandId: provisioned.strandId, createdBy: 'responder' },
        memberPrivateKey: provisioned.memberPrivateKey ?? undefined,
        dbConnectionInfo: { endpoint: 'local', credentialsRef: '' }
      });
    }

    if (this.strandProvisioner) {
      const sAppId = await this.resolveInviteSAppId(token);
      const result = await this.strandProvisioner.provisionStrand(sAppId, contact.partyId, this.partyId);
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
