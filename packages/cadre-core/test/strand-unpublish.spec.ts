import { describe, it, expect, afterEach, vi } from 'vitest';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { generatePrivateKey, getPublicKey, sign as cryptoSign } from '@optimystic/quereus-plugin-crypto';
import { CadreNode } from '../src/cadre-node.js';
import { generateStrandMemberKey } from '../src/strand-member-key.js';
import { signSchema } from '../src/schema-verification.js';
import type { ControlDatabase } from '../src/control-database.js';
import type { Ed25519KeyPair } from '../src/ed25519-key.js';
import type { StrandConfig } from '../src/types.js';
import { startSelfOwnerNode } from './self-owner-node-helpers.js';

/**
 * Exercises the node-level strand removal surface — `unpublishStrand`, the owner-signed
 * party-wide inverse of `publishStrand` — plus the error shape of the renamed local-only
 * `stopStrand`.
 *
 * The DB-level `deleteStrand` writer and its authorization/replay defences are covered by
 * `control-authorization-binding.spec.ts` and `control-revocation-replay.spec.ts` (non-owner
 * signer refused, add-approval replay refused, tombstone transactionality). This pins the
 * wrapper: it self-signs with the node's own owner key, the row and its tombstone land,
 * blank input is refused before any write, a closed strand's `MemberPrivateKey` dies with
 * the row, the id is NOT blacklisted for owner re-publish, and the local instance is
 * stopped by the time the promise resolves.
 *
 * The last two tests cover the OTHER side of the same party-wide contract: a node that did
 * not issue the removal and learns of it only by seeing the `Strand` row missing on its own
 * next `StrandWatcher` poll (`StrandWatcher.poll` → `onStrandRemoved` →
 * `CadreNode.handleStrandRemoved`). That branch is never reached through `unpublishStrand`,
 * which force-stops the local instance itself. They stand in for a sibling without a second
 * machine, by deleting the row out from under a single running node with a direct
 * `ControlDatabase.deleteStrand`; whether the deletion actually becomes VISIBLE to a real
 * second node over the network is a separate, cross-machine question covered elsewhere.
 *
 * Boots a self-signing node the way `validation-key-enrollment.spec.ts` does: the node's
 * libp2p key IS its owner key, enrolled in `OwnerKey` so its self-signed control writes are
 * authorised.
 */
describe('CadreNode strand unpublish', () => {
  let node: CadreNode | undefined;
  /** Owner keypair the current `node` self-signs with, so a test can drive a control writer directly. */
  let ownerKey: Ed25519KeyPair | undefined;

  /** Poll interval for the watcher-driven tests: short enough to assert in well under a second. */
  const WATCH_INTERVAL_MS = 200;
  /**
   * "…and it stays that way" window, five polls wide. Derived from the interval on purpose:
   * a future interval bump must not silently turn a real assertion into a vacuous one.
   */
  const QUIET_WINDOW_MS = WATCH_INTERVAL_MS * 5;
  /** Budget for the poll-driven waits — generous; the assertions resolve in a poll or two. */
  const WAIT_BUDGET_MS = 10_000;
  /** `vi.waitFor` options for every poll-driven gate below. */
  const WAIT_OPTS = { timeout: WAIT_BUDGET_MS, interval: 50 };

  const rand = (): string => Math.random().toString(36).slice(2);

  const quietWindow = (): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, QUIET_WINDOW_MS));

  /**
   * Remove a `Strand` row the way somebody ELSE's removal arrives here: straight through the
   * owner-signed writer, with no local stop. `unpublishStrand` cannot stand in — it
   * force-stops the local instance itself, masking the watcher path under test. What is left
   * is exactly a sibling's state a moment after another party's removal commits: the row is
   * gone from this node's view, its instance is still running, and only the next poll can
   * notice.
   */
  async function deleteStrandRow(n: CadreNode, key: Ed25519KeyPair, strandId: string): Promise<boolean> {
    return await n.getControlDatabase()!.deleteStrand(
      strandId,
      key.publicKeyB64,
      // ed25519 over the raw canonical bytes (no pre-hash), as every control writer expects.
      (message: Uint8Array): string =>
        cryptoSign(message, key.privateKeyB64, 'ed25519', 'bytes', 'base64url', 'base64url') as string,
    );
  }

  /** Ids seen for each lifecycle event, in order, for the watcher-driven assertions below. */
  function collectStrandEvents(n: CadreNode): {
    started: string[];
    discovered: string[];
    stopped: string[];
    errors: string[];
  } {
    const events = { started: [] as string[], discovered: [] as string[], stopped: [] as string[], errors: [] as string[] };
    n.on('strand:started', ({ strandId }) => void events.started.push(strandId));
    n.on('strand:discovered', ({ strandId }) => void events.discovered.push(strandId));
    n.on('strand:stopped', ({ strandId }) => void events.stopped.push(strandId));
    n.on('strand:error', ({ strandId }) => void events.errors.push(strandId));
    return events;
  }

  function revocationRow(db: ControlDatabase, stampId: string): Promise<Record<string, unknown> | undefined> {
    return db.getDatabase().get(
      'select TableName, RowKey, StampId from CadreControl.Revocation where TableName = ? and StampId = ?',
      ['Strand', stampId],
    );
  }

  /** A full strand config with a real signed sApp schema, for `addStrand`. */
  function createStrandConfig(strandId: string): StrandConfig {
    const authorPrivateKey = generatePrivateKey('ed25519', 'base64url') as string;
    const authorPublicKey = getPublicKey(authorPrivateKey, 'ed25519', 'base64url', 'base64url') as string;
    const schema = 'create table Test (id text primary key);';
    const version = '1.0.0';
    return {
      strandRow: { Id: strandId, MemberPrivateKey: null, Type: 'o' },
      sAppConfig: {
        id: authorPublicKey,
        version,
        schema,
        signature: signSchema(schema, version, authorPrivateKey),
      },
    };
  }

  afterEach(async () => {
    await node?.stop();
    node = undefined;
  });

  it('publish → unpublish removes the row and files a Revocation tombstone retiring its stamp', async () => {
    ({ node, ownerKey } = await startSelfOwnerNode('strand-unpublish-'));
    const db = node.getControlDatabase()!;
    const strandId = 'strand-unpub-' + rand();

    await node.publishStrand(strandId);
    expect((await db.queryStrands()).map((row) => row.Id)).toEqual([strandId]);

    const stampId = await db.queryStrandStampId(strandId);
    expect(stampId).not.toBeNull();

    await node.unpublishStrand(strandId);

    expect(await db.queryStrands()).toEqual([]);
    const tombstone = await revocationRow(db, stampId!);
    expect(tombstone).toBeDefined();
    expect(tombstone?.RowKey).toBe(strandId);
    expect((await db.queryRevokedStamps('Strand')).has(stampId!)).toBe(true);
  }, 60_000);

  it('unpublishing a never-published id is a silent no-op (no throw, no tombstone)', async () => {
    ({ node, ownerKey } = await startSelfOwnerNode('strand-unpublish-'));
    const db = node.getControlDatabase()!;

    await expect(node.unpublishStrand('never-published-' + rand())).resolves.toBeUndefined();

    expect((await db.queryRevokedStamps('Strand')).size).toBe(0);
    expect(await db.queryStrands()).toEqual([]);
  }, 60_000);

  it('rejects an empty or whitespace-only id before any write', async () => {
    ({ node, ownerKey } = await startSelfOwnerNode('strand-unpublish-'));
    const db = node.getControlDatabase()!;

    for (const blank of ['', '   ', '\t\n']) {
      await expect(node.unpublishStrand(blank)).rejects.toThrow(/required/i);
    }

    expect(await db.queryStrands()).toEqual([]);
    expect((await db.queryRevokedStamps('Strand')).size).toBe(0);
  }, 60_000);

  it('throws the named error shapes when the node has not been started', async () => {
    const nodeKey = await generateKeyPair('Ed25519');
    const stopped = new CadreNode({
      controlNetwork: { partyId: 'strand-unpublish-stopped-' + rand(), bootstrapNodes: [] },
      privateKey: nodeKey,
      profile: 'transaction',
    });

    // stopStrand keeps its pre-existing local-lifecycle error; unpublishStrand goes
    // through requireOwnerSigningKey and reports the started-guard shape.
    await expect(stopped.stopStrand('any-strand')).rejects.toThrow(/not running/);
    await expect(stopped.unpublishStrand('any-strand')).rejects.toThrow(
      /must be started before attempting to unpublish strand/i,
    );
  });

  it('unpublishing a closed strand destroys the row and its MemberPrivateKey', async () => {
    ({ node, ownerKey } = await startSelfOwnerNode('strand-unpublish-'));
    const db = node.getControlDatabase()!;
    const strandId = 'strand-closed-' + rand();
    const memberKey = await generateStrandMemberKey();

    await node.publishStrand(strandId, 'c', memberKey);
    expect(await db.queryStrand(strandId)).toEqual({
      Id: strandId,
      MemberPrivateKey: memberKey,
      Type: 'c',
    });

    await node.unpublishStrand(strandId);

    expect(await db.queryStrand(strandId)).toBeNull();
    expect(await db.queryStrands()).toEqual([]);
  }, 60_000);

  it('re-publishing after unpublish succeeds on a fresh stamp (the id is not blacklisted)', async () => {
    ({ node, ownerKey } = await startSelfOwnerNode('strand-unpublish-'));
    const db = node.getControlDatabase()!;
    const strandId = 'strand-republish-' + rand();

    await node.publishStrand(strandId);
    const firstStamp = await db.queryStrandStampId(strandId);
    await node.unpublishStrand(strandId);

    await node.publishStrand(strandId);

    const secondStamp = await db.queryStrandStampId(strandId);
    expect(secondStamp).not.toBeNull();
    expect(secondStamp).not.toBe(firstStamp);
    expect(await revocationRow(db, firstStamp!)).toBeDefined();
    expect((await db.queryStrands()).map((row) => row.Id)).toEqual([strandId]);
  }, 60_000);

  it('stops a locally-running instance by the time the promise resolves, emitting strand:stopped once', async () => {
    ({ node, ownerKey } = await startSelfOwnerNode('strand-unpublish-'));
    const db = node.getControlDatabase()!;
    const strandId = 'strand-running-' + rand();

    await node.addStrand(createStrandConfig(strandId));
    await node.publishStrand(strandId);
    expect(node.getStrand(strandId)).toBeDefined();

    const stopped: string[] = [];
    node.on('strand:stopped', ({ strandId: id }) => void stopped.push(id));

    await node.unpublishStrand(strandId);

    // Pins the force-poll + explicit-stop convergence step: no waiting on the 5 s
    // watcher interval — the local instance is gone when unpublishStrand returns.
    expect(node.getStrand(strandId)).toBeUndefined();
    expect(node.getStrands().size).toBe(0);
    expect(await db.queryStrands()).toEqual([]);
    // Exactly once: the watcher's removal path and the explicit stop must not both fire.
    expect(stopped).toEqual([strandId]);
  }, 60_000);

  it('stops a locally-running instance the watcher never tracked (never-published id)', async () => {
    ({ node, ownerKey } = await startSelfOwnerNode('strand-unpublish-'));
    const db = node.getControlDatabase()!;
    const strandId = 'strand-unwatched-' + rand();

    // addStrand without publishStrand: no Strand row exists, so the watcher never
    // observes this id and can never fire its removal path. This is the branch the
    // explicit getInstance + stopStrand step in unpublishStrand exists for.
    await node.addStrand(createStrandConfig(strandId));
    expect(node.getStrand(strandId)).toBeDefined();

    const stopped: string[] = [];
    node.on('strand:stopped', ({ strandId: id }) => void stopped.push(id));

    await node.unpublishStrand(strandId);

    expect(node.getStrand(strandId)).toBeUndefined();
    expect(stopped).toEqual([strandId]);
    // Still a control-plane no-op: nothing was published, so nothing is tombstoned.
    expect((await db.queryRevokedStamps('Strand')).size).toBe(0);
  }, 60_000);

  it('re-emits strand:started on a genuine restart, and strand:stopped only once per instance', async () => {
    ({ node, ownerKey } = await startSelfOwnerNode('strand-unpublish-'));
    const strandId = 'strand-restart-' + rand();
    const events = collectStrandEvents(node);

    // The idempotence guards in `launchStrand`/`detachStrand` key off the strand manager's
    // instance map ONLY, so a real stop-then-start cycle is two distinct instances and must
    // produce the full event pair each time. A guard keyed off anything stickier (an id seen
    // once, a config still registered) would silence the second launch — this pins that.
    await node.addStrand(createStrandConfig(strandId));
    await node.stopStrand(strandId);
    await node.addStrand(createStrandConfig(strandId));
    expect(node.getStrand(strandId)).toBeDefined();
    expect(events.started).toEqual([strandId, strandId]);
    expect(events.stopped).toEqual([strandId]);

    // Second stop of the same id: the instance is already gone, so `detachStrand` no-ops
    // rather than emitting a phantom second `strand:stopped`.
    await node.stopStrand(strandId);
    await node.stopStrand(strandId);
    expect(node.getStrand(strandId)).toBeUndefined();
    expect(events.stopped).toEqual([strandId, strandId]);
    expect(events.errors).toEqual([]);
  }, 60_000);

  it('stops a watched instance when the row vanishes from under it (the sibling-side removal path)', async () => {
    ({ node, ownerKey } = await startSelfOwnerNode('strand-unpublish-', { strandWatchInterval: WATCH_INTERVAL_MS }));
    const db = node.getControlDatabase()!;
    const strandId = 'strand-vanished-' + rand();
    const events = collectStrandEvents(node);

    // Normal founding order: start the strand locally, then publish its row. This node's own
    // watcher rediscovers the row it just published and must treat that as a no-op (see
    // `launchStrand`'s already-tracked guard) rather than relaunching and re-emitting
    // `strand:started` for an instance that is already running.
    await node.addStrand(createStrandConfig(strandId));
    expect(node.getStrand(strandId)).toBeDefined();
    await node.publishStrand(strandId);

    // Give the watcher a few polls to rediscover the row it already started and (correctly)
    // no-op on it rather than relaunching.
    await quietWindow();
    expect(events.started).toEqual([strandId]);
    expect(events.discovered).toEqual([]);

    expect(await deleteStrandRow(node, ownerKey!, strandId)).toBe(true);
    expect(await db.queryStrands()).toEqual([]);

    await vi.waitFor(() => expect(events.stopped).toEqual([strandId]), WAIT_OPTS);
    expect(node.getStrand(strandId)).toBeUndefined();
    expect(node.getStrands().size).toBe(0);

    // Exactly once. `StrandWatcher.poll` drops the id from `knownStrands` before invoking the
    // callback, so a repeat is not expected — but a regression here reaches an app as a
    // duplicate shutdown, so assert it across a further quiet window.
    await quietWindow();
    expect(events.stopped).toEqual([strandId]);
    expect(events.errors).toEqual([]);

    // The sApp config went with the strand: a re-publish is DISCOVERED rather than relaunched.
    // The founding order above (addStrand then publishStrand) emits no `strand:discovered` for
    // this node's own strand, so this republish is the only source of that event — this is
    // what proves `handleStrandRemoved` cleared `sAppConfigs` and the watcher dropped the id
    // from `knownStrands`, and that the removal's `Revocation` tombstone is not mistaken for a
    // live row.
    await node.publishStrand(strandId);
    await vi.waitFor(() => expect(events.discovered).toEqual([strandId]), WAIT_OPTS);
    expect(node.getStrand(strandId)).toBeUndefined();
    expect(events.errors).toEqual([]);
  }, 60_000);

  it('never emits strand:stopped for a strand this node published but never ran locally', async () => {
    ({ node, ownerKey } = await startSelfOwnerNode('strand-unpublish-', { strandWatchInterval: WATCH_INTERVAL_MS }));
    const strandId = 'strand-publish-only-' + rand();
    const events = collectStrandEvents(node);

    // Publish without addStrand, and wait for strand:discovered: that proves the watcher's
    // knownStrands already tracks the row (knownStrands.set happens before the no-config
    // strand:discovered branch), which is the precondition for its removal path firing below.
    await node.publishStrand(strandId);
    await vi.waitFor(() => expect(events.discovered).toEqual([strandId]), WAIT_OPTS);
    expect(node.getStrand(strandId)).toBeUndefined();

    // unpublishStrand's own explicit-stop branch is gated on getInstance(trimmed), which is
    // undefined here, so the only route to strand:stopped is the watcher-driven forcePoll ->
    // handleStrandRemoved -> detachStrand path — exactly the case detachStrand must no-op on:
    // no local instance was ever running, so there is nothing to stop and no event to emit.
    await node.unpublishStrand(strandId);

    expect(node.getStrand(strandId)).toBeUndefined();
    expect(events.stopped).toEqual([]);
    expect(events.errors).toEqual([]);
  }, 60_000);

  it('keeps running a strand its strandFilter excluded, even after the row vanishes', async () => {
    const excludedId = 'strand-filtered-out-' + rand();
    const admittedId = 'strand-watched-instead-' + rand();
    ({ node, ownerKey } = await startSelfOwnerNode('strand-unpublish-', {
      strandWatchInterval: WATCH_INTERVAL_MS,
      // The `strandId` form rather than `{ mode: 'none' }`: it is the shape a real app uses,
      // and it keeps the test honest about WHICH strand was excluded.
      strandFilter: { mode: 'strandId', strandId: admittedId },
    }));
    const db = node.getControlDatabase()!;
    const events = collectStrandEvents(node);

    // The admitted strand is the LIVENESS WITNESS for every negative below: its discovery is
    // what proves the watcher is actually polling, so the excluded strand's silence is an
    // observation rather than the vacuous pass a dead watcher would also produce.
    await node.publishStrand(admittedId);
    await node.publishStrand(excludedId);
    await vi.waitFor(() => expect(events.discovered).toEqual([admittedId]), WAIT_OPTS);

    // Rejected by the filter, so the watcher never tracks that row — no discovery, ever.
    await quietWindow();
    expect(events.discovered).toEqual([admittedId]);

    // An app may still run a strand the watcher was told to ignore.
    await node.addStrand(createStrandConfig(excludedId));
    expect(node.getStrand(excludedId)).toBeDefined();

    expect(await deleteStrandRow(node, ownerKey!, excludedId)).toBe(true);
    // The row really is gone party-wide — otherwise "still running" below proves nothing.
    expect((await db.queryStrands()).map((row) => row.Id)).toEqual([admittedId]);
    await quietWindow();

    // Documented consequence, not a defect: a node that opted out of WATCHING a strand also
    // opted out of observing its party-wide removal. Its only stop is a local
    // `stopStrand`/`unpublishStrand` call.
    expect(node.getStrand(excludedId)).toBeDefined();
    expect(events.stopped).toEqual([]);
    expect(events.discovered).toEqual([admittedId]);
    expect(events.errors).toEqual([]);
  }, 60_000);
});
