import debug from 'debug';
import { FormationAbortedError, InvitationExhaustedError, type ControlDatabase } from './control-database.js';
import { mintStrandId } from './strand-id.js';
import {
  createHttpFormationApprover,
  verifyFormationApproval,
  FormationApprovalError,
  type FormationApprover,
  type FormationApproval,
  type FormationApprovalRequest
} from './formation-approval.js';
import type {
  AuthorizedFormationUsage,
  BoundHostStrand,
  FormationUsageParams,
  FormationUsageRecorder,
  ResolvedHostStrand
} from './strand-solicitation.js';
import { isInviteExpired, type FormationInviteFacts, type FormationTokenRead } from './formation-token.js';

const log = debug('sereus:cadre:formation-recorder');

/**
 * {@link FormationUsageRecorder} backed by the real `CadreControl` tables.
 *
 * It reads a session's token once ({@link readToken}: the `FormationInvite` row and its
 * `FormationUsage` count), and writes the consent row that records a redemption from that
 * read. Two provisioning shapes are supported, keyed on whether the invite binds a host strand:
 *
 * - **Bound (provision-then-record):** the host strand already exists (owner-signed
 *   up front and named by the invite's `StrandId`), so {@link resolveStrand} reports it
 *   and {@link authorizeUsage} then its `record()` (or {@link recordUsage}, both at once)
 *   writes the consent row against that pre-existing strand
 *   (record-only) rather than inserting a new `Strand`.
 * - **Unbound (responder-provisions):** the invite carries no `StrandId`, so
 *   {@link provisionAndRecord} mints a fresh strand and records consent against it
 *   ATOMICALLY (one `FormationUsage` row), closing the single-use hole the older
 *   never-record fallback left open.
 *
 * Every `CadreNode`'s formation responder uses it unless the embedder passes another
 * recorder to `initializeStrandSolicitation`.
 *
 * Usage accounting follows the schema's `FormationUsage.Authorized` semantics:
 * a null `TotalUses` means unlimited uses; otherwise the invite is "used up"
 * once the recorded usage count reaches `TotalUses`.
 *
 * When the invite carries a `ValidationUrl`, both write paths first obtain an outside
 * approval ({@link obtainApproval}) — the recorder is the one place where the nonce that is
 * SIGNED and the nonce that is INSERTED are trivially the same value, since it also performs
 * the write. That makes this class do network I/O; failures surface as
 * {@link FormationApprovalError}s the manager maps to protocol rejection reasons. The bound
 * path is split in two ({@link authorizeUsage}, then the returned `record()`) so the manager
 * can issue the joiner's membership pass between the approval and the write; the handle
 * carries the approved fields across, which keeps the signed and inserted nonce the same.
 */
export class ControlFormationUsageRecorder implements FormationUsageRecorder {
  private readonly approver: FormationApprover;

  /**
   * `approver` defaults to the real HTTP hook client — deliberately ON: `CadreNode` builds this
   * recorder for every node's responder with no options, so an opt-in approver would leave
   * every real deployment unable to redeem a `ValidationUrl`-bearing invite. Tests inject a fake.
   */
  constructor(
    private readonly controlDatabase: ControlDatabase,
    options?: { approver?: FormationApprover }
  ) {
    this.approver = options?.approver ?? createHttpFormationApprover();
  }

  /**
   * One `FormationInvite` read, then one `FormationUsage` count only when the invite is
   * metered (`TotalUses` set) and unexpired: an unknown, expired or unlimited token has no
   * seat to count. This early count refuses a spent token before anything costly (the outside
   * approval call, the strand-database write that issues the membership invite); the count
   * inside the write lock decides.
   */
  async readToken(token: string): Promise<FormationTokenRead> {
    const invite = await this.controlDatabase.queryFormationInvite(token);
    const metered = invite !== null && invite.totalUses !== null && !isInviteExpired(invite, Date.now());
    return {
      token,
      invite,
      usesRecorded: metered ? await this.controlDatabase.countFormationUsage(token) : null,
    };
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
   * Reads the invite for itself (it is handed no session read) and the strand's stamp inside
   * `recordFormationUsage`; otherwise authorizes as {@link authorizeUsage} does and writes in
   * one step, for callers with nothing to do in between.
   */
  async recordUsage(params: FormationUsageParams): Promise<void> {
    if (params.signal?.aborted) {
      throw new FormationAbortedError(params.token, 'usage recording');
    }
    const invite = await this.controlDatabase.queryFormationInvite(params.token);
    await (await this.authorize(params, invite, undefined)).record();
  }

  /**
   * Everything {@link recordUsage} does before its write, so the manager can issue the
   * joiner's membership pass into the host strand only once the redemption is cleared, and
   * spend the token only after that. Takes the invite's `ValidationUrl` and seat budget from
   * the session's `read`, and the host strand's stamp from `host`, so it reads neither again.
   */
  async authorizeUsage(
    params: FormationUsageParams,
    read: FormationTokenRead,
    host: BoundHostStrand
  ): Promise<AuthorizedFormationUsage> {
    return await this.authorize(params, read.invite, host.strandStampId);
  }

  /**
   * Obtain the approval through {@link obtainApproval} when `invite` demands one, re-check the
   * abort (the approval call may have been long), and after an obtained approval re-check the
   * seat budget ({@link assertSeatFree}). The returned `record()` closes over the captured
   * fields and approval, so the nonce the approver signed is the nonce inserted without the
   * caller ever passing it back. `strandStampId` undefined makes `recordFormationUsage` read it.
   */
  private async authorize(
    params: FormationUsageParams,
    invite: FormationInviteFacts | null,
    strandStampId: string | undefined
  ): Promise<AuthorizedFormationUsage> {
    const { token, peerKey, peerSignature, usageStampId, strandId, disclosure, signal } = params;
    if (signal?.aborted) {
      throw new FormationAbortedError(token, 'usage recording');
    }
    // NOTE: a missing invite row reads as "no approval required" here and in
    // `provisionAndRecord`, so an invite that was absent from the session's read (or vanished
    // before `recordUsage`'s) would be written unapproved. Safe only because the database's
    // `FormationUsage.Authorized` CHECK demands a matching `FormationInvite` and rolls the write
    // back regardless; if that CHECK ever loosens, reject on `invite === null` instead of
    // defaulting to null.
    const validationUrl = invite?.validationUrl ?? null;
    const approval = await this.obtainApproval({
      token, usageStampId, strandId, peerKey, disclosure, validationUrl,
    }, signal);
    if (signal?.aborted) {
      throw new FormationAbortedError(token, 'usage recording');
    }
    const totalUses = invite?.totalUses ?? null;
    if (validationUrl !== null) {
      await this.assertSeatFree(token, totalUses);
    }
    return {
      record: async () => {
        await this.controlDatabase.recordFormationUsage({
          token, strandId, peerKey, peerSignature, usageStampId, disclosure, signal,
          totalUses, strandStampId, ...approval,
        });
        log('Recorded formation usage: token=%s strand=%s', token, strandId);
      }
    };
  }

  /**
   * Refuse a redemption whose invite lost its last seat while this redemption waited on its
   * outside approval, BEFORE anything is written — the authoritative check is the one
   * `recordFormationUsage` repeats inside its write lock. Runs only after an obtained approval:
   * that call is the one long wait between the session's early count (`readToken`) and the
   * membership pass, in which a same-node rival could take the seat unseen.
   *
   * NOTE: two redemptions that both pass the last count before issuance (this one after an
   * approval, `readToken`'s without one) within the time one of them takes to issue its
   * membership pass still both issue one, and the loser's pass is orphaned (expiry-bounded,
   * never handed out). Holding the control write lock across issuance would close it, but
   * `lockedWithRetry` re-runs locked bodies on transient failures (a re-run would double-issue)
   * and every control write would stall behind a strand-database write. If orphaned passes from
   * same-node races ever matter, reserve the seat before issuance.
   */
  private async assertSeatFree(token: string, totalUses: number | null): Promise<void> {
    if (totalUses === null) {
      return;
    }
    const used = await this.controlDatabase.countFormationUsage(token);
    if (used >= totalUses) {
      throw new InvitationExhaustedError(token, used, totalUses);
    }
  }

  /**
   * Classify the host strand the read invite binds to (see {@link ResolvedHostStrand}), with
   * one `Strand` read and no invite read:
   *
   * - no invite / no `StrandId` → `unbound` (responder-provisions path).
   * - `StrandId` set AND the strand row is present → `bound`, carrying its type, its
   *   `StampId` (which the consent row names) and its `MemberPrivateKey` (the closed-strand
   *   read-gating secret) for delivery to a validated invitee.
   * - `StrandId` set but the strand row is absent → `missing` (the host strand has not
   *   converged on this responder yet); the manager rejects cleanly instead of recording
   *   usage against a non-existent strand, which would fail the deferred `StrandExists`
   *   CHECK at commit and drop the result frame.
   */
  async resolveStrand(read: FormationTokenRead): Promise<ResolvedHostStrand> {
    const strandId = read.invite?.strandId;
    if (!strandId) {
      return { kind: 'unbound' };
    }
    const strand = await this.controlDatabase.queryStrandWithStamp(strandId);
    if (!strand) {
      return { kind: 'missing', strandId };
    }
    return {
      kind: 'bound',
      strandId,
      strandType: strand.Type,
      strandStampId: strand.StampId,
      memberPrivateKey: strand.MemberPrivateKey ?? null,
    };
  }

  /**
   * Provision a NEW strand for an UNBOUND invite and record consent against it in ONE
   * transaction (the responder-provisions fallback, now single-use-enforced).
   *
   * Mints a fresh, globally-unique strand id with {@link mintStrandId} — an
   * unguessable CSPRNG id, and one `strand-id.ts` has already checked is usable as a
   * storage scope key and network name — then delegates to
   * {@link ControlDatabase.redeemInvitation}, whose
   * single `begin … commit` inserts the consent-authorized `Strand` row AND the matching
   * `FormationUsage` row together (both deferred CHECKs see both rows at commit). That one
   * `FormationUsage` row makes the unbound redemption single-use exactly like the bound
   * path: the next redemption of a `TotalUses:1` invite sees `count 1 >= 1` and is rejected.
   *
   * The strand is open (`'o'`) — an unbound responder-provisioned strand has no membership
   * key — so the returned `memberPrivateKey` is null. `sAppId` is accepted for parity/future
   * use; `redeemInvitation` does not currently thread it into the `Strand` row. The invite's
   * `ValidationUrl` and seat budget come from the session's `read`.
   *
   * A concurrent redemption of the same single-use invite still THROWS for the loser — the
   * manager maps that to a clean protocol rejection (it never lets the dropped insert close
   * the stream silently): the local write queue serializes the two writes, so the loser's
   * seat check reads the winner's committed row against the cap and is refused as a named
   * `InvitationExhaustedError`. A CROSS-node race is not a collision to retry at all — each
   * redemption writes under its own `UsageStampId`, both rows land and survive convergence,
   * and the cap can over-admit by the number of concurrent redeemers. That over-admission is
   * the accepted trade (visible in the append-only record, reversible by owner-gated
   * removal), chosen over a fought-over shared key whose failure mode was the silent loss of
   * a consented join.
   */
  async provisionAndRecord(params: {
    token: string;
    peerKey: string;
    peerSignature: string;
    usageStampId: string;
    sAppId: string;
    disclosure: string;
    signal?: AbortSignal;
  }, read: FormationTokenRead): Promise<{ strandId: string; memberPrivateKey: string | null }> {
    const { token, peerKey, peerSignature, usageStampId, disclosure, signal } = params;
    if (signal?.aborted) {
      throw new FormationAbortedError(token, 'redemption');
    }
    const strandId = mintStrandId();
    const invite = read.invite;
    const approval = await this.obtainApproval({
      token, usageStampId, strandId, peerKey, disclosure,
      validationUrl: invite?.validationUrl ?? null,
    }, signal);
    await this.controlDatabase.redeemInvitation({
      token, strandId, peerKey, peerSignature, usageStampId, disclosure, signal,
      totalUses: invite?.totalUses ?? null, ...approval,
    });
    log('Provisioned + recorded unbound strand: token=%s strand=%s', token, strandId);
    return { strandId, memberPrivateKey: null };
  }
}
