import { randomBytes } from 'node:crypto';
import debug from 'debug';

import type { Orchestrator, OrchestratorCreateResult } from '@serfab/cadre-provider';

import type { DonationStore } from './donation-store.js';
import type {
  Donation,
  DonationStatus,
  DonationView,
  GrantDenyReason,
  GrantValidator,
} from './types.js';
import { DonationError } from './types.js';

const log = debug('cadre:host:donation-service');

/**
 * The only statuses a loan may come back from. An allowlist, not a terminal
 * denylist: `terminated` is a loan the borrower ended and `error` one the host
 * gave up on (neither may come back), while `provisioning` is a provision still
 * in flight — replaying its spawn would race that provision and strand the
 * record in `provisioning`, which no reap sweep collects.
 *
 * Checked twice in {@link DonationService.respawn} — once on entry, once after
 * the spawn — so the "may this loan come back" rule is stated exactly once.
 */
const RESPAWNABLE_STATUSES: ReadonlySet<DonationStatus> = new Set<DonationStatus>([
  'awaiting_seed',
  'seeded',
]);

/**
 * The only statuses a record may be marked `seeded` from. A different question
 * from {@link RESPAWNABLE_STATUSES} — "may this record accept a seed result"
 * rather than "may this loan come back" — so it is stated separately even though
 * the two sets happen to coincide today. Re-seeding an already-`seeded` record is
 * allowed (the borrower may present a fresh seed); `terminated` / `error` /
 * `provisioning` may not be written over.
 *
 * Checked twice in {@link DonationService.applySeed} — once on entry, once after
 * the node's round-trip — so the rule is stated exactly once.
 */
const SEEDABLE_STATUSES: ReadonlySet<DonationStatus> = new Set<DonationStatus>([
  'awaiting_seed',
  'seeded',
]);

/**
 * Default age after which a donation still stuck in `awaiting_seed` is
 * auto-terminated: the requester provisioned a node but never presented a seed
 * (it vanished, or abandoned the flow), leaving an orphaned child holding host
 * ports. 30 minutes.
 *
 * NOTE: not operator-configurable yet — a single module constant. If hosts need
 * to tune the grace period, promote this to `host.config.json`.
 */
export const DONATION_AWAITING_SEED_TTL_MS = 30 * 60 * 1000;

/**
 * Default age after which a donation still stuck in `provisioning` is
 * auto-terminated: the host wrote the row before starting the child, and a
 * crash/kill in that window (or during the spawn itself) leaves nothing to
 * advance it across a restart. A real spawn (identity key read/gen, port
 * allocation, process spawn) completes in well under a second normally, so 5
 * minutes is generously past "any plausible spawn" without risking a false
 * reap of one still genuinely in flight under heavy load.
 */
export const DONATION_PROVISIONING_TTL_MS = 5 * 60 * 1000;

/** How often the reap sweep runs while cadre-host is up. 5 minutes. */
export const DONATION_REAP_SWEEP_MS = 5 * 60 * 1000;

/** A grantee-driven request to provision one donated node. */
export interface DonationProvisionRequest {
  /** The grant token that authorizes this donation (the quota key). */
  grantToken: string;
  /** The REQUESTER's cadre — the party the donated node joins. */
  partyId: string;
  /** Requester control-network bootstrap multiaddrs (dialable, with `/p2p/`). */
  bootstrapNodes: string[];
  /**
   * The requester's owner public key(s), base64url. Pinned as cold-start
   * seed-trust anchors on the donated node so it accepts the requester-signed
   * seed presented in {@link DonationService.applySeed}. Without these the node's
   * node-local trusted-owner anchor holds no key for the requester's party, and
   * the default anchored policy rejects every seed.
   */
  ownerKeys: string[];
  /** Node profile; defaults to `storage` so the node participates and is dialable. */
  profile?: 'storage' | 'transaction';
}

/**
 * The donated node's `POST /seed` response body. Module-private: this is the
 * wire shape we parse, not the outcome we report ({@link DonationSeedResult}).
 */
interface NodeSeedResponse {
  success: boolean;
  peersAdded?: number;
  error?: string;
}

/**
 * Outcome of {@link DonationService.applySeed}.
 *
 * - `seeded` — the node accepted the seed and the record now says so.
 * - `rejected` — the node refused the seed (its own seed-trust policy). Nothing
 *   written.
 * - `abandoned` — the seed reached the node, but the loan ended while the
 *   request was in flight. The ending wins: the record is left exactly as the
 *   ending wrote it. `status` is the status that won, absent when the row is
 *   gone entirely.
 */
export type DonationSeedResult =
  | { outcome: 'seeded'; peersAdded: number }
  | { outcome: 'rejected'; error?: string }
  | { outcome: 'abandoned'; status?: DonationStatus };

/** Live peer identity of a donated node. */
export interface DonationPeerInfo {
  peerId: string;
  multiaddrs: string[];
}

/**
 * Outcome of {@link DonationService.respawn}. Three distinct non-throwing ends,
 * which a bare `DonationView | undefined` conflated:
 *
 * - `respawned` — a new child is up and the record now names its handles.
 * - `not_respawnable` — the record predates persisted spawn inputs, so there is
 *   nothing to replay. Permanent; no child was spawned.
 * - `abandoned` — the loan ended (or the record vanished) while the spawn was in
 *   flight. The ending wins: the record is left exactly as the ending wrote it
 *   and the new child is cleaned up. `status` is the status that won, absent
 *   when the row is gone entirely.
 */
export type RespawnResult =
  | { outcome: 'respawned'; donation: DonationView }
  | { outcome: 'not_respawnable' }
  | { outcome: 'abandoned'; status?: DonationStatus };

/**
 * The three per-spawn fields a donation record carries for the child that
 * currently exists. Whatever the record names here is what every later cleanup
 * (`terminate` → stop + reclaim) acts on, so a spawn that succeeded must land
 * these on the record even when the surrounding operation then fails.
 */
interface SpawnedHandles {
  dockerId: string;
  seedEndpoint: string;
  seedToken: string;
}

/**
 * Orchestrator capability `reapStaleProvisioning` needs beyond the base
 * `Orchestrator`: resolve a spawn's friendly containerId (== a donation's id)
 * back to its current dockerId, so a stuck-`provisioning` reap can find and
 * reclaim a child that was actually spawned before the host died. Optional —
 * only `HostProcessOrchestrator` implements it (see its `resolveDockerId`).
 * Absent on a test double or a future orchestrator, the reap just terminalizes
 * the record with nothing to reclaim.
 */
export interface DonationOrchestrator extends Orchestrator {
  resolveDockerId?(containerId: string): string | undefined;
}

/** Constructor options. */
export interface DonationServiceOptions {
  /** Orchestrator that spawns/stops the donated node child process. */
  orchestrator: DonationOrchestrator;
  /** Grant validator (identity/expiry/revocation + quota). */
  grants: GrantValidator;
  /** Persistent donation store (`donations.json`). */
  store: DonationStore;
  /** Clock override for tests. */
  now?: () => Date;
}

/**
 * DonationService — drives the donate-a-node lifecycle on behalf of an external
 * requester (a friend's phone). It is cadre-host's analogue of cadre-provider's
 * `ContainerService`, minus Docker/billing, plus the grant-token gate.
 *
 * The host contributes capacity only: it spawns a generic node into the
 * *requester's* cadre (`partyId`), pins the requester's owner key(s) so the node
 * will accept a requester-signed seed, and presents that seed to the node's
 * `POST /seed` — it never holds the requester's authority private key.
 *
 * Scope note: this class covers the service surface the node-donation
 * integration test drives directly (`provision` / `getPeer` / `applySeed` /
 * `terminate` / `get` / `list`). The grantee-facing HTTP routes, the `bin/host.ts`
 * wiring, and the stale-`awaiting_seed` reap sweep are owned by the
 * `2-donation-service` ticket and land alongside this file.
 */
export class DonationService {
  private readonly orchestrator: DonationOrchestrator;
  private readonly grants: GrantValidator;
  private readonly store: DonationStore;
  private readonly now: () => Date;

  /**
   * Per-grant-token serialization tail. `provision` chains onto the prior
   * provision for the same token so the quota check and record-create are
   * atomic — two concurrent requests at `count = maxNodes - 1` can't both pass.
   *
   * NOTE: one entry per distinct token, never evicted. Fine at household scale
   * (a handful of grants); if grant counts ever grow large, evict the tail once
   * it resolves.
   */
  private readonly provisionTail = new Map<string, Promise<void>>();

  constructor(opts: DonationServiceOptions) {
    this.orchestrator = opts.orchestrator;
    this.grants = opts.grants;
    this.store = opts.store;
    this.now = opts.now ?? (() => new Date());
    log('DonationService initialized');
  }

  /**
   * Provision a donated node for a validated grant. Serialized per grant token
   * so the quota check and record-create are atomic. On any orchestrator failure
   * the reserved resources are reclaimed and the record is marked `error`.
   */
  async provision(request: DonationProvisionRequest): Promise<DonationView> {
    return this.serializeByGrant(request.grantToken, () => this.provisionLocked(request));
  }

  private async provisionLocked(request: DonationProvisionRequest): Promise<DonationView> {
    const validation = this.grants.validateForProvision(
      request.grantToken,
      (token) => this.store.liveNodeCount(token),
    );
    if (!validation.ok) {
      throw denialToError(validation.reason);
    }

    const id = generateDonationId();
    const nowIso = this.now().toISOString();
    const profile = request.profile ?? 'storage';
    const record: Donation = {
      id,
      grantToken: request.grantToken,
      partyId: request.partyId,
      // Persisted so `respawn` can replay the spawn from the record alone.
      // Neither is secret (dialable addrs + public keys), so both ride along in
      // the redacted `DonationView` too.
      bootstrapNodes: request.bootstrapNodes,
      ownerKeys: request.ownerKeys,
      profile,
      status: 'provisioning',
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    this.store.put(record);

    // The spawn is the only step that can fail before anything is allocated, so
    // it gets a `try` of its own — a wider one would swallow the abandon
    // decision below and mark a borrower's own ending as a host-side `error`.
    let result: OrchestratorCreateResult;
    try {
      result = await this.orchestrator.createContainer({
        containerId: id,
        partyId: request.partyId,
        bootstrapNodes: request.bootstrapNodes,
        profile,
        pinnedOwnerKeys: request.ownerKeys,
      });
    } catch (err) {
      const message = errorMessage(err);
      log('provision of donation %s failed: %s', id, message);
      this.markProvisionFailed(id, message);
      throw new DonationError('orchestrator_error', `Failed to provision donated node: ${message}`);
    }

    // Re-read: `record` predates the orchestrator round-trip (seconds of wall
    // clock) and `store.put` replaces the whole row, so writing that copy back
    // would undo a `terminate` — or a delete — that landed while the spawn was
    // in flight, resurrecting a loan the borrower just ended. The store is
    // synchronous, so this read-decide-write is atomic against the event loop
    // only as long as no `await` sneaks in between.
    const current = this.store.get(id);
    if (!current || current.status !== 'provisioning') {
      // The ending cleaned up nothing: the record named no `dockerId` yet, so
      // `terminate`'s cleanup branch never ran and this child is the only thing
      // holding the spawn's ports and workdir. Reclaim (not merely stop) — the
      // workdir was created by this very spawn, so there is nothing to preserve.
      log(
        'donation %s went %s during provision — abandoning new child %s',
        id,
        current?.status ?? 'missing',
        result.dockerId,
      );
      await this.safeReclaim(result.dockerId);
      throw current
        ? new DonationError(
            'invalid_state',
            `Donation ${id} was ${current.status} before it finished provisioning`,
          )
        : new DonationError('not_found', `No such donation: ${id}`);
    }

    const provisioned: Donation = {
      ...current,
      dockerId: result.dockerId,
      seedEndpoint: result.seedEndpoint,
      // Persisted so a host restart in the request→seed gap can still present
      // the seed. NEVER returned to the grantee (stripped by `DonationView`).
      seedToken: result.seedToken,
      status: 'awaiting_seed',
      updatedAt: this.now().toISOString(),
    };
    try {
      this.store.put(provisioned);
    } catch (err) {
      const message = errorMessage(err);
      log('provision of donation %s failed: %s', id, message);
      await this.safeReclaim(result.dockerId);
      this.markProvisionFailed(id, message);
      throw new DonationError('orchestrator_error', `Failed to provision donated node: ${message}`);
    }
    log('provisioned donation %s (party=%s) → awaiting_seed', id, request.partyId);
    return redact(provisioned);
  }

  /**
   * Mark a still-`provisioning` record as failed — and ONLY such a record. A row
   * that went `terminated` while the spawn was in flight is the borrower's own
   * ending and must not be rewritten as a host fault; a row that vanished must
   * not be recreated.
   *
   * Best-effort (mirroring {@link storeRespawnAttempt}): we are already unwinding a
   * provision failure, and a store error here must not mask the error being
   * reported to the caller.
   */
  private markProvisionFailed(id: string, message: string): void {
    try {
      const current = this.store.get(id);
      if (current?.status !== 'provisioning') return;
      this.store.put({
        ...current,
        status: 'error',
        error: message,
        updatedAt: this.now().toISOString(),
      });
    } catch (err) {
      log('failed to mark donation %s as errored: %s', id, errorMessage(err));
    }
  }

  /**
   * Live peer identity of a donated node, read fresh from its `/status` every
   * call (no cache) so a re-keyed identity / remapped multiaddr is never served
   * stale. Throws `peer_unavailable` while the node has no peer identity yet.
   */
  async getPeer(id: string): Promise<DonationPeerInfo> {
    const donation = this.requireDonation(id);
    if (!donation.seedEndpoint) {
      throw new DonationError('peer_unavailable', `Donation ${id} has no node endpoint`);
    }

    const statusUrl = toStatusUrl(donation.seedEndpoint);
    let res: Response;
    try {
      res = await fetch(statusUrl);
    } catch (err) {
      throw new DonationError('peer_unavailable', `Donated node unreachable: ${errorMessage(err)}`);
    }
    if (!res.ok) {
      throw new DonationError('peer_unavailable', `Donated node /status returned ${res.status}`);
    }

    const status = (await res.json()) as { peerId?: string | null; multiaddrs?: string[] };
    if (!status.peerId || !status.multiaddrs?.length) {
      throw new DonationError('peer_unavailable', `Donated node ${id} has no peer identity yet`);
    }
    return { peerId: status.peerId, multiaddrs: status.multiaddrs };
  }

  /**
   * Present the requester's phone-signed seed to the donated node's `POST /seed`,
   * authenticated with the host↔node `seedToken`. On success the donation moves
   * to `seeded`. The node still enforces its own seed-trust policy, so a seed
   * signed by a key the node did not pin comes back `rejected`.
   *
   * **An ending that lands mid-seed wins.** The record is re-read after the node
   * answers; if the loan ended (or the row vanished) while the request was in
   * flight, that write stands and we report `abandoned` rather than marking a
   * dead loan `seeded`. Unlike an abandoned respawn there is nothing to clean up
   * — the record named its `dockerId` the whole time, so the ending's own
   * `terminate` already stopped and reclaimed the child.
   */
  async applySeed(id: string, encodedSeed: string): Promise<DonationSeedResult> {
    const donation = this.requireDonation(id);
    if (!SEEDABLE_STATUSES.has(donation.status)) {
      throw new DonationError(
        'invalid_state',
        `Donation ${id} cannot be seeded in status ${donation.status}`,
      );
    }
    if (!donation.seedEndpoint) {
      throw new DonationError('peer_unavailable', `Donation ${id} has no seed endpoint`);
    }
    // A record with an endpoint but no token can never authenticate — fail here
    // rather than let the node reject with an opaque 401.
    if (!donation.seedToken) {
      throw new DonationError('seed_failed', `Donation ${id} has no seed token`);
    }

    let res: Response;
    try {
      res = await fetch(donation.seedEndpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${donation.seedToken}`,
        },
        body: JSON.stringify({ seed: encodedSeed }),
      });
    } catch (err) {
      throw new DonationError('seed_failed', `Donated node unreachable: ${errorMessage(err)}`);
    }
    if (!res.ok) {
      const body = await res.text();
      throw new DonationError('seed_failed', `Donated node /seed returned ${res.status}: ${body}`);
    }

    const result = (await res.json()) as NodeSeedResponse;
    if (!result.success) {
      log('donation %s rejected the seed: %s', id, result.error ?? 'no reason given');
      return result.error === undefined
        ? { outcome: 'rejected' }
        : { outcome: 'rejected', error: result.error };
    }

    // Re-read: `donation` predates the node round-trip and `store.put` replaces
    // the whole row, so writing that copy back would undo a `terminate` — or a
    // reap — that landed while the seed was in flight, resurrecting an ended
    // loan. The store is synchronous, so this read-decide-write is atomic
    // against the event loop only as long as no `await` sneaks in between.
    //
    // NOTE: a concurrent `respawn` also passes this check — it leaves the status
    // alone but swaps `seedEndpoint`/`seedToken`, so we would mark `seeded` a
    // record whose live child is the new one while the seed went to the old
    // endpoint. Harmless today (respawn only fires when the supervisor believes
    // the child is down, in which case our `fetch` would have failed; and both
    // spawns share one workdir, so the seed the old child persisted is on disk
    // for the new one). If a second `respawn` caller appears, or respawn ever
    // stops sharing the workdir, compare `current.seedEndpoint`/`seedToken`
    // against the ones we actually seeded and report `abandoned` on a mismatch.
    const current = this.store.get(id);
    if (!current || !SEEDABLE_STATUSES.has(current.status)) {
      log('donation %s went %s during seed — the ending wins', id, current?.status ?? 'missing');
      return current ? { outcome: 'abandoned', status: current.status } : { outcome: 'abandoned' };
    }

    // Merge only the status transition onto the on-disk row.
    this.store.put({ ...current, status: 'seeded', updatedAt: this.now().toISOString() });
    log('donation %s seeded (peersAdded=%d)', id, result.peersAdded ?? 0);
    return { outcome: 'seeded', peersAdded: result.peersAdded ?? 0 };
  }

  /**
   * Re-spawn a donated node that is no longer running, replaying the spawn
   * inputs persisted on the record. The node keeps its workdir — and with it its
   * identity key, trusted-owner anchor, and retained bootstrap peers — so it
   * comes back as the *same* peer and rejoins from its own durable node-local
   * stores. Only the host-side handles change: `dockerId`, `seedEndpoint`,
   * `seedToken` are written back fresh.
   *
   * **Status is deliberately unchanged.** A `seeded` node stays `seeded` (it
   * needs no re-seeding); an `awaiting_seed` node stays `awaiting_seed` and the
   * borrower's later seed goes to the new endpoint/token.
   *
   * **An ending that lands mid-spawn wins.** The record is re-read after the
   * orchestrator returns; if it went `terminated` (or `error`, or vanished)
   * while the child was starting, that write stands and the new child is
   * abandoned — see {@link abandonRespawn}. Both non-`respawned` outcomes are
   * skips, not failures, so a sweep over the store keeps going. Orchestrator
   * failures DO throw; the caller owns backoff/give-up.
   *
   * NOTE: not serialized. Two overlapping calls for the same id both spawn a
   * child, and the second spawn drops the first's orchestrator handle — leaving
   * an unmanaged process. A supervisor with more than one trigger (timer +
   * exit event) must not let its passes overlap on one id.
   */
  async respawn(id: string): Promise<RespawnResult> {
    const donation = this.requireDonation(id);
    // Callers filter for this already; the guard is here so no future one can
    // resurrect or double-spawn a loan by omission.
    if (!RESPAWNABLE_STATUSES.has(donation.status)) {
      throw new DonationError(
        'invalid_state',
        `Donation ${id} cannot be respawned in status ${donation.status}`,
      );
    }
    if (!donation.bootstrapNodes?.length || !donation.ownerKeys?.length) {
      log('donation %s is not respawnable (record predates persisted spawn inputs)', id);
      return { outcome: 'not_respawnable' };
    }

    const attempted: Donation = {
      ...donation,
      respawn: {
        attempts: (donation.respawn?.attempts ?? 0) + 1,
        lastAttemptAt: this.now().toISOString(),
      },
    };

    let spawned: SpawnedHandles | undefined;
    try {
      const result = await this.orchestrator.createContainer({
        containerId: id,
        partyId: donation.partyId,
        bootstrapNodes: donation.bootstrapNodes,
        profile: donation.profile,
        pinnedOwnerKeys: donation.ownerKeys,
      });
      spawned = {
        dockerId: result.dockerId,
        seedEndpoint: result.seedEndpoint,
        seedToken: result.seedToken,
      };

      // Re-read: `donation` predates the orchestrator round-trip (seconds of
      // wall clock) and `store.put` replaces the whole row, so writing that copy
      // back would undo a `terminate` — or a reap, or a give-up — that landed
      // while the spawn was in flight, resurrecting an ended loan. The store is
      // synchronous, so this read-decide-write is atomic against the event loop
      // only as long as no `await` sneaks in between.
      const current = this.store.get(id);
      if (!current || !RESPAWNABLE_STATUSES.has(current.status)) {
        return this.abandonRespawn(id, result.dockerId, current);
      }

      const respawned: Donation = {
        ...current,
        // Merge only the attempt counters forward off the entry-time copy.
        respawn: attempted.respawn,
        dockerId: result.dockerId,
        seedEndpoint: result.seedEndpoint,
        seedToken: result.seedToken,
        // NOTE: on an `awaiting_seed` record this is the very field the
        // stale-seed reap measures age from, so each respawn defers that reap.
        // Bounded today (5 attempts, ≤80s backoff ≈ 2.5min against a 30min TTL,
        // then give-up moves the record to `error`) — but anyone raising
        // DONATION_RESPAWN_MAX_ATTEMPTS should re-check that arithmetic.
        updatedAt: this.now().toISOString(),
      };
      this.store.put(respawned);
      log('respawned donation %s → %s (status %s)', id, result.dockerId, respawned.status);
      return { outcome: 'respawned', donation: redact(respawned) };
    } catch (err) {
      const message = errorMessage(err);
      log('respawn of donation %s failed: %s', id, message);
      // Stop — never reclaim — a child we spawned but failed to record:
      // `removeContainer` deletes the workdir, which holds the identity key and
      // node-local stores that are the whole reason a respawn is the same node.
      // The new handles go onto the record below, so it names the child that
      // actually exists and a later `terminate()` reclaims that one.
      if (spawned) await this.safeStop(spawned.dockerId);
      this.storeRespawnAttempt(id, attempted.respawn, spawned);
      throw new DonationError('orchestrator_error', `Failed to respawn donated node: ${message}`);
    }
  }

  /**
   * Give up on a respawn whose loan ended while the child was starting: stop the
   * new child and, unless the record went `error`, reclaim it.
   *
   * Reclaim, not merely stop. The ending's own cleanup already ran and found
   * nothing: `HostProcessOrchestrator.createContainer` calls `dropStaleHandle`
   * *while* spawning, so by the time the concurrent `terminate` reached its
   * stop/reclaim the old handle was gone and both calls were swallowed as
   * best-effort no-ops. The new handle is now the only thing holding that
   * spawn's ports and workdir, so stopping alone would leak both. On a
   * `terminated` record the loan is over and the workdir (identity key +
   * node-local stores) goes with it — which is what `terminate` intended.
   *
   * `error` is the deliberate exception: `removeContainer` deletes the workdir,
   * and `DonationSupervisor.giveUp` keeps it on purpose so the identity key the
   * borrower's cadre approved survives. Since both spawns share one workdir
   * (`<rootDir>/<containerId>`), reclaiming here would delete exactly what
   * `giveUp` meant to keep.
   *
   * NOTE: that skipped reclaim leaks the new spawn's four ports — the record
   * still names the *previous* `dockerId`, so a later `terminate` cleans up the
   * old handle, not this one. Unreachable today (`giveUp` is only called from
   * the supervisor's serialized pass, so it cannot overlap a respawn); if a
   * second `respawn` caller ever appears, write the new `dockerId` onto the
   * `error` record here so that later `terminate` reclaims the right child.
   */
  private async abandonRespawn(
    id: string,
    dockerId: string,
    current: Donation | undefined,
  ): Promise<RespawnResult> {
    const status = current?.status;
    log(
      'donation %s went %s during respawn — abandoning new child %s',
      id,
      status ?? 'missing',
      dockerId,
    );
    await this.safeStop(dockerId);
    if (status !== 'error') await this.safeReclaim(dockerId);
    return status ? { outcome: 'abandoned', status } : { outcome: 'abandoned' };
  }

  /**
   * Terminate a donation: mark the record `terminated` FIRST, then stop + remove
   * the child process (kept in the store for audit, excluded from the live-node
   * tally).
   *
   * Order matters: stopping the child fires the orchestrator's `onStateChange`,
   * and a respawn supervisor listening there must already see a terminal record
   * — otherwise it observes "node gone, record still `seeded`" and resurrects a
   * loan the borrower just ended. The tradeoff: a crash between the write and
   * the stop leaves a `terminated` record with a live child (reaped on the next
   * host start), which is strictly better than resurrecting an ended loan.
   */
  async terminate(id: string): Promise<void> {
    const donation = this.requireDonation(id);
    this.store.put({ ...donation, status: 'terminated', updatedAt: this.now().toISOString() });
    if (donation.dockerId) {
      await this.safeStop(donation.dockerId);
      await this.safeReclaim(donation.dockerId);
    }
    log('donation %s terminated', id);
  }

  /**
   * Auto-terminate donations still `awaiting_seed` past `ttlMs` — a requester
   * that provisioned a node but never presented a seed leaves an orphaned child
   * holding host ports. Run on a periodic sweep and once at startup for records
   * recovered from disk. Age is measured from the record's `updatedAt` (set when
   * it entered `awaiting_seed`). Best-effort per record: a failed terminate is
   * logged and the sweep continues. Returns the reaped donation ids.
   */
  async reapStaleAwaitingSeed(ttlMs: number = DONATION_AWAITING_SEED_TTL_MS): Promise<string[]> {
    const cutoff = this.now().getTime() - ttlMs;
    const stale = this.store.list().filter((d) => isReapable(d, cutoff));
    const reaped: string[] = [];
    for (const donation of stale) {
      try {
        // Re-read: every `terminate` awaits, so from the second record on the
        // candidate list is a stale snapshot. A seed landing in that gap makes
        // the record `seeded`, and a respawn refreshes `updatedAt` precisely to
        // defer this reap — terminating the snapshot copy would kill a loan that
        // just came good. `terminate` writes synchronously from here, so nothing
        // can slip between this decision and the terminal write.
        if (!isReapable(this.store.get(donation.id), cutoff)) continue;
        await this.terminate(donation.id);
        reaped.push(donation.id);
        log('reaped stale awaiting_seed donation %s (age > %dms)', donation.id, ttlMs);
      } catch (err) {
        log('failed to reap donation %s: %s', donation.id, errorMessage(err));
      }
    }
    return reaped;
  }

  /**
   * Auto-terminate donations stuck in `provisioning` past `ttlMs` — the record
   * is written before the child spawn starts, so a host crash/kill anywhere in
   * that window (including mid-spawn) leaves nothing to advance it across a
   * restart: there is no in-flight `provisionLocked` call left to reach its
   * post-spawn re-read. Run on the same periodic sweep and startup pass as
   * {@link reapStaleAwaitingSeed}. Age is measured from `updatedAt`, which for a
   * genuinely-stuck row equals `createdAt` — `provisionLocked` never touches a
   * `provisioning` record again except to advance it out of this predicate.
   * Best-effort per record: a failed reap is logged and the sweep continues.
   * Returns the reaped donation ids.
   */
  async reapStaleProvisioning(ttlMs: number = DONATION_PROVISIONING_TTL_MS): Promise<string[]> {
    const cutoff = this.now().getTime() - ttlMs;
    const stale = this.store.list().filter((d) => isStaleProvisioning(d, cutoff));
    const reaped: string[] = [];
    for (const donation of stale) {
      try {
        // Re-read: an in-flight (same-process) provisionLocked call can still
        // advance this exact record between the snapshot above and now.
        const current = this.store.get(donation.id);
        if (!current || !isStaleProvisioning(current, cutoff)) continue;
        await this.reclaimStuckProvisioning(current);
        reaped.push(donation.id);
        log('reaped stuck provisioning donation %s (age > %dms)', donation.id, ttlMs);
      } catch (err) {
        log('failed to reap stuck provisioning donation %s: %s', donation.id, errorMessage(err));
      }
    }
    return reaped;
  }

  /**
   * Terminalize a stuck-`provisioning` record as `error` and reclaim any child
   * the orchestrator can still find for it. Status is written FIRST (same
   * ordering rule as {@link terminate}): reclaiming fires `onStateChange`, and
   * anything listening must already see a terminal record.
   *
   * NOTE: the reclaim only reaches a child the orchestrator has a handle for.
   * `HostProcessOrchestrator.launchChild` spawns the process and persists the
   * handle in the same synchronous step, so the only child this misses is one
   * whose host died between the OS spawn and that write — an orphan process
   * this reap terminalizes the record for but cannot kill (its ports stay held
   * until a reboot). If that window ever widens (an async step added between
   * spawn and persist), the orchestrator needs its own orphan sweep — a record
   * that names no handle cannot get one after the fact.
   */
  private async reclaimStuckProvisioning(donation: Donation): Promise<void> {
    this.store.put({
      ...donation,
      status: 'error',
      error: 'stuck in provisioning past TTL — host likely restarted mid-spawn',
      updatedAt: this.now().toISOString(),
    });
    const dockerId = this.orchestrator.resolveDockerId?.(donation.id);
    if (dockerId) {
      await this.safeStop(dockerId);
      await this.safeReclaim(dockerId);
    }
  }

  /** One donation (redacted), or undefined when unknown. */
  get(id: string): DonationView | undefined {
    const donation = this.store.get(id);
    return donation ? redact(donation) : undefined;
  }

  /** All donations (redacted), optionally scoped to one grant token. */
  list(grantToken?: string): DonationView[] {
    const rows = grantToken ? this.store.listByGrant(grantToken) : this.store.list();
    return rows.map(redact);
  }

  private requireDonation(id: string): Donation {
    const donation = this.store.get(id);
    if (!donation) {
      throw new DonationError('not_found', `No such donation: ${id}`);
    }
    return donation;
  }

  /** Best-effort stop; logs but never throws (cleanup path). */
  private async safeStop(dockerId: string): Promise<void> {
    try {
      await this.orchestrator.stopContainer(dockerId);
    } catch (err) {
      log('failed to stop container %s: %s', dockerId, errorMessage(err));
    }
  }

  /**
   * Persist a failed respawn's attempt counters — plus, when the spawn itself
   * succeeded and it was the record write that failed, the new child's handles.
   * Merged onto whatever is on disk now, never written wholesale: the caller's
   * copy predates the orchestrator round-trip and `store.put` replaces the whole
   * row, so writing it back would undo a `terminate` that landed while the spawn
   * was in flight and resurrect a loan the borrower just ended.
   *
   * `status` and `updatedAt` are deliberately untouched — the attempt did not
   * succeed, and `updatedAt` is what defers the stale-`awaiting_seed` reap.
   *
   * Recording `spawned` is what keeps the record pointing at the child that
   * actually exists: `createContainer` already dropped the handle the record
   * previously named, so leaving the old `dockerId` there would send every later
   * stop/reclaim at an id the orchestrator cannot resolve — stranding the node's
   * workdir on disk forever.
   *
   * Best-effort: we are already unwinding a respawn failure, and a store error
   * here must not mask it. Losing the write costs the caller one extra attempt
   * before backoff; the supervisor's next pass re-reads the record, finds the
   * named child not running, and respawns again — which drops whatever handle is
   * current, so the ports self-heal either way.
   */
  private storeRespawnAttempt(
    id: string,
    respawn: Donation['respawn'],
    spawned?: SpawnedHandles,
  ): void {
    try {
      const current = this.store.get(id);
      if (!current || !respawn) return;
      this.store.put({ ...current, respawn, ...spawned });
    } catch (err) {
      log('failed to record respawn attempt for %s: %s', id, errorMessage(err));
    }
  }

  /** Best-effort remove; logs but never throws (cleanup path). */
  private async safeReclaim(dockerId: string): Promise<void> {
    try {
      await this.orchestrator.removeContainer(dockerId);
    } catch (err) {
      log('failed to reclaim container %s: %s', dockerId, errorMessage(err));
    }
  }

  /**
   * Run `fn` after any in-flight provision for the same grant token, so the
   * quota check + record-create pair is atomic per grant.
   */
  private async serializeByGrant<T>(token: string, fn: () => Promise<T>): Promise<T> {
    const prior = this.provisionTail.get(token) ?? Promise.resolve();
    const run = prior.then(fn, fn);
    // The stored tail swallows outcomes — a rejected provision must not reject
    // the next caller's wait, only defer it.
    this.provisionTail.set(token, run.then(() => undefined, () => undefined));
    return run;
  }
}

/** `grn_<high-entropy base64url>` — also the donated node's orchestrator containerId. */
function generateDonationId(): string {
  return `grn_${randomBytes(12).toString('base64url')}`;
}

/** Strip the host-only secrets (`seedToken`) and internal URL (`seedEndpoint`). */
function redact(donation: Donation): DonationView {
  const { seedToken: _seedToken, seedEndpoint: _seedEndpoint, ...view } = donation;
  return view;
}

/** Map a grant denial to the donation error the routes surface as HTTP status. */
function denialToError(reason: GrantDenyReason | undefined): DonationError {
  switch (reason) {
    case 'quota_exceeded':
      return new DonationError('quota_exceeded', 'Grant is already at its node cap');
    case 'expired':
    case 'revoked':
      return new DonationError('forbidden', `Grant is ${reason}`);
    case 'unknown_token':
    default:
      return new DonationError('unauthorized', 'Unknown or missing grant token');
  }
}

/**
 * Whether a record is still a stale-`awaiting_seed` reap candidate: the requester
 * provisioned a node and has not presented a seed since `cutoff`. Stated once and
 * applied twice in {@link DonationService.reapStaleAwaitingSeed} — on the sweep's
 * candidate list, and again per record before the terminal write.
 */
function isReapable(donation: Donation | undefined, cutoff: number): boolean {
  return donation?.status === 'awaiting_seed' && Date.parse(donation.updatedAt) < cutoff;
}

/**
 * Whether a record is still a stuck-`provisioning` reap candidate. Stated
 * once and applied twice in {@link DonationService.reapStaleProvisioning} — on
 * the sweep's candidate list, and again per record before the terminal write.
 */
function isStaleProvisioning(donation: Donation | undefined, cutoff: number): boolean {
  return donation?.status === 'provisioning' && Date.parse(donation.updatedAt) < cutoff;
}

/** Derive the node's `/status` URL from its `/seed` URL (same origin/port). */
function toStatusUrl(seedEndpoint: string): string {
  const url = new URL(seedEndpoint);
  url.pathname = '/status';
  return url.toString();
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
