import { describe, it, expect, vi, afterEach } from 'vitest';
import type { Database } from '@quereus/quereus';
import {
  StrandMembershipReconciler,
  IDLE_PASSES_BEFORE_ESCALATION,
  type PendingMembershipInviteSource,
} from '../src/strand-membership-reconciler.js';
import {
  DEFAULT_REVOCATION_POLL_INTERVAL_MS,
  type RevocationRefreshScheduler,
} from '../src/strand-revocation-enforcer.js';
import {
  bootstrapFounderMembership,
  issueInvite,
  consumeInvite,
  cancelInvite,
  addMemberByManager,
  sealStrand,
  isStrandMember,
} from '../src/strand-membership-writer.js';
import { generateStrandMemberKey, strandMemberKeyPair } from '../src/strand-member-key.js';
import type { Ed25519KeyPair } from '../src/ed25519-key.js';
import type { StrandMembershipInvite } from '../src/types.js';
import { makeSAppConfig, openRawStrand, tableCount } from './strand-spec-helpers.js';
import { generatePrivateKey, getPublicKey } from '@optimystic/quereus-plugin-crypto';

/**
 * Component coverage for the bring-up membership reconciler: the full joiner ladder
 * (redeem the staged invitation → bind this machine's peer id → stop), the
 * already-member burn arm, the idle/no-invitation wait, the dead-invitation and
 * sealed-strand classifications, the self-revocation stop, and the scheduler wiring.
 *
 * Every DB-backed test runs against a REAL closed strand DB on the local transactor
 * (libp2p node + MemoryRawStorage) via the shared helpers — the same apply/DML/
 * deferred-constraint path `StrandDatabase` uses — with founder and joiner as two
 * distinct parties sharing one replica, which is exactly what a joiner that has
 * synced the founder's rows sees. The ARMING of this loop (which strands get one,
 * lifecycle across quiesce/resume) is `strand-instance-manager-membership.spec.ts`.
 */

/** A closed strand bootstrapped from a RAW party key we keep (the helpers discard theirs). */
async function openClosedStrand(): Promise<{
  db: Database;
  strandId: string;
  founder: Ed25519KeyPair;
  founderPrivateKey: string;
}> {
  const raw = await openRawStrand();
  const founderPrivateKey = await generateStrandMemberKey();
  const founder = strandMemberKeyPair(founderPrivateKey);
  await bootstrapFounderMembership(raw.db, {
    strandId: raw.strandId,
    type: 'c',
    sApp: makeSAppConfig(),
    founderKeyPair: founder,
  });
  return { db: raw.db, strandId: raw.strandId, founder, founderPrivateKey };
}

/** A joiner party's raw key + derived pair. */
async function freshParty(): Promise<{ privateKey: string; pair: Ed25519KeyPair }> {
  const privateKey = await generateStrandMemberKey();
  return { privateKey, pair: strandMemberKeyPair(privateKey) };
}

/** An in-memory stand-in for CadreNode's pending-invitation cache, one strand's slot. */
function inviteSlot(initial?: StrandMembershipInvite): {
  source: PendingMembershipInviteSource;
  staged: () => StrandMembershipInvite | undefined;
  set: (invite: StrandMembershipInvite | undefined) => void;
} {
  let staged = initial;
  return {
    source: {
      get: () => staged,
      clear: () => { staged = undefined; },
    },
    staged: () => staged,
    set: (invite) => { staged = invite; },
  };
}

/** A hand-cranked scheduler: the interval fires only when the test says so. */
function manualScheduler(): {
  scheduler: RevocationRefreshScheduler;
  tick: () => void;
  armedMs: () => number | undefined;
  cleared: () => boolean;
} {
  let fn: (() => void) | undefined;
  let ms: number | undefined;
  let cleared = false;
  return {
    scheduler: {
      setInterval: (f, m) => { fn = f; ms = m; return 'handle'; },
      clearInterval: () => { cleared = true; },
    },
    tick: () => fn?.(),
    armedMs: () => ms,
    cleared: () => cleared,
  };
}

interface ReconcilerOverrides {
  getOwnPeerId?: () => string | undefined;
  pendingInvite?: PendingMembershipInviteSource;
  isSelfRevoked?: () => boolean;
  scheduler?: RevocationRefreshScheduler;
  pollIntervalMs?: number;
  partyMemberPrivateKey?: string;
  getDatabase?: () => Database | undefined;
}

function reconcilerOver(db: Database | undefined, partyKey: string, overrides: ReconcilerOverrides = {}): StrandMembershipReconciler {
  return new StrandMembershipReconciler({
    label: 'test-strand',
    partyMemberPrivateKey: overrides.partyMemberPrivateKey ?? partyKey,
    getDatabase: overrides.getDatabase ?? (() => db),
    getOwnPeerId: overrides.getOwnPeerId ?? (() => 'this-machine-peer'),
    pendingInvite: overrides.pendingInvite,
    isSelfRevoked: overrides.isSelfRevoked,
    scheduler: overrides.scheduler,
  }, overrides.pollIntervalMs === undefined ? undefined : { pollIntervalMs: overrides.pollIntervalMs });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the full joiner ladder', () => {
  it('redeems the staged invitation once, binds this machine once, then stops for good', async () => {
    const { db, founder } = await openClosedStrand();
    const joiner = await freshParty();
    const invite = await issueInvite(db, { managerKeyPair: founder });
    const slot = inviteSlot({ inviteKey: invite.inviteKey, invitePrivateKey: invite.invitePrivateKey });
    const reconciler = reconcilerOver(db, joiner.privateKey, {
      pendingInvite: slot.source,
      getOwnPeerId: () => 'joiner-machine',
    });

    await reconciler.reconcile();

    // Member seated under the joiner's OWN key, the invitation spent, the binding written.
    expect(await isStrandMember(db, joiner.pair.publicKeyB64)).toBe(true);
    expect(await tableCount(db, 'Member')).toBe(2);
    expect(await tableCount(db, 'ConsumedInvite')).toBe(1);
    const binding = await db.get('select MemberKey, PeerId from Strand.MemberPeer');
    expect(binding?.MemberKey).toBe(joiner.pair.publicKeyB64);
    expect(binding?.PeerId).toBe('joiner-machine');
    // The staged credential is consumed exactly once and the loop is finished.
    expect(slot.staged()).toBeUndefined();
    expect(reconciler.done).toBe(true);
    expect(reconciler.stopped).toBe(true);

    // A second pass (a stray queued tick) writes nothing more.
    await reconciler.reconcile();
    expect(await tableCount(db, 'Member')).toBe(2);
    expect(await tableCount(db, 'ConsumedInvite')).toBe(1);
    expect(await tableCount(db, 'MemberPeer')).toBe(1);
  }, 30_000);

  it('a rebuilt reconciler (resume/restart) over an already-joined strand re-verifies and stops without new writes', async () => {
    const { db, founder } = await openClosedStrand();
    const joiner = await freshParty();
    const invite = await issueInvite(db, { managerKeyPair: founder });
    const first = reconcilerOver(db, joiner.privateKey, {
      pendingInvite: inviteSlot({ inviteKey: invite.inviteKey, invitePrivateKey: invite.invitePrivateKey }).source,
      getOwnPeerId: () => 'joiner-machine',
    });
    await first.reconcile();
    expect(first.done).toBe(true);

    // Resume rebuilds the loop with NO staged invitation (the cache cleared it).
    const second = reconcilerOver(db, joiner.privateKey, { getOwnPeerId: () => 'joiner-machine' });
    await second.reconcile();

    expect(second.done).toBe(true);
    expect(await tableCount(db, 'Member')).toBe(2);
    expect(await tableCount(db, 'ConsumedInvite')).toBe(1);
    expect(await tableCount(db, 'MemberPeer')).toBe(1);
  }, 30_000);

  it('a founder machine (member row already seated by bootstrap) skips straight to the binding', async () => {
    const strand = await openClosedStrand();
    const reconciler = reconcilerOver(strand.db, strand.founderPrivateKey, {
      getOwnPeerId: () => 'founder-machine',
    });

    await reconciler.reconcile();

    const binding = await strand.db.get('select MemberKey, PeerId from Strand.MemberPeer');
    expect(binding?.MemberKey).toBe(strand.founder.publicKeyB64);
    expect(binding?.PeerId).toBe('founder-machine');
    expect(await tableCount(strand.db, 'ConsumedInvite')).toBe(0);
    expect(reconciler.done).toBe(true);
  }, 30_000);

  it('defers the binding while no transport peer id is live, and completes once one is', async () => {
    const strand = await openClosedStrand();
    let peerId: string | undefined = undefined;
    const reconciler = reconcilerOver(strand.db, strand.founderPrivateKey, {
      getOwnPeerId: () => peerId,
    });

    await reconciler.reconcile();
    expect(reconciler.done).toBe(false);
    expect(await tableCount(strand.db, 'MemberPeer')).toBe(0);

    peerId = 'late-transport';
    await reconciler.reconcile();
    expect(reconciler.done).toBe(true);
    expect(await tableCount(strand.db, 'MemberPeer')).toBe(1);
  }, 30_000);
});

describe('the already-member arm', () => {
  it('burns a still-staged invitation (ConsumedInvite alone) without seating a second member', async () => {
    const { db, founder } = await openClosedStrand();
    const joiner = await freshParty();
    // A sibling machine (or a manager) already seated this party's member row…
    await addMemberByManager(db, { managerKeyPair: founder, memberKey: joiner.pair.publicKeyB64 });
    // …while THIS machine still holds the unspent bearer invitation.
    const invite = await issueInvite(db, { managerKeyPair: founder });
    const slot = inviteSlot({ inviteKey: invite.inviteKey, invitePrivateKey: invite.invitePrivateKey });
    const reconciler = reconcilerOver(db, joiner.privateKey, {
      pendingInvite: slot.source,
      getOwnPeerId: () => 'second-machine',
    });

    await reconciler.reconcile();

    // Burned: the ConsumedInvite row names the EXISTING member; no new Member row.
    const consumed = await db.get('select InviteKey, MemberKey from Strand.ConsumedInvite');
    expect(consumed?.InviteKey).toBe(invite.inviteKey);
    expect(consumed?.MemberKey).toBe(joiner.pair.publicKeyB64);
    expect(await tableCount(db, 'Member')).toBe(2);
    expect(slot.staged()).toBeUndefined();
    expect(reconciler.done).toBe(true);
    expect(await tableCount(db, 'MemberPeer')).toBe(1);
  }, 30_000);

  it('a failed burn (invitation already cancelled) is logged, dropped, and does not block the binding', async () => {
    const { db, founder } = await openClosedStrand();
    const joiner = await freshParty();
    await addMemberByManager(db, { managerKeyPair: founder, memberKey: joiner.pair.publicKeyB64 });
    const invite = await issueInvite(db, { managerKeyPair: founder });
    await cancelInvite(db, { managerKeyPair: founder, inviteKey: invite.inviteKey });
    const slot = inviteSlot({ inviteKey: invite.inviteKey, invitePrivateKey: invite.invitePrivateKey });
    const reconciler = reconcilerOver(db, joiner.privateKey, {
      pendingInvite: slot.source,
      getOwnPeerId: () => 'second-machine',
    });

    await reconciler.reconcile();

    expect(await tableCount(db, 'ConsumedInvite')).toBe(0);
    expect(slot.staged()).toBeUndefined();
    expect(reconciler.done).toBe(true);
    expect(await tableCount(db, 'MemberPeer')).toBe(1);
  }, 30_000);
});

describe('waiting and failure classification', () => {
  it('no member row and no staged invitation → idles quietly, writing nothing', async () => {
    const { db } = await openClosedStrand();
    const joiner = await freshParty();
    const reconciler = reconcilerOver(db, joiner.privateKey);

    await reconciler.reconcile();
    await reconciler.reconcile();

    expect(await tableCount(db, 'Member')).toBe(1);
    expect(await tableCount(db, 'MemberPeer')).toBe(0);
    expect(reconciler.done).toBe(false);
    expect(reconciler.stopped).toBe(false);
  }, 30_000);

  it('escalates to ONE console.warn after the idle-pass bound, then keeps quiet', async () => {
    const { db } = await openClosedStrand();
    const joiner = await freshParty();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const reconciler = reconcilerOver(db, joiner.privateKey);

    for (let i = 0; i < IDLE_PASSES_BEFORE_ESCALATION + 2; i++) {
      await reconciler.reconcile();
    }

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toMatch(/no\s+Member row/i);
    expect(reconciler.stopped).toBe(false);
  }, 30_000);

  it('an invitation whose Invite row has not replicated here yet is RETRIED, not dropped', async () => {
    const { db, founder } = await openClosedStrand();
    const joiner = await freshParty();
    // A credential that is valid in shape but whose Invite row this replica has not
    // seen: consumeInvite fails the deferred InviteExists and must retry next pass.
    const phantomPrivate = generatePrivateKey('ed25519', 'base64url') as string;
    const phantomKey = getPublicKey(phantomPrivate, 'ed25519', 'base64url', 'base64url') as string;
    const slot = inviteSlot({ inviteKey: phantomKey, invitePrivateKey: phantomPrivate });
    const reconciler = reconcilerOver(db, joiner.privateKey, {
      pendingInvite: slot.source,
      getOwnPeerId: () => 'joiner-machine',
    });

    await reconciler.reconcile();
    expect(reconciler.done).toBe(false);
    expect(slot.staged()).toBeDefined();
    expect(await tableCount(db, 'Member')).toBe(1);

    // A later pass with a real, replicated invitation (a re-formation) completes.
    const invite = await issueInvite(db, { managerKeyPair: founder });
    slot.set({ inviteKey: invite.inviteKey, invitePrivateKey: invite.invitePrivateKey });
    await reconciler.reconcile();
    expect(reconciler.done).toBe(true);
    expect(await isStrandMember(db, joiner.pair.publicKeyB64)).toBe(true);
  }, 30_000);

  it('an EXPIRED invitation is dropped with a log and the loop keeps waiting', async () => {
    const { db, founder } = await openClosedStrand();
    const joiner = await freshParty();
    const invite = await issueInvite(db, { managerKeyPair: founder, expiration: Date.now() - 60_000 });
    const slot = inviteSlot({ inviteKey: invite.inviteKey, invitePrivateKey: invite.invitePrivateKey });
    const reconciler = reconcilerOver(db, joiner.privateKey, { pendingInvite: slot.source });

    await reconciler.reconcile();

    expect(slot.staged()).toBeUndefined();
    expect(await tableCount(db, 'Member')).toBe(1);
    expect(reconciler.done).toBe(false);
    expect(reconciler.stopped).toBe(false);
  }, 30_000);

  it('a CANCELLED invitation is likewise dropped, not retried forever', async () => {
    const { db, founder } = await openClosedStrand();
    const joiner = await freshParty();
    const invite = await issueInvite(db, { managerKeyPair: founder });
    await cancelInvite(db, { managerKeyPair: founder, inviteKey: invite.inviteKey });
    const slot = inviteSlot({ inviteKey: invite.inviteKey, invitePrivateKey: invite.invitePrivateKey });
    const reconciler = reconcilerOver(db, joiner.privateKey, { pendingInvite: slot.source });

    await reconciler.reconcile();

    expect(slot.staged()).toBeUndefined();
    expect(reconciler.stopped).toBe(false);
  }, 30_000);

  it('an invitation already consumed by ANOTHER party is dropped, not retried forever', async () => {
    const { db, founder } = await openClosedStrand();
    const winner = await freshParty();
    const loser = await freshParty();
    const invite = await issueInvite(db, { managerKeyPair: founder });
    // The bearer credential is spent by whoever presents it first…
    await consumeInvite(db, {
      inviteKey: invite.inviteKey,
      invitePrivateKey: invite.invitePrivateKey,
      memberKey: winner.pair.publicKeyB64,
    });
    // …so a second holder's staged copy is dead on arrival (ConsumedInvite's primary key).
    const slot = inviteSlot({ inviteKey: invite.inviteKey, invitePrivateKey: invite.invitePrivateKey });
    const reconciler = reconcilerOver(db, loser.privateKey, { pendingInvite: slot.source });

    await reconciler.reconcile();

    expect(slot.staged()).toBeUndefined();
    expect(await isStrandMember(db, loser.pair.publicKeyB64)).toBe(false);
    expect(reconciler.stopped).toBe(false);
  }, 30_000);

  it('a SEALED strand is terminal: the loop stops rather than retry forever', async () => {
    const { db, founder } = await openClosedStrand();
    const joiner = await freshParty();
    const invite = await issueInvite(db, { managerKeyPair: founder });
    // The sole manager steps down for good: the Manager table empties, the founder
    // stays a member, and every pre-seal invitation dies (ConsumedInvite.NotSealed).
    await sealStrand(db, { managerKeyPair: founder });
    const slot = inviteSlot({ inviteKey: invite.inviteKey, invitePrivateKey: invite.invitePrivateKey });
    const reconciler = reconcilerOver(db, joiner.privateKey, { pendingInvite: slot.source });

    await reconciler.reconcile();

    expect(reconciler.stopped).toBe(true);
    expect(reconciler.done).toBe(false);
    expect(slot.staged()).toBeUndefined();
    expect(await tableCount(db, 'Member')).toBe(1);
  }, 30_000);

  it('stops without writing when the enforcer flags this party as revoked', async () => {
    const { db, founder } = await openClosedStrand();
    const joiner = await freshParty();
    const invite = await issueInvite(db, { managerKeyPair: founder });
    const slot = inviteSlot({ inviteKey: invite.inviteKey, invitePrivateKey: invite.invitePrivateKey });
    const reconciler = reconcilerOver(db, joiner.privateKey, {
      pendingInvite: slot.source,
      isSelfRevoked: () => true,
    });

    await reconciler.reconcile();

    expect(reconciler.stopped).toBe(true);
    expect(reconciler.done).toBe(false);
    expect(await tableCount(db, 'Member')).toBe(1);
    expect(await tableCount(db, 'MemberPeer')).toBe(0);
  }, 30_000);

  it('an undecodable party key is terminal with a log, never a throw', async () => {
    const { db } = await openClosedStrand();
    const reconciler = reconcilerOver(db, 'not-a-protobuf-key');

    await expect(reconciler.reconcile()).resolves.toBeUndefined();

    expect(reconciler.stopped).toBe(true);
    expect(reconciler.done).toBe(false);
  }, 30_000);

  it('a pass with no live database (quiesce race) simply waits for the next tick', async () => {
    const joiner = await freshParty();
    const reconciler = reconcilerOver(undefined, joiner.privateKey);

    await expect(reconciler.reconcile()).resolves.toBeUndefined();

    expect(reconciler.done).toBe(false);
    expect(reconciler.stopped).toBe(false);
  });
});

describe('scheduler wiring', () => {
  it('start() kicks an immediate pass and arms the poll at the default cadence', async () => {
    const strand = await openClosedStrand();
    const clock = manualScheduler();
    const reconciler = reconcilerOver(strand.db, strand.founderPrivateKey, {
      scheduler: clock.scheduler,
      getOwnPeerId: () => 'founder-machine',
    });

    reconciler.start();
    expect(clock.armedMs()).toBe(DEFAULT_REVOCATION_POLL_INTERVAL_MS);
    // start() returned synchronously with the pass still in flight — bring-up is
    // never blocked on it; flushing the chain shows the pass really ran.
    await reconciler.reconcile();

    expect(reconciler.done).toBe(true);
    // Reaching the done state disarms the interval.
    expect(clock.cleared()).toBe(true);
  }, 30_000);

  it('mirrors a configured cadence and retries on ticks until done', async () => {
    const { db, founder } = await openClosedStrand();
    const joiner = await freshParty();
    const slot = inviteSlot();
    const clock = manualScheduler();
    const reconciler = reconcilerOver(db, joiner.privateKey, {
      pendingInvite: slot.source,
      scheduler: clock.scheduler,
      pollIntervalMs: 5_000,
      getOwnPeerId: () => 'joiner-machine',
    });

    reconciler.start();
    await reconciler.reconcile();
    expect(clock.armedMs()).toBe(5_000);
    expect(reconciler.done).toBe(false);

    // The invitation arrives between ticks (formation completed); the next tick joins.
    const invite = await issueInvite(db, { managerKeyPair: founder });
    slot.set({ inviteKey: invite.inviteKey, invitePrivateKey: invite.invitePrivateKey });
    clock.tick();
    await reconciler.reconcile();

    expect(reconciler.done).toBe(true);
    expect(clock.cleared()).toBe(true);
  }, 30_000);

  it('stop() does not cancel a pass already in flight — settle() is what waits it out', async () => {
    const strand = await openClosedStrand();
    // Stop the loop from INSIDE the pass, at the last read before the binding write:
    // this is exactly the race clearOwnMemberPeerBinding faces, made deterministic.
    const reconciler: StrandMembershipReconciler = reconcilerOver(strand.db, strand.founderPrivateKey, {
      getOwnPeerId: () => { reconciler.stop(); return 'founder-machine'; },
    });

    void reconciler.reconcile();
    await reconciler.settle();

    // The pass stop() could not cancel ran to completion and wrote — which is why
    // clearOwnMemberPeerBinding awaits settle() before removing the binding.
    expect(reconciler.stopped).toBe(true);
    expect(reconciler.done).toBe(true);
    expect(await tableCount(strand.db, 'MemberPeer')).toBe(1);
  }, 30_000);

  it('stop() disarms the poll and later passes are inert', async () => {
    const { db } = await openClosedStrand();
    const joiner = await freshParty();
    const clock = manualScheduler();
    const reconciler = reconcilerOver(db, joiner.privateKey, { scheduler: clock.scheduler });

    reconciler.start();
    await reconciler.reconcile();
    reconciler.stop();

    expect(clock.cleared()).toBe(true);
    await reconciler.reconcile();
    expect(reconciler.done).toBe(false);
  }, 30_000);
});
