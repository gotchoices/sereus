/**
 * Control-network inbound connection gate (defense-in-depth).
 *
 * Layer 2 of the membership enforcement chain: the PRIMARY gates are per-stream
 * — every sensitive sereus control protocol rejects a peer that fails the
 * voucher-anchored `CadreNode.isAuthorizedMember` predicate (wake, strand-addr),
 * and the replicated rows an outsider *can* still write are disbelieved at read
 * time. This module adds the opportunistic connection-level layer on top: a
 * peer this node can positively determine is NOT authorized is refused at the
 * encrypted-connection checkpoint, before any protocol negotiation, so a
 * known-nothing outsider is never even in the conversation.
 *
 * ## The stranger allowlist (the ONE place it is defined)
 *
 * A libp2p connection gater decides per CONNECTION, before protocols are
 * negotiated, so "allow seed, deny repo" cannot be expressed here — instead the
 * policy admits a connection whenever a legitimate stranger interaction could be
 * riding it, and the per-stream gates take over. The complete set of protocols a
 * NOT-yet-authorized peer may legitimately speak on a control node is:
 *
 *  - `/sereus/seed/1.0.0` ({@link SEED_PROTOCOL}) — enrollment seed delivery.
 *    An owner dials a brand-new node to seed it (the new node has no members
 *    yet, so its gate is inert), and an invited phone dials the owner before it
 *    is authorized (admitted via the enrollment window `CadreNode.createInvite`
 *    opens). The handler's own trust decision is the anchored seed-trust policy.
 *  - `/sereus/formation/1.0.0` ({@link FORMATION_PROTOCOL}) — cross-party
 *    strand formation via open invitations. Stranger-facing BY DESIGN: the
 *    initiator is another party. Registering the formation responder
 *    (`CadreNode.initializeStrandSolicitation`) therefore marks the node
 *    stranger-serving and suspends stranger denial; the handler's own trust
 *    decision is the invitation token check. That suspension is currently
 *    process-lifetime and unconditional — `reference-app-rn` registers the
 *    responder at node bring-up, so the connection gate is inert there.
 *    Narrowing it to "an unexpired open invitation is outstanding" is
 *    `tickets/plan/narrow-formation-stranger-carveout`.
 *
 * Everything else a control node handles — the Optimystic control-DB protocols
 * (`/optimystic/control-<party>/{repo,cluster,sync,block-transfer}/…`), wake
 * (`/sereus/strand-wake/1.0.0`), and strand-addr (`/sereus/strand-addr/1.0.0`)
 * — is members-only. Wake and strand-addr enforce that per-stream today; the
 * Optimystic protocols expose no per-stream authz hook yet (see
 * `tickets/blocked/control-repo-protocol-stream-authz-optimystic`), which makes
 * this connection gate the current outermost defense for them.
 *
 * ## Fail-open, deliberately
 *
 * This layer only ever denies on a POSITIVE determination of "unauthorized
 * outsider while no stranger path is open". Any error, missing dependency, or
 * ambiguous state admits the connection and defers to the fail-closed stream
 * gates — a DB hiccup must not partition a legitimate cadre.
 */

import debug from 'debug';
import type { ConnectionGater, PeerId, MultiaddrConnection } from '@libp2p/interface';
import { SEED_PROTOCOL } from './seed-bootstrap.js';
import { FORMATION_PROTOCOL } from './strand-formation-protocol.js';

const log = debug('sereus:cadre:connection-gater');

/**
 * The protocols a not-yet-authorized peer may legitimately speak on a control
 * node (see the module doc above for why each is open and where its own trust
 * decision lives). Exported as the single reference point so the allowlist
 * cannot silently drift across modules.
 */
export const STRANGER_OPEN_PROTOCOLS: readonly string[] = [SEED_PROTOCOL, FORMATION_PROTOCOL];

/**
 * How long `CadreNode.createInvite` holds the inbound gate open for strangers
 * when the invite carries no explicit expiry: the invitee must dial in before
 * it is authorized, and an expiry-less invite gives the gate no bound of its
 * own. Redeeming after this window still works once the owner re-mints (or the
 * caller re-opens the window via `CadreNode.openEnrollmentWindow`).
 */
export const DEFAULT_ENROLLMENT_WINDOW_MS = 30 * 60 * 1000;

/**
 * Deadline for one admission decision, after which the connection is ADMITTED.
 *
 * libp2p awaits `denyInboundEncryptedConnection` inside the inbound upgrade
 * WITHOUT racing its inbound-upgrade timeout signal (unlike the pre-encryption
 * `denyInboundConnection` hook), so a decision that never settles wedges that
 * upgrade forever — the connection-manager's inbound-upgrade slot is taken by
 * `acceptIncomingConnection` and released in the `finally` that never runs. The
 * real policy reads the control DB (`listAuthorizedMembers`), which can pull
 * over the network, so "never settles" is reachable. Bounding it here keeps the
 * fail-open contract honest: a slow decision admits rather than silently
 * failing closed (or not at all).
 */
export const ADMISSION_DECISION_TIMEOUT_MS = 2_000;

/**
 * The admission decision the gate defers to — implemented by
 * `CadreNode.admitInboundControlConnection` (enrollment windows, anchor state,
 * bootstrap infra, the authorized-member set). Kept injectable so the gater's
 * composition/fail-open behavior is unit-testable without a full node.
 */
export interface InboundAdmissionPolicy {
  /** Should an inbound encrypted connection from this peer be admitted? */
  admitInbound(remotePeerId: string): Promise<boolean> | boolean;
}

/**
 * Build the control node's connection gater: the caller-supplied gater (if any)
 * with membership admission composed onto `denyInboundEncryptedConnection` —
 * the earliest checkpoint where the remote's authenticated PeerId is known.
 *
 * Composition semantics: every hook of `base` is preserved as-is; on the
 * inbound-encrypted hook a deny from EITHER the base gater or the admission
 * policy denies. A policy error — or a decision slower than
 * `decisionTimeoutMs` — admits (fail-open, see module doc); the base gater's
 * verdict is still honored first.
 *
 * NOTE: `base` is spread, so a gater passed as a CLASS INSTANCE would lose its
 * prototype methods; every caller in this repo (and libp2p's own default)
 * supplies a plain object. If a class-based gater ever shows up, delegate
 * per-hook instead of spreading.
 *
 * Deny timing, as observed by the denied dialer: noise negotiates the muxer in
 * the security handshake's early data, so the DIALER's upgrade may complete
 * (its `dial()` resolves) before this receiver-side hook runs. The deny then
 * aborts the receiver's upgrade — the receiver never registers the connection
 * and never creates its muxer, so no protocol can ever be negotiated — and the
 * dialer sees its "open" connection close moments later.
 *
 * Control node only: strand cohort nodes legitimately connect cross-party
 * peers, so `CadreNode` threads the raw configured gater to them unchanged.
 */
export function createMembershipConnectionGater(
  policy: InboundAdmissionPolicy,
  base?: ConnectionGater,
  decisionTimeoutMs: number = ADMISSION_DECISION_TIMEOUT_MS
): ConnectionGater {
  return {
    ...base,
    denyInboundEncryptedConnection: async (peerId: PeerId, maConn: MultiaddrConnection): Promise<boolean> => {
      if (await base?.denyInboundEncryptedConnection?.(peerId, maConn)) {
        return true;
      }
      const remotePeerId = peerId.toString();
      try {
        return !(await admitWithinDeadline(policy, remotePeerId, decisionTimeoutMs));
      } catch (error) {
        log('admitInbound threw for %s — admitting (fail-open; stream gates decide): %o', remotePeerId, error);
        return false;
      }
    }
  };
}

/**
 * Run the admission decision under {@link ADMISSION_DECISION_TIMEOUT_MS},
 * resolving to "admit" if it has not settled in time (see that constant for why
 * an unbounded await is not safe here). The timer is always cleared so a decided
 * connection never holds the event loop open.
 */
async function admitWithinDeadline(
  policy: InboundAdmissionPolicy,
  remotePeerId: string,
  timeoutMs: number
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve(policy.admitInbound(remotePeerId)),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => {
          log('admitInbound exceeded %dms for %s — admitting (fail-open; stream gates decide)', timeoutMs, remotePeerId);
          resolve(true);
        }, timeoutMs);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}
