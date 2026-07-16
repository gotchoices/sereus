import debug from 'debug';
import type { Database, SqlValue } from '@quereus/quereus';
import type { MemberRegistration } from './types.js';
import type { MemberRegistry, MemberVerifier } from './enrollment.js';
import type { Ed25519KeyPair } from './ed25519-key.js';
import {
  verifyStrandPayload,
  consumeInvite,
  addMemberByManager,
} from './strand-membership-writer.js';
import { canonicalDatetime } from './canonical-datetime.js';

const log = debug('sereus:cadre:strand-member-registry');

/**
 * The canonical payload a joining member signs to prove ownership of its strand
 * member key, verified by {@link StrandMemberVerifier.verifyMember}.
 *
 * Binds the member key to the strand id so a registration signature cannot be
 * replayed against a different strand. Peer-id binding is intentionally NOT part
 * of this payload — `MemberPeer` rows carry their OWN per-peer self-proofs
 * (`MemberKey || '|' || PeerId`, signed by the member) and are written by the
 * dedicated `registerMemberPeer` writer; see {@link StrandMemberRegistry}.
 */
export function memberRegistrationPayload(registration: MemberRegistration): string {
  return `${registration.strandId}|${registration.key}`;
}

/** How a {@link StrandMemberRegistry} admits a member into the strand. */
export type StrandAdmission =
  | {
      /** Redeem a specific single-use invite (the invitee-side join). */
      readonly mode: 'invite';
      /** The `Invite.Key` (invite public key, base64url) to redeem. */
      readonly inviteKey: string;
      /** The matching invite private seed (base64url), received out-of-band. */
      readonly invitePrivateKey: string;
    }
  | {
      /** Admit directly by manager signature (the manager-side join). */
      readonly mode: 'manager';
      /** The admitting manager's strand keypair. */
      readonly managerKeyPair: Ed25519KeyPair;
    };

/**
 * Strand-`Database`-backed {@link MemberVerifier} — the reconciliation that lets
 * {@link EnrollmentService} make real authorization decisions against a strand's
 * `Invite`/`ConsumedInvite`/`Member` tables instead of a placeholder.
 *
 * Each instance is scoped to ONE strand's database (the `Strand.*` tables live
 * inside the connected strand DB), so the `strandId` arguments on the interface
 * are accepted for signature compatibility but the queries run against this db.
 */
export class StrandMemberVerifier implements MemberVerifier {
  constructor(private readonly db: Database) {}

  /**
   * Verify the member's self-proof over {@link memberRegistrationPayload} against
   * the registration's own `key` (the member's ed25519 public key). This is the
   * off-engine counterpart to the on-engine signature checks — a pre-flight gate
   * before the constraint-enforced write.
   */
  async verifyMember(registration: MemberRegistration, signature: string): Promise<boolean> {
    const ok = verifyStrandPayload(memberRegistrationPayload(registration), signature, registration.key);
    if (!ok) {
      log('verifyMember: bad self-proof for member %s on strand %s', registration.key, registration.strandId);
    }
    return ok;
  }

  /**
   * A member is authorized to join when either it has already consumed an invite
   * (a `ConsumedInvite` row bears its key) OR the strand has at least one
   * outstanding `Invite` it could redeem.
   *
   * Strand invites are anonymous — `Invite.Key` is an invite public key, not a
   * member key, so an un-consumed invite cannot be bound to a specific member
   * here. This check is therefore a "door is open" pre-flight; the binding,
   * single-use, and cryptographic gates are all enforced by the deferred
   * `Strand.*` constraints when the member is actually written.
   *
   * Expired invites are filtered out so this pre-flight matches the on-engine
   * `ConsumedInvite.NotExpired` gate — `Now` is canonicalised the same way the
   * writer canonicalises it, so `Expiration > ?` compares like-for-like canonical
   * strings. A member that already holds a `ConsumedInvite` short-circuits above,
   * regardless of any invite's expiry.
   */
  async isAuthorizedToJoin(_strandId: string, memberKey: string): Promise<boolean> {
    const consumed = await scalarCount(
      this.db,
      'select count(1) as c from Strand.ConsumedInvite where MemberKey = ?',
      [memberKey],
    );
    if (consumed > 0) {
      return true;
    }
    const nowCanonical = await canonicalDatetime(this.db, Date.now());
    const invites = await scalarCount(
      this.db,
      'select count(1) as c from Strand.Invite where Expiration is null or Expiration > ?',
      [nowCanonical],
    );
    return invites > 0;
  }
}

/**
 * Strand-`Database`-backed {@link MemberRegistry} — writes real `Strand.Member`
 * (and, in invite mode, `Strand.ConsumedInvite`) rows through the signed writer
 * primitives, so {@link EnrollmentService.registerMember} performs the actual
 * per-strand join handshake rather than returning "MemberRegistry not configured".
 *
 * The {@link StrandAdmission} chosen at construction selects which branch of
 * `Member.Authorized` is taken:
 * - `invite`  → {@link consumeInvite} (atomic `Member` + `ConsumedInvite`), the
 *   invitee-side flow that redeems a single-use invite.
 * - `manager` → {@link addMemberByManager}, the manager-side flow that
 *   seats a member already trusted by a manager.
 *
 * Scoped to one strand's db; the `strandId` argument is accepted for interface
 * compatibility but writes target this db's `Strand.*` tables.
 *
 * NOTE: `peerIds` are NOT written as `MemberPeer` rows here. The signed peer path
 * now exists as the standalone `registerMemberPeer` writer (each peer self-proof is
 * signed by the member's own key), but wiring the enrollment `peerIds` through it is
 * a deliberate follow-on — the member self-proof available here does not carry the
 * per-peer signatures `MemberPeer.Authorized` requires. A non-empty `peerIds` is
 * logged and otherwise ignored so the member still lands; peer rows are reconciled
 * separately via `registerMemberPeer`.
 */
export class StrandMemberRegistry implements MemberRegistry {
  constructor(
    private readonly db: Database,
    private readonly admission: StrandAdmission,
  ) {}

  async registerMember(strandId: string, memberKey: string, peerIds: string[]): Promise<void> {
    if (peerIds.length > 0) {
      log(
        'registerMember: %d peerId(s) for member %s on strand %s deferred to the registerMemberPeer path (needs per-peer self-proofs); registering member only',
        peerIds.length, memberKey, strandId,
      );
    }

    if (this.admission.mode === 'invite') {
      await consumeInvite(this.db, {
        inviteKey: this.admission.inviteKey,
        invitePrivateKey: this.admission.invitePrivateKey,
        memberKey,
      });
      return;
    }

    await addMemberByManager(this.db, {
      managerKeyPair: this.admission.managerKeyPair,
      memberKey,
    });
  }

  async isMemberRegistered(_strandId: string, memberKey: string): Promise<boolean> {
    const count = await scalarCount(
      this.db,
      'select count(1) as c from Strand.Member where Key = ?',
      [memberKey],
    );
    return count > 0;
  }
}

/** Run a `select count(1) as c ...` and return the scalar (0 if no row). */
async function scalarCount(db: Database, sql: string, params: SqlValue[]): Promise<number> {
  for await (const row of db.eval(sql, params)) {
    return (row.c as number) ?? 0;
  }
  return 0;
}
