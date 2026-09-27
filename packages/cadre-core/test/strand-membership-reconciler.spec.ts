import { describe, it, expect, vi, afterEach } from 'vitest';
import { QuereusError, StatusCode, type Database } from '@quereus/quereus';
import { CoordinatorPartialCommitError } from '@optimystic/db-core';
import { PartialCommitError } from '@optimystic/quereus-plugin-optimystic';
import {
  StrandMembershipReconciler,
  IDLE_PASSES_BEFORE_ESCALATION,
  INITIAL_JOIN_RETRY_INTERVAL_MS,
  UNFINISHED_PASSES_BEFORE_ESCALATION,
  classifyConsumeFailure,
  type PendingMembershipInviteSource,
} from '../src/strand-membership-reconciler.js';
import type { TimeoutScheduler } from '../src/timeout-scheduler.js';
import { DEFAULT_REVOCATION_POLL_INTERVAL_MS } from '../src/strand-revocation-enforcer.js';
import {
  bootstrapFounderMembership,
  issueInvite,
  consumeInvite,
  cancelInvite,
  addMemberByManager,
  revokeMember,
  sealStrand,
  isStrandMember,
  StrandTransactionBusyError,
} from '../src/strand-membership-writer.js';
import { generateStrandMemberKey, strandMemberKeyPair } from '../src/strand-member-key.js';
import type { Ed25519KeyPair } from '../src/ed25519-key.js';
import type { StrandMembershipInvite } from '../src/types.js';
import { makeSAppConfig, openRawStrand, tableCount } from './strand-spec-helpers.js';
import { captureDebugLog } from './capture-debug-log.js';
import { generatePrivateKey, getPublicKey } from '@optimystic/quereus-plugin-crypto';

const RECONCILER_NAMESPACE = 'sereus:cadre:strand-membership-reconciler';

/** The reconciler's debug line for a dropped dead invitation. */
const DEAD_INVITE_LINE = /staged invitation is dead/;

/**
 * Component coverage for the bring-up membership reconciler: the full joiner ladder
 * (redeem the staged invitation → bind this machine's peer id → stop), the
 * already-member burn arm, the idle/no-invitation wait, the dead-invitation and
 * sealed-strand classifications, the self-revocation stop, the re-arm on a fresh
 * invitation with its blocked re-join report, and the scheduler wiring.
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
      // CadreNode's semantics: only the invitation that was settled is dropped.
      clear: (settled) => { if (staged?.inviteKey === settled.inviteKey) staged = undefined; },
    },
    staged: () => staged,
    set: (invite) => { staged = invite; },
  };
}

/**
 * A hand-cranked scheduler: the retry timer fires only when the test says so.
 * {@link armedMs} is the delay of the timer currently pending (`undefined` once it has
 * fired or been cleared), and {@link delays} the whole sequence the loop asked for — which
 * is what the escalating ladder is asserted against.
 */
function manualScheduler(): {
  scheduler: TimeoutScheduler;
  tick: () => void;
  armedMs: () => number | undefined;
  delays: () => number[];
  pending: () => boolean;
} {
  let fn: (() => void) | undefined;
  let ms: number | undefined;
  const asked: number[] = [];
  return {
    scheduler: {
      setTimeout: (f, m) => { fn = f; ms = m; asked.push(m); return 'handle'; },
      clearTimeout: () => { fn = undefined; ms = undefined; },
    },
    tick: () => { const f = fn; fn = undefined; ms = undefined; f?.(); },
    armedMs: () => ms,
    delays: () => [...asked],
    pending: () => fn !== undefined,
  };
}

interface ReconcilerOverrides {
  getOwnPeerId?: () => string | undefined;
  pendingInvite?: PendingMembershipInviteSource;
  isSelfRevoked?: () => boolean;
  onRejoinBlocked?: () => void;
  scheduler?: TimeoutScheduler;
  pollIntervalMs?: number;
  partyMemberPrivateKey?: string;
  getDatabase?: () => Database | undefined;
}

/** A phantom invitation: valid in shape, but its `Strand.Invite` row never reaches this replica. */
function phantomInvite(): StrandMembershipInvite {
  const invitePrivateKey = generatePrivateKey('ed25519', 'base64url') as string;
  const inviteKey = getPublicKey(invitePrivateKey, 'ed25519', 'base64url', 'base64url') as string;
  return { inviteKey, invitePrivateKey };
}

/** The rejection `consumeInvite` raises for a fresh party presenting `invite`; fails the spec if it resolves. */
async function consumeRejection(db: Database, invite: StrandMembershipInvite): Promise<Error> {
  const party = await freshParty();
  const outcome: unknown = await consumeInvite(db, {
    inviteKey: invite.inviteKey,
    invitePrivateKey: invite.invitePrivateKey,
    memberKey: party.pair.publicKeyB64,
  }).then(() => 'resolved', (error: unknown) => error);
  expect(outcome).toBeInstanceOf(Error);
  return outcome as Error;
}

/** How a commit failure reaches the committing `exec`'s caller: Quereus wraps it, keeping it on `cause`. */
function viaQuereus(error: Error): QuereusError {
  return new QuereusError(`Commit failed: ${error.message}`, StatusCode.ERROR, error);
}

/**
 * The half-commit observed on 2026-09-17 (`tickets/.pre-existing-known.md`): `ConsumedInvite`
 * saved, `Member` and its unique index not.
 */
function consumedInviteSavedMemberNot(): CoordinatorPartialCommitError {
  return new CoordinatorPartialCommitError(
    ['default/strand/ConsumedInvite'],
    ['default/strand/Member', 'default/strand/Member/index/_uniq_7.stampid'],
    new Error('Stale commit for collection default/strand/Member'),
  );
}

/**
 * Fail the next membership write batch with `failure`, the way a refused commit reaches the writer:
 * the batch's `exec` rejects and nothing is written (a commit-time failure leaves no transaction
 * open). Later batches run for real. Every writer issues its transaction as one `exec` carrying
 * `{ transaction: true }`, which is what identifies a batch here.
 */
function failNextWriteBatch(db: Database, failure: Error): { batches: () => number } {
  const exec = db.exec.bind(db);
  let batches = 0;
  vi.spyOn(db, 'exec').mockImplementation((sql, params, options) => {
    if (options?.transaction !== true) return exec(sql, params, options);
    batches += 1;
    return batches === 1 ? Promise.reject(failure) : exec(sql, params, options);
  });
  return { batches: () => batches };
}

function reconcilerOver(db: Database | undefined, partyKey: string, overrides: ReconcilerOverrides = {}): StrandMembershipReconciler {
  return new StrandMembershipReconciler({
    label: 'test-strand',
    partyMemberPrivateKey: overrides.partyMemberPrivateKey ?? partyKey,
    getDatabase: overrides.getDatabase ?? (() => db),
    getOwnPeerId: overrides.getOwnPeerId ?? (() => 'this-machine-peer'),
    pendingInvite: overrides.pendingInvite,
    isSelfRevoked: overrides.isSelfRevoked,
    onRejoinBlocked: overrides.onRejoinBlocked,
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

  it('a burn refused because the app has a transaction open keeps the invitation staged for the next pass', async () => {
    const { db, founder } = await openClosedStrand();
    const joiner = await freshParty();
    await addMemberByManager(db, { managerKeyPair: founder, memberKey: joiner.pair.publicKeyB64 });
    const invite = await issueInvite(db, { managerKeyPair: founder });
    const slot = inviteSlot({ inviteKey: invite.inviteKey, invitePrivateKey: invite.invitePrivateKey });
    const reconciler = reconcilerOver(db, joiner.privateKey, {
      pendingInvite: slot.source,
      getOwnPeerId: () => 'second-machine',
    });

    await db.beginTransaction();
    await reconciler.reconcile();
    await db.commit();

    // Neither the burn nor the binding joined the app's transaction; both are left for the next pass.
    expect(slot.staged()).toBeDefined();
    expect(await tableCount(db, 'ConsumedInvite')).toBe(0);
    expect(await tableCount(db, 'MemberPeer')).toBe(0);
    expect(reconciler.done).toBe(false);

    await reconciler.reconcile();

    expect((await db.get('select MemberKey from Strand.ConsumedInvite'))?.MemberKey).toBe(joiner.pair.publicKeyB64);
    expect(slot.staged()).toBeUndefined();
    expect(reconciler.done).toBe(true);
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

  it('after a half-committed join, the idle passes that follow add no escalation warning', async () => {
    const { db, founder } = await openClosedStrand();
    const joiner = await freshParty();
    const invite = await issueInvite(db, { managerKeyPair: founder });
    const slot = inviteSlot({ inviteKey: invite.inviteKey, invitePrivateKey: invite.invitePrivateKey });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const reconciler = reconcilerOver(db, joiner.privateKey, { pendingInvite: slot.source });
    failNextWriteBatch(db, viaQuereus(consumedInviteSavedMemberNot()));

    for (let i = 0; i < IDLE_PASSES_BEFORE_ESCALATION + 2; i++) {
      await reconciler.reconcile();
    }

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toMatch(/only partly saved/);
    expect(reconciler.stopped).toBe(false);
  }, 30_000);

  it('an invitation whose Invite row has not replicated here yet is RETRIED, not dropped', async () => {
    const { db, founder } = await openClosedStrand();
    const joiner = await freshParty();
    // A credential that is valid in shape but whose Invite row this replica has not
    // seen: consumeInvite fails the deferred InviteExists and must retry next pass.
    const slot = inviteSlot(phantomInvite());
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

  it('a redemption refused because the app has a transaction open is retried, keeping the invitation', async () => {
    const { db, founder } = await openClosedStrand();
    const joiner = await freshParty();
    const invite = await issueInvite(db, { managerKeyPair: founder });
    const slot = inviteSlot({ inviteKey: invite.inviteKey, invitePrivateKey: invite.invitePrivateKey });
    const reconciler = reconcilerOver(db, joiner.privateKey, {
      pendingInvite: slot.source,
      getOwnPeerId: () => 'joiner-machine',
    });

    await db.beginTransaction();
    const lines = await captureDebugLog(RECONCILER_NAMESPACE, () => reconciler.reconcile());
    await db.commit();

    expect(slot.staged()).toBeDefined();
    expect(await isStrandMember(db, joiner.pair.publicKeyB64)).toBe(false);
    expect(await tableCount(db, 'ConsumedInvite')).toBe(0);
    expect(reconciler.done).toBe(false);
    expect(reconciler.stopped).toBe(false);
    expect(lines.some(line => DEAD_INVITE_LINE.test(line))).toBe(false);
    expect(lines.some(line => /app has a transaction open/.test(line))).toBe(true);

    // The app's transaction is closed: the next pass redeems the same invitation.
    await reconciler.reconcile();
    expect(reconciler.done).toBe(true);
    expect(slot.staged()).toBeUndefined();
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
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const lines = await captureDebugLog(RECONCILER_NAMESPACE, () => reconciler.reconcile());

    expect(slot.staged()).toBeUndefined();
    expect(await isStrandMember(db, loser.pair.publicKeyB64)).toBe(false);
    expect(reconciler.stopped).toBe(false);
    // Classified DEAD by the anchored texts — the quiet debug line, not the half-commit warning.
    expect(lines.some(line => DEAD_INVITE_LINE.test(line))).toBe(true);
    expect(warn).not.toHaveBeenCalled();
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

  it('stops without writing when the enforcer flags this party as revoked and nothing is staged', async () => {
    const { db } = await openClosedStrand();
    const joiner = await freshParty();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const reconciler = reconcilerOver(db, joiner.privateKey, {
      pendingInvite: inviteSlot().source,
      isSelfRevoked: () => true,
    });

    await reconciler.reconcile();

    expect(reconciler.stopped).toBe(true);
    expect(reconciler.done).toBe(false);
    expect(warn).not.toHaveBeenCalled();
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

/**
 * A fresh invitation staged after the loop finished — the REMOVED party handed a new
 * invitation, whose loop latched `done` during its first join. `rearm()` is what
 * `StrandInstanceManager.notifyMembershipInviteStaged` calls once `CadreNode` stages it.
 */
describe('re-arming on a fresh invitation', () => {
  /** A joiner that has fully joined: member row seated, binding written, loop done. */
  async function joinedAndDone(): Promise<{
    db: Database;
    founder: Ed25519KeyPair;
    joiner: { privateKey: string; pair: Ed25519KeyPair };
    slot: ReturnType<typeof inviteSlot>;
    reconciler: StrandMembershipReconciler;
  }> {
    const { db, founder } = await openClosedStrand();
    const joiner = await freshParty();
    const first = await issueInvite(db, { managerKeyPair: founder });
    const slot = inviteSlot({ inviteKey: first.inviteKey, invitePrivateKey: first.invitePrivateKey });
    const reconciler = reconcilerOver(db, joiner.privateKey, {
      pendingInvite: slot.source,
      getOwnPeerId: () => 'joiner-machine',
    });
    await reconciler.reconcile();
    expect(reconciler.done).toBe(true);
    expect(reconciler.stopped).toBe(true);
    return { db, founder, joiner, slot, reconciler };
  }

  it('a done loop handed a fresh invitation after its party was removed redeems it and seats the member row again', async () => {
    const { db, founder, joiner, slot, reconciler } = await joinedAndDone();
    // The removal replicated here, so this replica no longer shows the party as a member.
    await revokeMember(db, { managerKeyPair: founder, memberKey: joiner.pair.publicKeyB64 });
    expect(await isStrandMember(db, joiner.pair.publicKeyB64)).toBe(false);
    const second = await issueInvite(db, { managerKeyPair: founder });
    slot.set({ inviteKey: second.inviteKey, invitePrivateKey: second.invitePrivateKey });

    await reconciler.rearm();

    expect(await isStrandMember(db, joiner.pair.publicKeyB64)).toBe(true);
    expect((await db.get('select MemberKey from Strand.ConsumedInvite where InviteKey = ?', [second.inviteKey]))?.MemberKey)
      .toBe(joiner.pair.publicKeyB64);
    expect(slot.staged()).toBeUndefined();
    // The binding survived the removal (insert-if-absent found it), and the loop is done again.
    expect(await tableCount(db, 'MemberPeer')).toBe(1);
    expect(reconciler.done).toBe(true);
    expect(reconciler.stopped).toBe(true);
  }, 30_000);

  it('the public stop() is permanent: a later re-arm writes nothing', async () => {
    // clearOwnMemberPeerBinding stops the loop and awaits settle() so no pass can re-register
    // the binding it is about to delete; a re-arm that restarted the loop would undo that.
    const { db, founder, slot, reconciler } = await joinedAndDone();
    reconciler.stop();
    const second = await issueInvite(db, { managerKeyPair: founder });
    slot.set({ inviteKey: second.inviteKey, invitePrivateKey: second.invitePrivateKey });

    await reconciler.rearm();

    expect(reconciler.stopped).toBe(true);
    expect(slot.staged()).toBeDefined();
    expect(await tableCount(db, 'ConsumedInvite')).toBe(1);
  }, 30_000);

  it('a stale member row with a refused burn keeps the invitation staged and does not latch done', async () => {
    // The removed party's replica usually has NOT seen its removal (the cohort cut it off as
    // the removal was written), so the re-armed pass lands in the already-member arm and its
    // burn is the write the cohort refuses.
    const { db, founder, slot, reconciler } = await joinedAndDone();
    const second = await issueInvite(db, { managerKeyPair: founder });
    slot.set({ inviteKey: second.inviteKey, invitePrivateKey: second.invitePrivateKey });
    failNextWriteBatch(db, new Error('Block default/strand/ConsumedInvite is unavailable (peers-unreachable)'));

    await reconciler.rearm();

    expect(slot.staged()).toBeDefined();
    expect(await tableCount(db, 'ConsumedInvite')).toBe(1);
    expect(reconciler.done).toBe(false);
    expect(reconciler.stopped).toBe(false);

    // Once the cohort takes the write again (a manager re-admitted the party), the next pass
    // burns the leftover credential and finishes.
    await reconciler.reconcile();
    expect(slot.staged()).toBeUndefined();
    expect(await tableCount(db, 'ConsumedInvite')).toBe(2);
    expect(reconciler.done).toBe(true);
  }, 30_000);

  it('self-revoked with an invitation staged reports the blocked re-join ONCE and keeps going', async () => {
    const { db, founder } = await openClosedStrand();
    const joiner = await freshParty();
    const invite = await issueInvite(db, { managerKeyPair: founder });
    const slot = inviteSlot({ inviteKey: invite.inviteKey, invitePrivateKey: invite.invitePrivateKey });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const onRejoinBlocked = vi.fn();
    const reconciler = reconcilerOver(db, joiner.privateKey, {
      pendingInvite: slot.source,
      isSelfRevoked: () => true,
      onRejoinBlocked,
      getOwnPeerId: () => 'joiner-machine',
    });
    // The redemption is attempted — and refused, as a removed party's write would be.
    failNextWriteBatch(db, new Error('Block default/strand/Member is unavailable (peers-unreachable)'));

    await reconciler.reconcile();

    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toMatch(/^\[sereus\] strand test-strand: this party is revoked .*addMemberByManager/);
    expect(onRejoinBlocked).toHaveBeenCalledTimes(1);
    expect(slot.staged()).toBeDefined();
    expect(reconciler.stopped).toBe(false);
    expect(reconciler.done).toBe(false);

    // Still flagged revoked, the write now lands (a manager re-admitted the party and the
    // cohort takes this machine's writes again): the join completes with no second report.
    await reconciler.reconcile();
    expect(await isStrandMember(db, joiner.pair.publicKeyB64)).toBe(true);
    expect(reconciler.done).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(onRejoinBlocked).toHaveBeenCalledTimes(1);
  }, 30_000);

  it('settling an older invitation never un-stages the fresh one a re-formation staged mid-pass', async () => {
    const { db, founder } = await openClosedStrand();
    const joiner = await freshParty();
    const stale = await issueInvite(db, { managerKeyPair: founder });
    await cancelInvite(db, { managerKeyPair: founder, inviteKey: stale.inviteKey });
    const fresh = await issueInvite(db, { managerKeyPair: founder });
    const slot = inviteSlot({ inviteKey: stale.inviteKey, invitePrivateKey: stale.invitePrivateKey });
    const reconciler = reconcilerOver(db, joiner.privateKey, {
      pendingInvite: slot.source,
      getOwnPeerId: () => 'joiner-machine',
    });
    // The re-formation lands while the pass is redeeming the STALE invitation it already read.
    const exec = db.exec.bind(db);
    vi.spyOn(db, 'exec').mockImplementation((sql, params, options) => {
      if (options?.transaction === true) slot.set({ inviteKey: fresh.inviteKey, invitePrivateKey: fresh.invitePrivateKey });
      return exec(sql, params, options);
    });

    await reconciler.reconcile();

    // The stale one died (cancelled) and was dropped BY NAME; the fresh one is still staged…
    expect(slot.staged()?.inviteKey).toBe(fresh.inviteKey);
    expect(reconciler.done).toBe(false);
    // …and the next pass redeems it.
    vi.restoreAllMocks();
    await reconciler.reconcile();
    expect(await isStrandMember(db, joiner.pair.publicKeyB64)).toBe(true);
    expect(slot.staged()).toBeUndefined();
  }, 30_000);

  it('a staged invitation refused for UNFINISHED_PASSES_BEFORE_ESCALATION passes reports a PROBABLE blocked re-join once', async () => {
    const { db } = await openClosedStrand();
    const joiner = await freshParty();
    const slot = inviteSlot(phantomInvite());
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const onRejoinBlocked = vi.fn();
    const reconciler = reconcilerOver(db, joiner.privateKey, { pendingInvite: slot.source, onRejoinBlocked });

    for (let i = 0; i < UNFINISHED_PASSES_BEFORE_ESCALATION - 1; i++) {
      await reconciler.reconcile();
    }
    expect(warn).not.toHaveBeenCalled();

    for (let i = 0; i < 3; i++) {
      await reconciler.reconcile();
    }

    expect(warn).toHaveBeenCalledTimes(1);
    const warning = String(warn.mock.calls[0]![0]);
    expect(warning).toMatch(/removed from the strand/);
    expect(warning).toMatch(/not replicated here yet/);
    expect(warning).toContain('addMemberByManager');
    expect(onRejoinBlocked).toHaveBeenCalledTimes(1);
    expect(slot.staged()).toBeDefined();
    expect(reconciler.stopped).toBe(false);
  }, 30_000);
});

/**
 * A redemption only part of which was saved. Injected at `db.commit()` — where optimystic's
 * partial-commit error surfaces on a networked strand — so the writer's own rollback runs and
 * nothing lands locally, which is what this machine sees of the `Member` half that failed.
 */
describe('a half-committed join', () => {
  /**
   * Each shape the reconciler must report the same way: the observed one, the opposite one, and
   * the plugin's legacy error. For the `Member`-saved shape the manager admission below stands in
   * for the saved `Member` row appearing; the next pass treats both identically.
   */
  const shapes: { name: string; failure: () => Error; saved: string; unsaved: string }[] = [
    {
      name: 'ConsumedInvite saved, Member not (observed)',
      failure: consumedInviteSavedMemberNot,
      saved: 'Saved: [default/strand/ConsumedInvite]',
      unsaved: 'Not saved: [default/strand/Member, default/strand/Member/index/_uniq_7.stampid]',
    },
    {
      name: 'Member saved, ConsumedInvite not',
      failure: () => new CoordinatorPartialCommitError(
        ['default/strand/Member', 'default/strand/Member/index/_uniq_7.stampid'],
        ['default/strand/ConsumedInvite'],
        new Error('Stale commit for collection default/strand/ConsumedInvite'),
      ),
      saved: 'Saved: [default/strand/Member, default/strand/Member/index/_uniq_7.stampid]',
      unsaved: 'Not saved: [default/strand/ConsumedInvite]',
    },
    {
      name: 'the plugin\'s legacy PartialCommitError',
      failure: () => new PartialCommitError(['tree#1'], ['tree#0'], new Error('legacy flush failed')),
      saved: 'Saved: [tree#1]',
      unsaved: 'Not saved: [tree#0]',
    },
  ];

  for (const shape of shapes) {
    it(`${shape.name}: warns once naming both halves, drops the invitation, and keeps the loop running`, async () => {
      const { db, founder } = await openClosedStrand();
      const joiner = await freshParty();
      const invite = await issueInvite(db, { managerKeyPair: founder });
      const slot = inviteSlot({ inviteKey: invite.inviteKey, invitePrivateKey: invite.invitePrivateKey });
      const reconciler = reconcilerOver(db, joiner.privateKey, {
        pendingInvite: slot.source,
        getOwnPeerId: () => 'joiner-machine',
      });
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      failNextWriteBatch(db, viaQuereus(shape.failure()));

      const lines = await captureDebugLog(RECONCILER_NAMESPACE, () => reconciler.reconcile());

      expect(warn).toHaveBeenCalledTimes(1);
      const warning = String(warn.mock.calls[0]![0]);
      expect(warning).toMatch(/^\[sereus\] strand test-strand: /);
      expect(warning).toContain(shape.saved);
      expect(warning).toContain(shape.unsaved);
      expect(warning).toContain('addMemberByManager');
      expect(slot.staged()).toBeUndefined();
      expect(reconciler.done).toBe(false);
      expect(reconciler.stopped).toBe(false);
      expect(lines.some(line => DEAD_INVITE_LINE.test(line))).toBe(false);

      // A Member row appears — a manager's admission, or the half that was saved — and the
      // next pass writes this machine's binding and finishes, with no second warning.
      await addMemberByManager(db, { managerKeyPair: founder, memberKey: joiner.pair.publicKeyB64 });
      await reconciler.reconcile();

      expect(reconciler.done).toBe(true);
      expect(await tableCount(db, 'MemberPeer')).toBe(1);
      expect(warn).toHaveBeenCalledTimes(1);
    }, 30_000);
  }

  it('with no Member row arriving, the loop idles on the flat poll interval instead of retrying the spent invitation', async () => {
    const { db, founder } = await openClosedStrand();
    const joiner = await freshParty();
    const invite = await issueInvite(db, { managerKeyPair: founder });
    const slot = inviteSlot({ inviteKey: invite.inviteKey, invitePrivateKey: invite.invitePrivateKey });
    const clock = manualScheduler();
    const reconciler = reconcilerOver(db, joiner.privateKey, {
      pendingInvite: slot.source,
      scheduler: clock.scheduler,
      pollIntervalMs: 4_000,
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const writes = failNextWriteBatch(db, viaQuereus(consumedInviteSavedMemberNot()));

    reconciler.start();
    await reconciler.settle();           // the half-commit: one ladder rung
    clock.tick();
    await reconciler.settle();           // nothing staged, no member row: idle

    expect(clock.delays()).toEqual([INITIAL_JOIN_RETRY_INTERVAL_MS, 4_000]);
    expect(writes.batches()).toBe(1);
    expect(reconciler.stopped).toBe(false);
  }, 30_000);
});

/**
 * {@link classifyConsumeFailure} against the REAL engine's rejections. The message texts are pinned
 * here on purpose: the classifier matches them, so a rewording in Quereus fails this block rather
 * than silently turning a dead invitation into an endless retry.
 */
describe('consume rejection classification', () => {
  it('expired: CHECK constraint failed: NotExpired → dead invitation', async () => {
    const { db, founder } = await openClosedStrand();
    const invite = await issueInvite(db, { managerKeyPair: founder, expiration: Date.now() - 60_000 });

    const error = await consumeRejection(db, invite);

    expect(error.message).toBe('CHECK constraint failed: NotExpired');
    expect(classifyConsumeFailure(error)).toEqual({ kind: 'dead-invite' });
  }, 30_000);

  it('cancelled: CHECK constraint failed: NotCancelled → dead invitation', async () => {
    const { db, founder } = await openClosedStrand();
    const invite = await issueInvite(db, { managerKeyPair: founder });
    await cancelInvite(db, { managerKeyPair: founder, inviteKey: invite.inviteKey });

    const error = await consumeRejection(db, invite);

    expect(error.message).toBe('CHECK constraint failed: NotCancelled');
    expect(classifyConsumeFailure(error)).toEqual({ kind: 'dead-invite' });
  }, 30_000);

  it('consumed by another party: UNIQUE constraint failed: ConsumedInvite.InviteKey → dead invitation', async () => {
    const { db, founder } = await openClosedStrand();
    const invite = await issueInvite(db, { managerKeyPair: founder });
    const winner = await freshParty();
    await consumeInvite(db, {
      inviteKey: invite.inviteKey,
      invitePrivateKey: invite.invitePrivateKey,
      memberKey: winner.pair.publicKeyB64,
    });

    const error = await consumeRejection(db, invite);

    expect(error.message).toBe('UNIQUE constraint failed: ConsumedInvite.InviteKey');
    expect(classifyConsumeFailure(error)).toEqual({ kind: 'dead-invite' });
  }, 30_000);

  it('sealed: CHECK constraint failed: NotSealed → sealed', async () => {
    const { db, founder } = await openClosedStrand();
    const invite = await issueInvite(db, { managerKeyPair: founder });
    await sealStrand(db, { managerKeyPair: founder });

    const error = await consumeRejection(db, invite);

    // The engine appends the constraint's expression, which follows the schema; the prefix is the contract.
    expect(error.message.startsWith('CHECK constraint failed: NotSealed')).toBe(true);
    expect(classifyConsumeFailure(error)).toEqual({ kind: 'sealed' });
  }, 30_000);

  it('an invitation not yet replicated here: CHECK constraint failed: InviteExists → retry', async () => {
    const { db } = await openClosedStrand();

    const error = await consumeRejection(db, phantomInvite());

    expect(error.message).toBe('CHECK constraint failed: InviteExists');
    expect(classifyConsumeFailure(error)).toEqual({ kind: 'retry' });
  }, 30_000);

  it('a partial commit is half-committed by type, bare or wrapped, although its message names ConsumedInvite', () => {
    const partial = consumedInviteSavedMemberNot();
    const expected = {
      kind: 'half-committed',
      saved: ['default/strand/ConsumedInvite'],
      unsaved: ['default/strand/Member', 'default/strand/Member/index/_uniq_7.stampid'],
    };

    expect(partial.message).toContain('default/strand/ConsumedInvite');
    for (const delivered of [partial, viaQuereus(partial), new Error('rewrapped', { cause: viaQuereus(partial) })]) {
      expect(classifyConsumeFailure(delivered)).toEqual(expected);
    }
  });

  it('the plugin\'s legacy PartialCommitError is half-committed, reporting its persisted and unpersisted trees', () => {
    const partial = new PartialCommitError(['tree#1'], ['tree#0'], new Error('legacy flush failed'));

    expect(classifyConsumeFailure(viaQuereus(partial))).toEqual({ kind: 'half-committed', saved: ['tree#1'], unsaved: ['tree#0'] });
  });

  it('a partial commit carrying a dead-invitation text in its underlying failure is still half-committed', () => {
    // Typed checks run before text checks: the embedded constraint text must not win.
    const partial = new CoordinatorPartialCommitError(['default/strand/ConsumedInvite'], ['default/strand/Member'],
      new Error('UNIQUE constraint failed: ConsumedInvite.InviteKey'));

    expect(classifyConsumeFailure(viaQuereus(partial)).kind).toBe('half-committed');
  });

  it('a writer refused by an open transaction is busy, bare or wrapped, before any text check', async () => {
    const { db, founder } = await openClosedStrand();
    const invite = await issueInvite(db, { managerKeyPair: founder });
    const party = await freshParty();

    await db.beginTransaction();
    const refusal: unknown = await consumeInvite(db, {
      inviteKey: invite.inviteKey,
      invitePrivateKey: invite.invitePrivateKey,
      memberKey: party.pair.publicKeyB64,
    }, { joinOpenTransaction: false }).then(() => 'resolved', (error: unknown) => error);
    await db.rollback();

    expect(refusal).toBeInstanceOf(StrandTransactionBusyError);
    expect(classifyConsumeFailure(refusal)).toEqual({ kind: 'busy' });
    expect(classifyConsumeFailure(new Error('rewrapped', { cause: refusal }))).toEqual({ kind: 'busy' });
  }, 30_000);

  it('the bare table name no longer classifies a failure as a dead invitation', () => {
    expect(classifyConsumeFailure(new Error('Stale commit for collection default/strand/ConsumedInvite')))
      .toEqual({ kind: 'retry' });
  });
});

describe('retry scheduling', () => {
  it('start() kicks an immediate pass, and reaching the done state arms no timer at all', async () => {
    const strand = await openClosedStrand();
    const clock = manualScheduler();
    const reconciler = reconcilerOver(strand.db, strand.founderPrivateKey, {
      scheduler: clock.scheduler,
      getOwnPeerId: () => 'founder-machine',
    });

    reconciler.start();
    // start() returned synchronously with the pass still in flight — bring-up is
    // never blocked on it; settling the chain shows the pass really ran.
    await reconciler.settle();

    expect(reconciler.done).toBe(true);
    expect(clock.delays()).toEqual([]);
    expect(clock.pending()).toBe(false);
  }, 30_000);

  it('a joiner nobody has admitted yet re-arms at the flat poll interval (the 30 s default)', async () => {
    const { db } = await openClosedStrand();
    const joiner = await freshParty();
    const clock = manualScheduler();
    const reconciler = reconcilerOver(db, joiner.privateKey, { scheduler: clock.scheduler });

    reconciler.start();
    await reconciler.settle();

    // No member row and no staged invitation: nothing this machine can do faster, so
    // the ladder is not used and the idle cadence is what re-arms.
    expect(clock.armedMs()).toBe(DEFAULT_REVOCATION_POLL_INTERVAL_MS);
    expect(reconciler.done).toBe(false);
  }, 30_000);

  it('an UNFINISHED join climbs a doubling ladder capped at the poll interval, and idling resets it', async () => {
    const { db } = await openClosedStrand();
    const joiner = await freshParty();
    // A credential whose Invite row this replica has never seen: consumeInvite fails the
    // deferred InviteExists every pass, which is the "the invitation has not replicated
    // here yet" state the ladder exists for.
    const phantom = phantomInvite();
    const slot = inviteSlot();
    const clock = manualScheduler();
    const reconciler = reconcilerOver(db, joiner.privateKey, {
      pendingInvite: slot.source,
      scheduler: clock.scheduler,
      pollIntervalMs: 4_000,
      getOwnPeerId: () => 'joiner-machine',
    });

    reconciler.start();
    await reconciler.settle();           // idle (nothing staged yet) → flat interval

    slot.set(phantom);
    for (let i = 0; i < 3; i++) {        // three failing redemptions → 1s, 2s, 4s (capped)
      clock.tick();
      await reconciler.settle();
    }

    slot.set(undefined);                 // the invitation was dropped: back to waiting
    clock.tick();
    await reconciler.settle();

    slot.set(phantom);                   // a re-formation stages another: ladder from the bottom
    clock.tick();
    await reconciler.settle();

    expect(clock.delays()).toEqual([4_000, 1_000, 2_000, 4_000, 4_000, 1_000]);
    expect(reconciler.done).toBe(false);
    expect(reconciler.stopped).toBe(false);
  }, 30_000);

  it('a pass with no live database retries on the LADDER, not the idle interval', async () => {
    // The gated-joiner shape: the first-sync write gate still withholds the database, so
    // the loop's own first pass finds none. That is an unfinished join, not a wait to be
    // admitted — see `StrandInstanceManager.publishDatabase`, which kicks it the moment
    // the database appears.
    const strand = await openClosedStrand();
    let live: Database | undefined = undefined;
    const clock = manualScheduler();
    const reconciler = reconcilerOver(undefined, strand.founderPrivateKey, {
      getDatabase: () => live,
      scheduler: clock.scheduler,
      getOwnPeerId: () => 'founder-machine',
    });

    reconciler.start();
    await reconciler.settle();
    expect(clock.armedMs()).toBe(INITIAL_JOIN_RETRY_INTERVAL_MS);
    expect(clock.pending()).toBe(true);

    // The publish kick: an explicit reconcile() once the database is live REPLACES the
    // pending timer rather than running alongside it.
    live = strand.db;
    await reconciler.reconcile();

    expect(reconciler.done).toBe(true);
    expect(clock.pending()).toBe(false);
    expect(clock.delays()).toEqual([INITIAL_JOIN_RETRY_INTERVAL_MS]);
    expect(await tableCount(strand.db, 'MemberPeer')).toBe(1);
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

  it('stop() DURING an unfinished pass leaves no timer behind', async () => {
    // The clearOwnMemberPeerBinding race on a pass that will NOT reach the done state:
    // its `finally` still runs, and must not resurrect a retry timer against an instance
    // the caller is tearing down. (The done-state sibling above cannot show this — a done
    // pass declines to re-arm for its own reason.)
    const { db } = await openClosedStrand();
    const joiner = await freshParty();
    const clock = manualScheduler();
    const reconciler: StrandMembershipReconciler = reconcilerOver(db, joiner.privateKey, {
      scheduler: clock.scheduler,
      getDatabase: () => { reconciler.stop(); return db; },
    });

    reconciler.start();
    await reconciler.settle();

    expect(reconciler.done).toBe(false);
    expect(reconciler.stopped).toBe(true);
    expect(clock.delays()).toEqual([]);
    expect(clock.pending()).toBe(false);
  }, 30_000);

  it('stop() disarms the retry timer and later passes are inert', async () => {
    const { db } = await openClosedStrand();
    const joiner = await freshParty();
    const clock = manualScheduler();
    const reconciler = reconcilerOver(db, joiner.privateKey, { scheduler: clock.scheduler });

    reconciler.start();
    await reconciler.settle();
    expect(clock.pending()).toBe(true);

    reconciler.stop();

    expect(clock.pending()).toBe(false);
    await reconciler.reconcile();
    expect(reconciler.done).toBe(false);
    expect(clock.pending()).toBe(false);
  }, 30_000);
});
