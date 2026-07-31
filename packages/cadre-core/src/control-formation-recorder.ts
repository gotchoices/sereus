import debug from 'debug';
import { randomBytes } from '@optimystic/quereus-plugin-crypto';
import { FormationAbortedError, type ControlDatabase } from './control-database.js';
import {
  createHttpFormationApprover,
  verifyFormationApproval,
  FormationApprovalError,
  type FormationApprover,
  type FormationApproval,
  type FormationApprovalRequest
} from './formation-approval.js';
import type { FormationUsageRecorder, ResolvedHostStrand } from './strand-solicitation.js';
import type { OpenInvitation } from './types.js';

const log = debug('sereus:cadre:formation-recorder');

/** Far-future sentinel for an invitation that never expires (max valid JS Date). */
const NEVER_EXPIRES = new Date(8640000000000000);

/**
 * {@link FormationUsageRecorder} backed by the real `CadreControl` tables.
 *
 * It reads `FormationInvite` / `FormationUsage` to answer token-validity and
 * usage questions, and writes the consent row that records a redemption. Two
 * provisioning shapes are supported, keyed on whether the invite binds a host strand:
 *
 * - **Bound (provision-then-record):** the host strand already exists (owner-signed
 *   up front and named by the invite's `StrandId`), so {@link resolveStrand} reports it
 *   and {@link recordUsage} writes the consent row against that pre-existing strand
 *   (record-only) rather than inserting a new `Strand`.
 * - **Unbound (responder-provisions):** the invite carries no `StrandId`, so
 *   {@link provisionAndRecord} mints a fresh strand and records consent against it
 *   ATOMICALLY (one `FormationUsage` row), closing the single-use hole the older
 *   never-record fallback left open.
 *
 * This replaces the in-memory stubs used by the formation tests so the consent path
 * is exercised against the persisted control network.
 *
 * Usage accounting follows the schema's `FormationUsage.Authorized` semantics:
 * a null `TotalUses` means unlimited uses; otherwise the invite is "used up"
 * once the recorded usage count reaches `TotalUses`.
 *
 * When the invite carries a `ValidationUrl`, both write paths first obtain an outside
 * approval ({@link obtainApproval}) — the recorder is the one place where the nonce that is
 * SIGNED and the nonce that is INSERTED are trivially the same value, since it also performs
 * the write. That makes this class do network I/O; failures surface as
 * {@link FormationApprovalError}s the manager maps to protocol rejection reasons.
 */
export class ControlFormationUsageRecorder implements FormationUsageRecorder {
  private readonly approver: FormationApprover;

  /**
   * `approver` defaults to the real HTTP hook client — deliberately ON: this recorder is
   * constructed by the reference apps and the integration harness, not by `CadreNode`, so an
   * opt-in approver would leave every real deployment unable to redeem a
   * `ValidationUrl`-bearing invite. Tests inject a fake.
   */
  constructor(
    private readonly controlDatabase: ControlDatabase,
    options?: { approver?: FormationApprover }
  ) {
    this.approver = options?.approver ?? createHttpFormationApprover();
  }

  /** A token is valid when a matching, unexpired `FormationInvite` exists. */
  async isTokenValid(token: string): Promise<{ valid: boolean; invitation?: OpenInvitation }> {
    const invite = await this.controlDatabase.queryFormationInvite(token);
    if (!invite) {
      return { valid: false };
    }
    if (invite.expiresAtMs !== null && invite.expiresAtMs <= Date.now()) {
      log('Token expired: %s', token);
      return { valid: false };
    }
    return {
      valid: true,
      invitation: {
        token: invite.token,
        sAppId: invite.sAppId,
        expiration: invite.expiresAtMs !== null ? new Date(invite.expiresAtMs) : NEVER_EXPIRES,
        bootstrap: [],
      },
    };
  }

  /**
   * A token is "used" when its recorded usage count has reached the invite's
   * `TotalUses`. A null `TotalUses` (unlimited) is never used up; an unknown
   * token is reported not-used (validity is handled by {@link isTokenValid}).
   */
  async isTokenUsed(token: string): Promise<boolean> {
    const invite = await this.controlDatabase.queryFormationInvite(token);
    if (!invite || invite.totalUses === null) {
      return false;
    }
    const uses = await this.controlDatabase.countFormationUsage(token);
    return uses >= invite.totalUses;
  }

  /**
   * Any `FormationInvite` row still unexpired and not fully consumed — the
   * durable half of the control-network connection gate's "does this node
   * expect a stranger?" question. Survives a restart and sees invites
   * replicated in from sibling nodes of the same cadre.
   */
  async hasOutstandingInvitation(): Promise<boolean> {
    return await this.controlDatabase.hasOutstandingFormationInvite();
  }

  /**
   * Obtain the approval material for ONE redemption, when the invite demands it.
   *
   * `validationUrl === null` → `{}`: no approval required. The `usageStampId` nonce is
   * ALWAYS supplied by the caller — the JOINER mints it, signs its own consent over it, and
   * sends it in the contact message — so the approver signs over the identical nonce in both
   * paths. Two local pre-checks run before anything is written:
   *
   * - {@link verifyFormationApproval} — did the hook sign the exact fields we hold?
   * - {@link ControlDatabase.queryValidationKeyStampId} — is the approval's key enrolled?
   *
   * Both pre-checks exist purely for legibility — they turn a bad approval into a named
   * {@link FormationApprovalError} instead of an opaque `CHECK constraint failed: Authorized`
   * at commit. The database re-verifies against the STORED `ValidationKey` row and remains
   * the security authority; do not "simplify" the database check away in favour of these.
   */
  private async obtainApproval(
    request: Omit<FormationApprovalRequest, 'validationUrl'> & { validationUrl: string | null },
    signal?: AbortSignal
  ): Promise<{ validationKey?: string; validationSignature?: string }> {
    const { validationUrl, ...fields } = request;
    if (validationUrl === null) {
      return {};
    }
    if (signal?.aborted) {
      throw new FormationAbortedError(fields.token, 'approval');
    }
    const fullRequest: FormationApprovalRequest = { ...fields, validationUrl };
    const approval = await this.askApprover(fullRequest, signal);
    if (!verifyFormationApproval(fullRequest, approval)) {
      throw new FormationApprovalError(
        'malformed',
        `Approval signature does not verify over this redemption (token ${fields.token})`
      );
    }
    if (await this.controlDatabase.queryValidationKeyStampId(approval.validationKey) === null) {
      throw new FormationApprovalError(
        'unenrolled',
        'Approval is signed by a key that is not an enrolled ValidationKey'
      );
    }
    return approval;
  }

  /**
   * Ask the approver, re-labelling a caller-abort as a {@link FormationAbortedError}.
   *
   * The HTTP client relays a caller-abort onto its own request and reports it as an
   * `unavailable` {@link FormationApprovalError} — which the manager cannot tell from a
   * genuinely dead hook, and so maps to a rejection reason and RETURNS. Every other abort on
   * this path THROWS, which is what makes the manager rethrow and leave the reply to the
   * listener's timeout path; a mid-hook abort belongs in the same class. The approval error
   * is kept as `cause` so the transport-level detail is not lost.
   */
  private async askApprover(
    request: FormationApprovalRequest,
    signal?: AbortSignal
  ): Promise<FormationApproval> {
    try {
      return await this.approver.requestApproval(request, signal);
    } catch (err) {
      if (signal?.aborted) {
        throw new FormationAbortedError(request.token, 'approval', { cause: err });
      }
      throw err;
    }
  }

  /**
   * Record consent against an **already-existing** host strand (record-only): the
   * single `FormationUsage` insert auto-commits and the deferred `StrandExists`
   * CHECK is satisfied by the pre-existing strand. This is the provision-then-record
   * commitment — the strand was minted owner-signed up front, so we do NOT
   * re-insert it (which would double-insert the same PK). `peerKey` is written as the
   * usage `PeerKey`, which BOTH signed digests cover: the joiner's own consent signature
   * (`peerSignature`, verified by the schema's `PeerConsented` CHECK) and — when the invite
   * carries a `ValidationUrl` — the approver's sign-off, so it is the joiner an approval is
   * spent on AND provably the joiner that agreed. Use
   * {@link ControlDatabase.redeemInvitation} for the consent-creates-strand path instead.
   *
   * Reads the invite first (one extra read per redemption) to learn its `ValidationUrl`, and
   * obtains the approval through {@link obtainApproval} when one is demanded.
   */
  async recordUsage(params: {
    token: string;
    peerKey: string;
    peerSignature: string;
    usageStampId: string;
    strandId: string;
    disclosure: string;
    signal?: AbortSignal;
  }): Promise<void> {
    const { token, peerKey, peerSignature, usageStampId, strandId, disclosure, signal } = params;
    if (signal?.aborted) {
      throw new FormationAbortedError(token, 'usage recording');
    }
    const invite = await this.controlDatabase.queryFormationInvite(token);
    // NOTE: a missing invite row reads as "no approval required" here and in
    // `provisionAndRecord`, so an invite that vanished between `resolveStrand` and this read
    // would be written unapproved. Safe only because the database's `FormationUsage.Authorized`
    // CHECK demands a matching `FormationInvite` and rolls the write back regardless; if that
    // CHECK ever loosens, reject on `invite === null` instead of defaulting to null.
    const approval = await this.obtainApproval({
      token, usageStampId, strandId, peerKey, disclosure,
      validationUrl: invite?.validationUrl ?? null,
    }, signal);
    await this.controlDatabase.recordFormationUsage({
      token, strandId, peerKey, peerSignature, usageStampId, disclosure, signal, ...approval,
    });
    log('Recorded formation usage: token=%s strand=%s', token, strandId);
  }

  /**
   * Classify the host strand this invite binds to (see {@link ResolvedHostStrand}):
   *
   * - no invite / no `StrandId` → `unbound` (responder-provisions path).
   * - `StrandId` set AND the strand row is present → `bound`, carrying its
   *   `MemberPrivateKey` (the closed-strand read-gating secret) for delivery to a
   *   validated invitee.
   * - `StrandId` set but the strand row is absent → `missing` (the host strand has not
   *   converged on this responder yet); the manager rejects cleanly instead of recording
   *   usage against a non-existent strand, which would fail the deferred `StrandExists`
   *   CHECK at commit and drop the result frame.
   */
  async resolveStrand(token: string): Promise<ResolvedHostStrand> {
    const invite = await this.controlDatabase.queryFormationInvite(token);
    if (!invite || !invite.strandId) {
      return { kind: 'unbound' };
    }
    const strand = await this.controlDatabase.queryStrand(invite.strandId);
    if (!strand) {
      return { kind: 'missing', strandId: invite.strandId };
    }
    return {
      kind: 'bound',
      strandId: invite.strandId,
      memberPrivateKey: strand.MemberPrivateKey ?? null,
    };
  }

  /**
   * Provision a NEW strand for an UNBOUND invite and record consent against it in ONE
   * transaction (the responder-provisions fallback, now single-use-enforced).
   *
   * Mints a fresh, globally-unique strand id from {@link randomBytes} — the same
   * cross-platform CSPRNG `control-database`'s `generateStampId` uses, NOT
   * `crypto.randomUUID` / `Date.now` / `Math.random` (not uniformly available across
   * node/browser/RN) — then delegates to {@link ControlDatabase.redeemInvitation}, whose
   * single `begin … commit` inserts the consent-authorized `Strand` row AND the matching
   * `FormationUsage` row together (both deferred CHECKs see both rows at commit). That one
   * `FormationUsage` row makes the unbound redemption single-use exactly like the bound
   * path: the next redemption of a `TotalUses:1` invite sees `count 1 >= 1` and is rejected.
   *
   * The strand is open (`'o'`) — an unbound responder-provisioned strand has no membership
   * key — so the returned `memberPrivateKey` is null. `sAppId` is accepted for parity/future
   * use; `redeemInvitation` does not currently thread it into the `Strand` row.
   *
   * A concurrent redemption of the same single-use invite still THROWS for the loser — the
   * manager maps that to a clean protocol rejection (it never lets the dropped insert close
   * the stream silently) — but no longer via a `(Token, UseNumber)` primary-key collision on
   * this node: `redeemInvitation` reads the use number INSIDE the write lock, so two local
   * redemptions serialize and the second one reads the number the first already committed.
   * It is then refused because that number is past the invite's seat budget — by
   * `FormationUsage.Authorized`'s `TotalUses >= UseNumber` clause on a first attempt, or by
   * `InvitationExhaustedError` when a genuine lost race (another node, another `Database`
   * handle) sent it around the retry loop first. A PK collision is still what a cross-node
   * race surfaces as, and that one IS retried under a fresh use number rather than thrown.
   */
  async provisionAndRecord(params: {
    token: string;
    peerKey: string;
    peerSignature: string;
    usageStampId: string;
    sAppId: string;
    disclosure: string;
    signal?: AbortSignal;
  }): Promise<{ strandId: string; memberPrivateKey: string | null }> {
    const { token, peerKey, peerSignature, usageStampId, disclosure, signal } = params;
    if (signal?.aborted) {
      throw new FormationAbortedError(token, 'redemption');
    }
    const strandId = `strand-${randomBytes(128, 'hex') as string}`;
    const invite = await this.controlDatabase.queryFormationInvite(token);
    const approval = await this.obtainApproval({
      token, usageStampId, strandId, peerKey, disclosure,
      validationUrl: invite?.validationUrl ?? null,
    }, signal);
    await this.controlDatabase.redeemInvitation({
      token, strandId, peerKey, peerSignature, usageStampId, disclosure, signal, ...approval,
    });
    log('Provisioned + recorded unbound strand: token=%s strand=%s', token, strandId);
    return { strandId, memberPrivateKey: null };
  }
}
