/**
 * Self-labelling for the trust-circle listing.
 *
 * `TrustCircleService.list()` shows the cadre's *authorized* membership, which
 * deliberately excludes the node's own self-published row — a node's own
 * address record isn't something an owner key vouched for. To keep the owner's
 * own device visible in the listing, cadre-host records a local
 * `self: true` label for it and `list()` splices that row back in.
 *
 * Writing that label is this module's job. Kept out of `bin/host.ts` so it is
 * unit-testable without standing up the CLI.
 */

import debug from 'debug';

import type { TrustCircleStore } from './trust-circle-store.js';

const log = debug('cadre:host:trust-circle-self');

/** Label written for the owner's own device when none exists yet. */
export const SELF_LABEL = 'This device';

export interface EnsureSelfLabelOptions {
  /** Local labels store to write into. */
  store: TrustCircleStore;
  /** Resolves the owner node's peer ID; '' when the node isn't ready yet. */
  getPeerId: () => Promise<string>;
  /** Clock override for tests. */
  now?: () => Date;
}

/**
 * Record the owner node's own peer ID as a `self: true` local label.
 *
 * Idempotent: an existing row for that peer ID is left alone, so an admin's
 * rename survives restarts. Stale `self` rows (a different peer ID — the node
 * identity was replaced) are dropped, since `list()` splices every `self` row
 * in unconditionally and would otherwise show a device that no longer exists.
 *
 * Returns the peer ID that is now labelled, or `undefined` when the node
 * wasn't ready. Throws whatever `getPeerId` throws — callers treat a failure
 * as best-effort (the next start heals it).
 */
export async function ensureSelfLabel(opts: EnsureSelfLabelOptions): Promise<string | undefined> {
  const { store, getPeerId } = opts;
  const now = opts.now ?? (() => new Date());

  const peerId = await getPeerId();
  if (!peerId) {
    log('owner node not ready — no self label written');
    return undefined;
  }

  for (const member of store.listMembers()) {
    if (member.self && member.peerId !== peerId) {
      log('dropping stale self label for %s (current identity is %s)', member.peerId, peerId);
      store.removeMember(member.peerId);
    }
  }

  const existing = store.getMember(peerId);
  if (!existing) {
    store.addMember({ peerId, label: SELF_LABEL, addedAt: now().toISOString(), self: true });
    log('labelled own device %s as "%s"', peerId, SELF_LABEL);
  } else if (!existing.self) {
    // Row predates self-labelling (or was written by a redemption). Stamp the
    // flag, keeping the label: without it `list()` prunes the row, since the
    // authorized set never contains self.
    store.addMember({ ...existing, self: true });
    log('stamped existing label for own device %s as self', peerId);
  }

  return peerId;
}
