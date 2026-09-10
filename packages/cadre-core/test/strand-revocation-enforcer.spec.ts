import { describe, it, expect, vi } from 'vitest';
import type { ConnectionGater, MultiaddrConnection, PeerId } from '@libp2p/interface';
import type { Database } from '@quereus/quereus';
import {
  StrandRevocationEnforcer,
  createRevocationConnectionGater,
  readStrandRevocationRows,
  DEFAULT_REVOCATION_POLL_INTERVAL_MS,
  type StrandRevocationRows,
  type StrandRevocationNetwork,
  type StrandRevocationEnforcerDeps,
  type RevocationRefreshScheduler
} from '../src/strand-revocation-enforcer.js';
import {
  addMemberByManager,
  revokeMember,
  leaveStrand,
  registerMemberPeer
} from '../src/strand-membership-writer.js';
import { freshKeyPair, openStrand } from './strand-spec-helpers.js';

/**
 * Component coverage for the closed-strand revoked-peer gate: the deny-set
 * derivation, the refresh contract (serialized; a failed read keeps the
 * previous snapshot; interval honored via the injected scheduler), the
 * synchronous stream predicate, and the connection-gater composition.
 *
 * The pure sections drive an injected `readRows` — no database, no libp2p. The
 * final section derives the deny set from a REAL closed strand DB via the
 * production `readStrandRevocationRows`, exercising the actual writer flows
 * (manager revocation, self-departure, re-admission) end to end at the row
 * level; the real-network proof is the e2e ticket.
 */

function rows(memberKeys: string[], bindings: Array<[memberKey: string, peerId: string]>): StrandRevocationRows {
  return {
    memberKeys: new Set(memberKeys),
    bindings: bindings.map(([memberKey, peerId]) => ({ memberKey, peerId }))
  };
}

function enforcerOver(source: StrandRevocationRows | (() => Promise<StrandRevocationRows>)): StrandRevocationEnforcer {
  const readRows = typeof source === 'function' ? source : async () => source;
  return new StrandRevocationEnforcer({ label: 'test-strand', readRows });
}

/** A minimal PeerId double — the gater only ever calls toString(). */
function pid(id: string): PeerId {
  return { toString: () => id } as PeerId;
}

const maConn = {} as MultiaddrConnection;

describe('deny-set derivation', () => {
  it('denies a peer whose member key has no live Member row (orphaned binding)', async () => {
    const enforcer = enforcerOver(rows(['live-key'], [['gone-key', 'orphan-peer'], ['live-key', 'live-peer']]));
    await enforcer.refresh();

    expect(enforcer.isRevoked('orphan-peer')).toBe(true);
    expect(enforcer.isRevoked('live-peer')).toBe(false);
  });

  it('admits everyone on empty tables (open strand / nothing revoked — same code path)', async () => {
    const enforcer = enforcerOver(rows([], []));
    await enforcer.refresh();

    expect(enforcer.revokedCount).toBe(0);
    expect(enforcer.isRevoked('anyone')).toBe(false);
  });

  it('denies EVERY binding of a multi-machine removed party (per-binding, not per-member)', async () => {
    // On a two-party strand where both sides revoke each other from divergent
    // views, each side's set gains the other's peers this same way — a permanent
    // mutual cut, which is converged enough: both wanted out. No special handling.
    const enforcer = enforcerOver(rows([], [['gone-key', 'machine-1'], ['gone-key', 'machine-2']]));
    await enforcer.refresh();

    expect(enforcer.isRevoked('machine-1')).toBe(true);
    expect(enforcer.isRevoked('machine-2')).toBe(true);
  });

  it('admits a peer bound to TWO member keys when one is still live (the live binding wins)', async () => {
    const enforcer = enforcerOver(rows(['live-key'], [['live-key', 'shared-peer'], ['gone-key', 'shared-peer']]));
    await enforcer.refresh();

    expect(enforcer.isRevoked('shared-peer')).toBe(false);
  });

  it('clears a peer from the set once its member key is re-admitted (deny, re-add, admit)', async () => {
    let current = rows([], [['party-key', 'party-peer']]);
    const enforcer = enforcerOver(() => Promise.resolve(current));

    await enforcer.refresh();
    expect(enforcer.isRevoked('party-peer')).toBe(true);

    // Re-admission mints a fresh Member row for the same key → the old binding
    // stops being an orphan on the next refresh.
    current = rows(['party-key'], [['party-key', 'party-peer']]);
    await enforcer.refresh();
    expect(enforcer.isRevoked('party-peer')).toBe(false);
  });
});

describe('stream predicate (authorizeStream)', () => {
  it('is synchronous — a live DB read inside the gate would deadlock', async () => {
    const enforcer = enforcerOver(rows([], [['gone', 'p1']]));
    await enforcer.refresh();

    const verdict = enforcer.authorizeStream('p1', '/optimystic/strand-x/repo/1.0.0');
    expect(typeof verdict).toBe('boolean');
  });

  it('denies exactly the snapshot and admits everyone else', async () => {
    const enforcer = enforcerOver(rows(['live'], [['gone', 'revoked-peer'], ['live', 'member-peer']]));
    await enforcer.refresh();

    expect(enforcer.authorizeStream('revoked-peer', 'proto')).toBe(false);
    expect(enforcer.authorizeStream('member-peer', 'proto')).toBe(true);
    expect(enforcer.authorizeStream('total-stranger', 'proto')).toBe(true);
  });

  it('admits everyone before the first successful read (empty snapshot = fail-open bring-up)', () => {
    const enforcer = enforcerOver(rows([], [['gone', 'p1']]));
    // No refresh: a freshly built enforcer (bring-up, or a quiesce → resume
    // rebuild) starts empty and must not deny.
    expect(enforcer.authorizeStream('p1', 'proto')).toBe(true);
  });
});

describe('refresh contract', () => {
  it('a failed read keeps the previous snapshot — never clears it', async () => {
    let fail = false;
    const enforcer = enforcerOver(() => {
      if (fail) return Promise.reject(new Error('db unreadable'));
      return Promise.resolve(rows([], [['gone', 'p1']]));
    });

    await enforcer.refresh();
    expect(enforcer.isRevoked('p1')).toBe(true);

    fail = true;
    await enforcer.refresh();
    expect(enforcer.isRevoked('p1')).toBe(true);
  });

  it('refresh() never rejects, even when the read does', async () => {
    const enforcer = enforcerOver(() => Promise.reject(new Error('boom')));
    await expect(enforcer.refresh()).resolves.toBeUndefined();
  });

  it('serializes refreshes — no two reads in flight, and a queued call still gets its own read', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    let reads = 0;
    const release: Array<() => void> = [];
    const enforcer = enforcerOver(() => {
      reads += 1;
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      return new Promise<StrandRevocationRows>((resolve) => {
        release.push(() => {
          inFlight -= 1;
          resolve(rows([], []));
        });
      });
    });

    const first = enforcer.refresh();
    const second = enforcer.refresh();
    // Only the first read starts (on a microtask); the second is chained behind it.
    await vi.waitFor(() => expect(reads).toBe(1));

    release[0]!();
    await first;
    // The second call runs its OWN read after the first completes — an
    // on-demand refresh after a revocation commit must observe that commit,
    // not share a read that started before it.
    await vi.waitFor(() => expect(reads).toBe(2));
    release[1]!();
    await second;

    expect(maxInFlight).toBe(1);
  });

  it('start() arms the poll at the configured cadence (injected scheduler) and kicks an immediate refresh', async () => {
    let reads = 0;
    const scheduled: Array<{ fn: () => void; ms: number }> = [];
    const cleared: unknown[] = [];
    const scheduler: RevocationRefreshScheduler = {
      setInterval: (fn, ms) => {
        const handle = { fn, ms };
        scheduled.push(handle);
        return handle;
      },
      clearInterval: (handle) => cleared.push(handle)
    };
    const enforcer = new StrandRevocationEnforcer(
      { label: 't', readRows: async () => { reads += 1; return rows([], []); }, scheduler },
      { pollIntervalMs: 1234 }
    );

    enforcer.start();
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]!.ms).toBe(1234);
    await vi.waitFor(() => expect(reads).toBe(1));

    // An interval tick drives a refresh.
    scheduled[0]!.fn();
    await vi.waitFor(() => expect(reads).toBe(2));

    // stop() disarms the very handle it armed.
    enforcer.stop();
    expect(cleared).toEqual([scheduled[0]]);
  });

  it('defaults the cadence to DEFAULT_REVOCATION_POLL_INTERVAL_MS', () => {
    const scheduled: number[] = [];
    const scheduler: RevocationRefreshScheduler = {
      setInterval: (_fn, ms) => { scheduled.push(ms); return ms; },
      clearInterval: () => {}
    };
    const enforcer = new StrandRevocationEnforcer(
      { label: 't', readRows: async () => rows([], []), scheduler }
    );

    enforcer.start();
    enforcer.stop();
    expect(scheduled).toEqual([DEFAULT_REVOCATION_POLL_INTERVAL_MS]);
  });

  it('discards a read that lands after stop() — a torn-down enforcer never repopulates', async () => {
    let release: (rows: StrandRevocationRows) => void = () => {};
    const enforcer = enforcerOver(() => new Promise<StrandRevocationRows>((resolve) => { release = resolve; }));

    const inFlight = enforcer.refresh();
    enforcer.stop();
    release(rows([], [['gone', 'peer-x']]));
    await inFlight;

    expect(enforcer.revokedCount).toBe(0);
    expect(enforcer.isRevoked('peer-x')).toBe(false);
  });

  it('an interval tick is skipped (not queued) while a refresh is already in flight', async () => {
    let reads = 0;
    let releaseFirstRead: (() => void) | undefined;
    const scheduled: Array<() => void> = [];
    const scheduler: RevocationRefreshScheduler = {
      setInterval: (fn) => { scheduled.push(fn); return fn; },
      clearInterval: () => {}
    };
    const enforcer = new StrandRevocationEnforcer({
      label: 't',
      readRows: () => {
        reads += 1;
        // Only the FIRST read blocks (it is what the tick must find in flight);
        // later reads resolve immediately so the wrap-up refresh below completes.
        if (reads === 1) {
          return new Promise<StrandRevocationRows>((resolve) => {
            releaseFirstRead = () => resolve(rows([], []));
          });
        }
        return Promise.resolve(rows([], []));
      },
      scheduler
    });

    enforcer.start();
    await vi.waitFor(() => expect(reads).toBe(1));

    // Tick while the start() refresh is still reading: skipped, no pileup.
    scheduled[0]!();
    expect(reads).toBe(1);

    releaseFirstRead!();
    await enforcer.refresh();
    expect(reads).toBe(2);
    enforcer.stop();
  });
});

/**
 * The TEARDOWN half of enforcement: what happens to sessions that are already
 * OPEN when a revocation lands. The enforcer takes `{ peerId, getConnections,
 * hangUp }` rather than a whole libp2p node precisely so this needs no
 * transport — a stub proves the sweep's decisions; that `hangUp` really closes
 * a RELAYED connection (and the relay reservation riding it) is libp2p's
 * contract, proven on a real relay by the e2e ticket.
 */
describe('teardown sweep', () => {
  const SELF = 'self-peer';

  function fakeNetwork(connected: string[] = []) {
    const connections = connected.map((peerId) => ({ remotePeer: pid(peerId) }));
    const hangUp = vi.fn(async (_peer: PeerId) => {});
    const network: StrandRevocationNetwork = {
      peerId: pid(SELF),
      getConnections: () => connections,
      hangUp
    };
    return { network, hangUp, connections };
  }

  /** The peer ids handed to hangUp, in call order. */
  function hungUp(hangUp: { mock: { calls: unknown[][] } }): string[] {
    return hangUp.mock.calls.map((call) => String(call[0]));
  }

  function enforcerWith(
    source: StrandRevocationRows,
    deps: Partial<StrandRevocationEnforcerDeps> = {}
  ): StrandRevocationEnforcer {
    return new StrandRevocationEnforcer({ label: 'teardown', readRows: async () => source, ...deps });
  }

  it('hangs up a newly revoked peer that is connected, and leaves a live member alone', async () => {
    const { network, hangUp } = fakeNetwork(['bad-peer', 'good-peer']);
    const enforcer = enforcerWith(
      rows(['live'], [['gone', 'bad-peer'], ['live', 'good-peer']]),
      { getNetwork: () => network }
    );

    // refresh() resolves only after the sweep — that is what makes "revoke, then
    // refreshRevocationEnforcement()" an immediate cut for the caller.
    await enforcer.refresh();

    expect(hungUp(hangUp)).toEqual(['bad-peer']);
  });

  it('does not call hangUp for a revoked peer with no open connection', async () => {
    const { network, hangUp } = fakeNetwork(['good-peer']);
    const enforcer = enforcerWith(rows(['live'], [['gone', 'bad-peer'], ['live', 'good-peer']]), {
      getNetwork: () => network
    });

    await enforcer.refresh();

    expect(hangUp).not.toHaveBeenCalled();
  });

  it('sweeps by MEMBERSHIP, not by an entered-the-set diff', async () => {
    // The peer is revoked while disconnected, so no diff pass would ever fire
    // for it again — a later connection (a resume, a missed refresh, a
    // reconnection between ticks) must still be cut.
    const { network, hangUp, connections } = fakeNetwork([]);
    const enforcer = enforcerWith(rows([], [['gone', 'bad-peer']]), { getNetwork: () => network });

    await enforcer.refresh();
    expect(hangUp).not.toHaveBeenCalled();

    connections.push({ remotePeer: pid('bad-peer') });
    await enforcer.refresh();

    expect(hungUp(hangUp)).toEqual(['bad-peer']);
  });

  it('hangs up every machine of a multi-machine removed party', async () => {
    const { network, hangUp } = fakeNetwork(['machine-1', 'machine-2', 'good-peer']);
    const enforcer = enforcerWith(
      rows(['live'], [['gone', 'machine-1'], ['gone', 'machine-2'], ['live', 'good-peer']]),
      { getNetwork: () => network }
    );

    await enforcer.refresh();

    expect(hungUp(hangUp).sort()).toEqual(['machine-1', 'machine-2']);
  });

  it('issues ONE hangUp for a peer holding two connections (direct + relayed)', async () => {
    // libp2p's hangUp closes every connection to the peer, relayed included —
    // hence one call, not one per connection.
    const { network, hangUp } = fakeNetwork(['bad-peer', 'bad-peer']);
    const enforcer = enforcerWith(rows([], [['gone', 'bad-peer']]), { getNetwork: () => network });

    await enforcer.refresh();

    expect(hungUp(hangUp)).toEqual(['bad-peer']);
  });

  it('survives a rejected hangUp and retries it on the next refresh', async () => {
    const { network, hangUp } = fakeNetwork(['bad-peer']);
    hangUp.mockRejectedValue(new Error('connection already closing'));
    const enforcer = enforcerWith(rows([], [['gone', 'bad-peer']]), { getNetwork: () => network });

    await expect(enforcer.refresh()).resolves.toBeUndefined();
    await enforcer.refresh();

    expect(hangUp).toHaveBeenCalledTimes(2);
  });

  it('survives a getConnections that throws — that pass tears nothing down', async () => {
    const hangUp = vi.fn(async (_peer: PeerId) => {});
    const network: StrandRevocationNetwork = {
      peerId: pid(SELF),
      getConnections: () => { throw new Error('node stopping'); },
      hangUp
    };
    const enforcer = enforcerWith(rows([], [['gone', 'bad-peer']]), { getNetwork: () => network });

    await expect(enforcer.refresh()).resolves.toBeUndefined();

    expect(hangUp).not.toHaveBeenCalled();
    expect(enforcer.isRevoked('bad-peer')).toBe(true);
  });

  it('is inert while the strand is quiesced (no live node to sweep)', async () => {
    const enforcer = enforcerWith(rows([], [['gone', 'bad-peer']]), { getNetwork: () => undefined });

    await expect(enforcer.refresh()).resolves.toBeUndefined();
    expect(enforcer.isRevoked('bad-peer')).toBe(true);
  });

  it('a getNetwork accessor that throws costs only that pass', async () => {
    const enforcer = enforcerWith(rows([], [['gone', 'bad-peer']]), {
      getNetwork: () => { throw new Error('no database'); }
    });

    await expect(enforcer.refresh()).resolves.toBeUndefined();
  });

  it('does not sweep when stop() lands before the read completes', async () => {
    const { network, hangUp } = fakeNetwork(['bad-peer']);
    let release: (result: StrandRevocationRows) => void = () => {};
    const enforcer = new StrandRevocationEnforcer({
      label: 'teardown',
      readRows: () => new Promise<StrandRevocationRows>((resolve) => { release = resolve; }),
      getNetwork: () => network
    });

    const inFlight = enforcer.refresh();
    enforcer.stop();
    release(rows([], [['gone', 'bad-peer']]));
    await inFlight;

    expect(hangUp).not.toHaveBeenCalled();
  });

  it('sweeps the connection list enumerated at the start of the pass', async () => {
    // A connection that opens mid-sweep belongs to the NEXT pass: the list is
    // taken once, from the same snapshot the refresh produced, so a peer
    // re-admitted between the read and the hangUp is at worst cut once.
    const { network, hangUp, connections } = fakeNetwork(['bad-peer-1']);
    hangUp.mockImplementation(async () => {
      connections.push({ remotePeer: pid('bad-peer-2') });
    });
    const enforcer = enforcerWith(
      rows([], [['gone', 'bad-peer-1'], ['gone', 'bad-peer-2']]),
      { getNetwork: () => network }
    );

    await enforcer.refresh();
    expect(hungUp(hangUp)).toEqual(['bad-peer-1']);

    await enforcer.refresh();
    expect(hungUp(hangUp)).toEqual(['bad-peer-1', 'bad-peer-1', 'bad-peer-2']);
  });

  describe('self-revocation', () => {
    it('signals ONCE however many refreshes find this node revoked, and tears nothing down', async () => {
      const onSelfRevoked = vi.fn();
      const { network, hangUp } = fakeNetwork([]);
      const enforcer = enforcerWith(rows([], [['gone', SELF]]), { getNetwork: () => network, onSelfRevoked });

      await enforcer.refresh();
      await enforcer.refresh();

      expect(onSelfRevoked).toHaveBeenCalledTimes(1);
      expect(hangUp).not.toHaveBeenCalled();
    });

    it('never hangs up its own peer id even if a self-connection is reported', async () => {
      const { network, hangUp } = fakeNetwork([SELF]);
      const enforcer = enforcerWith(rows([], [['gone', SELF]]), { getNetwork: () => network });

      await enforcer.refresh();

      expect(hangUp).not.toHaveBeenCalled();
    });

    it('still sweeps OTHER revoked peers in the pass that finds itself revoked', async () => {
      const onSelfRevoked = vi.fn();
      const { network, hangUp } = fakeNetwork(['bad-peer']);
      const enforcer = enforcerWith(rows([], [['gone', SELF], ['gone', 'bad-peer']]), {
        getNetwork: () => network,
        onSelfRevoked
      });

      await enforcer.refresh();

      expect(onSelfRevoked).toHaveBeenCalledTimes(1);
      expect(hungUp(hangUp)).toEqual(['bad-peer']);
    });

    it('a throwing handler does not derail the sweep', async () => {
      const { network, hangUp } = fakeNetwork(['bad-peer']);
      const enforcer = enforcerWith(rows([], [['gone', SELF], ['gone', 'bad-peer']]), {
        getNetwork: () => network,
        onSelfRevoked: () => { throw new Error('app handler broke'); }
      });

      await expect(enforcer.refresh()).resolves.toBeUndefined();
      expect(hungUp(hangUp)).toEqual(['bad-peer']);
    });

    it('re-arms on re-admission, so a SECOND removal signals again', async () => {
      // A manager can re-admit a party it removed (a fresh Member row makes the
      // orphaned bindings live again); the latch tracks the transition INTO the
      // set, not the enforcer's lifetime, so the second removal is reported too.
      const onSelfRevoked = vi.fn();
      const { network } = fakeNetwork([]);
      let source = rows([], [['gone', SELF]]);
      const enforcer = new StrandRevocationEnforcer({
        label: 'teardown',
        readRows: async () => source,
        getNetwork: () => network,
        onSelfRevoked
      });

      await enforcer.refresh();
      source = rows(['gone'], [['gone', SELF]]);
      await enforcer.refresh();
      source = rows([], [['gone', SELF]]);
      await enforcer.refresh();

      expect(onSelfRevoked).toHaveBeenCalledTimes(2);
    });

    it('does not fire for a node that is merely not a member of anything', async () => {
      const onSelfRevoked = vi.fn();
      const { network } = fakeNetwork([]);
      const enforcer = enforcerWith(rows(['live'], [['live', 'good-peer']]), {
        getNetwork: () => network,
        onSelfRevoked
      });

      await enforcer.refresh();

      expect(onSelfRevoked).not.toHaveBeenCalled();
    });
  });
});

describe('connection gater composition', () => {
  async function revokedEnforcer(...revoked: string[]): Promise<StrandRevocationEnforcer> {
    const enforcer = enforcerOver(rows([], revoked.map((peerId) => ['gone', peerId])));
    await enforcer.refresh();
    return enforcer;
  }

  it('denies a revoked peer on all three composed hooks', async () => {
    const gater = createRevocationConnectionGater(await revokedEnforcer('bad-peer'));

    expect(await gater.denyDialPeer?.(pid('bad-peer'))).toBe(true);
    expect(await gater.denyInboundEncryptedConnection?.(pid('bad-peer'), maConn)).toBe(true);
    expect(await gater.denyInboundRelayReservation?.(pid('bad-peer'))).toBe(true);
  });

  it('admits an unrevoked peer on all three composed hooks', async () => {
    const gater = createRevocationConnectionGater(await revokedEnforcer('bad-peer'));

    expect(await gater.denyDialPeer?.(pid('good-peer'))).toBe(false);
    expect(await gater.denyInboundEncryptedConnection?.(pid('good-peer'), maConn)).toBe(false);
    expect(await gater.denyInboundRelayReservation?.(pid('good-peer'))).toBe(false);
  });

  it('honors a base-gater deny even for an unrevoked peer (deny from either denies)', async () => {
    const base: ConnectionGater = {
      denyDialPeer: () => true,
      denyInboundEncryptedConnection: () => true,
      denyInboundRelayReservation: () => true
    };
    const gater = createRevocationConnectionGater(await revokedEnforcer(), base);

    expect(await gater.denyDialPeer?.(pid('anyone'))).toBe(true);
    expect(await gater.denyInboundEncryptedConnection?.(pid('anyone'), maConn)).toBe(true);
    expect(await gater.denyInboundRelayReservation?.(pid('anyone'))).toBe(true);
  });

  it('a base-gater error is fail-open for the base, and the revocation check still runs', async () => {
    const base: ConnectionGater = {
      denyDialPeer: () => { throw new Error('base broke'); }
    };
    const gater = createRevocationConnectionGater(await revokedEnforcer('bad-peer'), base);

    // Base error + unrevoked peer → admitted (fail-open).
    expect(await gater.denyDialPeer?.(pid('good-peer'))).toBe(false);
    // Base error + revoked peer → the revocation layer still denies.
    expect(await gater.denyDialPeer?.(pid('bad-peer'))).toBe(true);
  });

  it('a revocation-check error is fail-open — the stream gate stands behind it', async () => {
    const gater = createRevocationConnectionGater({ isRevoked: () => { throw new Error('judge broke'); } });

    expect(await gater.denyDialPeer?.(pid('anyone'))).toBe(false);
    expect(await gater.denyInboundEncryptedConnection?.(pid('anyone'), maConn)).toBe(false);
    expect(await gater.denyInboundRelayReservation?.(pid('anyone'))).toBe(false);
  });

  it('preserves every base hook it does not compose (the RN/web permissive gater keeps working)', async () => {
    let called = false;
    const base: ConnectionGater = { denyDialMultiaddr: () => { called = true; return false; } };
    const gater = createRevocationConnectionGater(await revokedEnforcer(), base);

    const denied = await gater.denyDialMultiaddr?.(
      {} as Parameters<NonNullable<ConnectionGater['denyDialMultiaddr']>>[0]
    );

    expect(called).toBe(true);
    expect(denied).toBe(false);
  });
});

/**
 * A `Database` double whose membership tables gain a newly joined member
 * (`M2` + its binding `P2`) the moment the FIRST of the two scans has been
 * issued — so one table is read pre-join and the other post-join. Nothing holds
 * the two scans to a single snapshot in production either, which is why
 * `readStrandRevocationRows` fixes their order.
 */
function joinBetweenScansDb(): Database {
  let scansIssued = 0;
  const joined = (): boolean => scansIssued > 1;
  return {
    eval: (sql: string) => {
      scansIssued++;
      const rows = sql.includes('Strand.MemberPeer')
        ? (joined()
          ? [{ MemberKey: 'M1', PeerId: 'P1' }, { MemberKey: 'M2', PeerId: 'P2' }]
          : [{ MemberKey: 'M1', PeerId: 'P1' }])
        : (joined() ? [{ Key: 'M1' }, { Key: 'M2' }] : [{ Key: 'M1' }]);
      return (async function* () { yield* rows; })();
    }
  } as unknown as Database;
}

describe('read skew between the two scans (readStrandRevocationRows ordering)', () => {
  it('admits a member that joins mid-read — the skew window must never fail CLOSED', async () => {
    // Bindings are scanned FIRST, so the joiner's binding is simply absent from
    // the older snapshot. Scanning Member first would instead pair the newer
    // binding with the older key set and revoke a brand-new member.
    const rows = await readStrandRevocationRows(joinBetweenScansDb());
    const enforcer = enforcerOver(rows);
    await enforcer.refresh();

    expect(enforcer.isRevoked('P2')).toBe(false);
    expect(enforcer.revokedCount).toBe(0);
  });
});

describe('deny-set derivation from a REAL closed strand DB (readStrandRevocationRows)', () => {
  it('manager revocation denies every peer of the removed party; re-admission clears them', async () => {
    const { db, founder } = await openStrand('c');
    await registerMemberPeer(db, { memberKeyPair: founder, peerId: 'founder-peer' });

    const partyB = freshKeyPair();
    await addMemberByManager(db, { managerKeyPair: founder, memberKey: partyB.publicKeyB64 });
    // Two machines under one member key — the multi-machine removed party.
    await registerMemberPeer(db, { memberKeyPair: partyB, peerId: 'b-peer-1' });
    await registerMemberPeer(db, { memberKeyPair: partyB, peerId: 'b-peer-2' });

    const enforcer = new StrandRevocationEnforcer({
      label: 'real-db',
      readRows: () => readStrandRevocationRows(db)
    });
    await enforcer.refresh();
    expect(enforcer.revokedCount).toBe(0);

    await revokeMember(db, { managerKeyPair: founder, memberKey: partyB.publicKeyB64 });
    await enforcer.refresh();
    expect(enforcer.isRevoked('b-peer-1')).toBe(true);
    expect(enforcer.isRevoked('b-peer-2')).toBe(true);
    expect(enforcer.isRevoked('founder-peer')).toBe(false);

    // Re-admission: a fresh Member row for the same key → the old bindings stop
    // being orphans on the next refresh.
    await addMemberByManager(db, { managerKeyPair: founder, memberKey: partyB.publicKeyB64 });
    await enforcer.refresh();
    expect(enforcer.revokedCount).toBe(0);
  }, 30_000);

  it('self-departure (leaveStrand) produces the SAME enforcement as manager revocation', async () => {
    // Deliberately identical to the revocation path: remaining members' behavior
    // must not differ by exit path — both leave the same orphaned bindings.
    const { db, founder } = await openStrand('c');
    const partyC = freshKeyPair();
    await addMemberByManager(db, { managerKeyPair: founder, memberKey: partyC.publicKeyB64 });
    await registerMemberPeer(db, { memberKeyPair: partyC, peerId: 'c-peer' });

    await leaveStrand(db, { memberKeyPair: partyC });

    const enforcer = new StrandRevocationEnforcer({
      label: 'real-db-leave',
      readRows: () => readStrandRevocationRows(db)
    });
    await enforcer.refresh();
    expect(enforcer.isRevoked('c-peer')).toBe(true);
  }, 30_000);

  it('an open strand yields an empty deny set (no membership rows exist at all)', async () => {
    const { db } = await openStrand('o');

    const enforcer = new StrandRevocationEnforcer({
      label: 'real-db-open',
      readRows: () => readStrandRevocationRows(db)
    });
    await enforcer.refresh();
    expect(enforcer.revokedCount).toBe(0);
  }, 30_000);
});
