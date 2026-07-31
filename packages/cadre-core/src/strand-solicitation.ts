import debug from 'debug';
import { toString as uint8ArrayToString } from 'uint8arrays';
import { generateKeyPair, privateKeyToProtobuf } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import type { Libp2p } from '@libp2p/interface';
import type {
  OpenInvitation,
  FormStrandResult,
  StrandFormationDisclosure
} from './types.js';
import {
  StrandFormationManager,
  type StrandFormationManagerConfig
} from './strand-formation-manager.js';
import {
  isValidResponderCreatesResult,
  type FormationResultMessage
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
 * Discriminated result of resolving the host strand an invite binds to (responder side):
 *
 * - `unbound`: the invite carries no `StrandId` → the responder-provisions path (provision
 *   a NEW strand; legacy/open).
 * - `bound`: the invite names a host strand AND that strand row is present on this responder
 *   → provision-then-record (record consent against it, return it + its membership key).
 * - `missing`: the invite names a host strand but the row is ABSENT on this responder (e.g.
 *   not yet converged) → the manager rejects cleanly rather than recording usage against a
 *   non-existent strand, which would fail the deferred `FormationUsage.StrandExists` CHECK at
 *   commit and drop the result frame.
 *
 * Replaces the older `{ strandId, memberPrivateKey } | null` shape, which conflated `bound`
 * and `missing` (both produced a non-null result whenever the invite had a `StrandId`).
 *
 * The invite's `ValidationUrl` (the outside approval hook) is deliberately NOT surfaced here:
 * the recorder that performs the write reads it itself, so the choice of which hook to trust
 * never travels through a caller.
 */
export type ResolvedHostStrand =
  | { kind: 'unbound' }
  | { kind: 'bound'; strandId: string; memberPrivateKey: string | null }
  | { kind: 'missing'; strandId: string };

/**
 * Interface for recording formation usage
 */
export interface FormationUsageRecorder {
  /**
   * Record that a formation invite was used
   */
  recordUsage(params: {
    token: string;
    /** The joining peer — written to `FormationUsage.PeerId` and inside the approval digest. */
    peerId: string;
    strandId: string;
    /** Exact text to write to `FormationUsage.Disclosure`; the approver signs these bytes. */
    disclosure: string;
    /** Aborted when the caller has given up; observed BEFORE any write so the invite stays unspent. */
    signal?: AbortSignal;
  }): Promise<void>;

  /**
   * Check if a token has already been used (for single-use invites)
   */
  isTokenUsed(token: string): Promise<boolean>;

  /**
   * Check if a token is valid and not expired
   */
  isTokenValid(token: string): Promise<{ valid: boolean; invitation?: OpenInvitation }>;

  /**
   * Resolve the host strand an invite binds to, classifying it as unbound / bound /
   * missing (see {@link ResolvedHostStrand}). Optional: a recorder that does not bind
   * strands omits it, and {@link StrandFormationManager} treats every invite as `unbound`
   * and falls back to its provisioner. Keeping resolution behind this interface keeps the
   * manager DB-agnostic and unit-testable with an in-memory fake.
   */
  resolveStrand?(token: string): Promise<ResolvedHostStrand>;

  /**
   * Provision a NEW strand for an UNBOUND invite and record consent against it
   * ATOMICALLY (single `FormationUsage` row → single-use enforced on the next redemption).
   * Optional: a recorder that only supports provision-then-record omits it, and the
   * manager falls back to its {@link StrandProvisioner}. Mirrors the create-strand-by-consent
   * path the schema's `Strand.AuthorizedInsert` `FormationUsage` branch authorizes. Returns the
   * minted strand id plus its membership key (null for an open responder-provisioned strand).
   */
  provisionAndRecord?(params: {
    token: string;
    /** The joining peer — written to `FormationUsage.PeerId` and inside the approval digest. */
    peerId: string;
    sAppId: string;
    /** Exact text to write to `FormationUsage.Disclosure`; the approver signs these bytes. */
    disclosure: string;
    /** Aborted when the caller has given up; observed BEFORE any write so the invite stays unspent. */
    signal?: AbortSignal;
  }): Promise<{ strandId: string; memberPrivateKey: string | null }>;

  /**
   * Is ANY invitation this recorder knows about unexpired and not fully
   * consumed? Optional: a recorder that cannot enumerate invitations omits it,
   * and only locally-minted invitations hold the connection gate's formation
   * exemption open. Distinct from the per-token {@link isTokenValid} /
   * {@link isTokenUsed} pair — the connection gate has no token to ask about.
   */
  hasOutstandingInvitation?(): Promise<boolean>;
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
}

/**
 * Built-in structural {@link FormationResponseValidator}.
 *
 * `validateResponse` rejects when the responder did not approve, omitted a disclosed
 * identity, returned no/placeholder cadre addresses, or returned a missing/empty or
 * non-responder-created strand (see {@link isValidResponderCreatesResult}).
 * Apps can supply a stricter validator via {@link StrandSolicitationServiceOptions}.
 */
export function createDefaultFormationResponseValidator(): FormationResponseValidator {
  return {
    async validateResponse({ response }) {
      return isValidResponderCreatesResult(response);
    }
  };
}

export interface StrandSolicitationServiceOptions {
  disclosureValidator?: DisclosureValidator;
  formationUsageRecorder?: FormationUsageRecorder;
  strandProvisioner?: StrandProvisioner;
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
 *
 * Outside approval of a redemption (an invite's `ValidationUrl`) is NOT here: it belongs to
 * the redeeming node, which alone mints the nonce the approval is bound to. See
 * `formation-approval.ts`.
 *
 * When a libp2p node is provided, the underlying protocol is handled by the
 * native cadre-core formation transport via StrandFormationManager.
 */
export class StrandSolicitationService {
  private readonly disclosureValidator?: DisclosureValidator;
  private readonly formationUsageRecorder?: FormationUsageRecorder;
  private readonly strandProvisioner?: StrandProvisioner;
  private readonly formationResponseValidator?: FormationResponseValidator;
  private readonly partyId: string;
  private readonly cadrePeerAddrs: string[];
  private formationManager?: StrandFormationManager;
  private readonly formationConfig?: StrandFormationManagerConfig;
  /**
   * Tokens this process has minted (or published), mapped to their expiry
   * epoch-ms — the in-memory half of {@link hasOutstandingInvitation}. Dies with
   * the process, exactly like `CadreNode`'s enrollment window; a token that also
   * reached the durable `FormationInvite` table survives via the recorder.
   *
   * NOTE: pruned only while {@link hasOutstandingInvitation} runs, so a node that
   * mints steadily and never receives an inbound stranger retains every entry for
   * the process's life. Bounded by mint rate today; if a host ever mints at scale,
   * prune on a timer (or cap the map) instead of only on read.
   */
  private readonly mintedInvitations = new Map<string, number>();

  constructor(options?: StrandSolicitationServiceOptions) {
    this.disclosureValidator = options?.disclosureValidator;
    this.formationUsageRecorder = options?.formationUsageRecorder;
    this.strandProvisioner = options?.strandProvisioner;
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
        strandId: result.strandId,
        // Carry the host strand's membership key delivered over the protocol (closed-strand
        // provision-then-record). invitePrivateKey stays the initiator's generated signing key.
        memberPrivateKey: result.memberPrivateKey
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
    this.registerMintedInvitation(token, expiration.getTime());

    log('Created open invitation: %s (expires %s)', token, expiration.toISOString());

    return {
      token,
      sAppId,
      expiration,
      bootstrap
    };
  }

  /**
   * Remember a token this node minted (or published) so
   * {@link hasOutstandingInvitation} can answer "yes" before the durable
   * `FormationInvite` row is readable — or when there is no durable store at
   * all. `expiresAtMs` may be `Number.POSITIVE_INFINITY` for an invitation that
   * never expires.
   */
  registerMintedInvitation(token: string, expiresAtMs: number): void {
    this.mintedInvitations.set(token, expiresAtMs);
    log('Registered minted invitation %s (expires %d)', token, expiresAtMs);
  }

  /**
   * Does this node currently expect a stranger — i.e. is at least one open
   * invitation unexpired and not yet fully consumed? Sole input to the
   * control-network connection gate's formation exemption.
   *
   * Two sources, in order:
   *
   *  1. The local mint registry ({@link registerMintedInvitation}), which is
   *     in-memory and dies with the process. Expired entries are dropped. With
   *     no {@link FormationUsageRecorder} configured there is no consumption
   *     oracle, so an unexpired minted token counts as outstanding by
   *     construction; with one, a token it reports used is deleted (consumption
   *     is permanent, so the registry never reconsiders it).
   *  2. The recorder's optional {@link FormationUsageRecorder.hasOutstandingInvitation},
   *     which survives restarts and sees invitations replicated in from siblings.
   *
   * Re-entrant: concurrent inbound connections each call this independently and
   * the only mutation is deleting expired/consumed entries, which is monotonic.
   */
  async hasOutstandingInvitation(): Promise<boolean> {
    const now = Date.now();
    for (const [token, expiresAtMs] of this.mintedInvitations) {
      if (expiresAtMs <= now) {
        this.mintedInvitations.delete(token);
        continue;
      }
      if (!this.formationUsageRecorder) {
        return true;
      }
      if (!(await this.formationUsageRecorder.isTokenUsed(token))) {
        return true;
      }
      this.mintedInvitations.delete(token);
    }
    return (await this.formationUsageRecorder?.hasOutstandingInvitation?.()) ?? false;
  }

  /**
   * Record that a formation was completed successfully.
   * Called after strand provisioning to track usage.
   *
   * NOTE: this reaches `recordUsage` without passing through
   * `StrandFormationManager.provisionAsResponder`, so `disclosure` skips that path's
   * `MAX_DISCLOSURE_BYTES` cap. Harmless today — its only callers are integration-test mocks
   * that all default to `''` — but if a production caller ever passes a real disclosure here,
   * cap it too (the approver signs those bytes verbatim).
   */
  async recordFormationComplete(
    token: string,
    peerId: string,
    strandId: string,
    disclosure = ''
  ): Promise<void> {
    if (this.formationUsageRecorder) {
      await this.formationUsageRecorder.recordUsage({ token, peerId, strandId, disclosure });
      log('Recorded formation usage: token=%s strand=%s', token, strandId);
    }
  }
}

