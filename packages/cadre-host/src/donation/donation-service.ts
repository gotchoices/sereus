import { randomBytes } from 'node:crypto';
import debug from 'debug';

import type { Orchestrator } from '@serfab/cadre-provider';

import type { DonationStore } from './donation-store.js';
import type {
  Donation,
  DonationView,
  GrantDenyReason,
  GrantValidator,
} from './types.js';
import { DonationError } from './types.js';

const log = debug('cadre:host:donation-service');

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

/** Result of presenting a seed to a donated node's `POST /seed`. */
export interface DonationSeedResult {
  success: boolean;
  peersAdded?: number;
  error?: string;
}

/** Live peer identity of a donated node. */
export interface DonationPeerInfo {
  peerId: string;
  multiaddrs: string[];
}

/** Constructor options. */
export interface DonationServiceOptions {
  /** Orchestrator that spawns/stops the donated node child process. */
  orchestrator: Orchestrator;
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
  private readonly orchestrator: Orchestrator;
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

    // Once the orchestrator returns a dockerId this service owns cleanup of
    // those (bounded host port) resources on every non-success exit.
    let dockerId: string | undefined;
    try {
      const result = await this.orchestrator.createContainer({
        containerId: id,
        partyId: request.partyId,
        bootstrapNodes: request.bootstrapNodes,
        profile,
        pinnedOwnerKeys: request.ownerKeys,
      });
      dockerId = result.dockerId;

      const provisioned: Donation = {
        ...record,
        dockerId: result.dockerId,
        seedEndpoint: result.seedEndpoint,
        // Persisted so a host restart in the request→seed gap can still present
        // the seed. NEVER returned to the grantee (stripped by `DonationView`).
        seedToken: result.seedToken,
        status: 'awaiting_seed',
        updatedAt: this.now().toISOString(),
      };
      this.store.put(provisioned);
      log('provisioned donation %s (party=%s) → awaiting_seed', id, request.partyId);
      return redact(provisioned);
    } catch (err) {
      const message = errorMessage(err);
      log('provision of donation %s failed: %s', id, message);
      if (dockerId) await this.safeReclaim(dockerId);
      this.store.put({
        ...record,
        status: 'error',
        error: message,
        updatedAt: this.now().toISOString(),
      });
      throw new DonationError('orchestrator_error', `Failed to provision donated node: ${message}`);
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
   * signed by a key the node did not pin is rejected here (`success: false`).
   */
  async applySeed(id: string, encodedSeed: string): Promise<DonationSeedResult> {
    const donation = this.requireDonation(id);
    if (donation.status !== 'awaiting_seed' && donation.status !== 'seeded') {
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

    const result = (await res.json()) as DonationSeedResult;
    if (result.success) {
      this.store.put({ ...donation, status: 'seeded', updatedAt: this.now().toISOString() });
      log('donation %s seeded (peersAdded=%d)', id, result.peersAdded ?? 0);
    }
    return result;
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
   * Returns the refreshed view, or `undefined` when the record predates
   * respawn support (no persisted `bootstrapNodes`/`ownerKeys`) and therefore
   * cannot be replayed — a skip, not a failure, so a sweep over the store keeps
   * going. Orchestrator failures DO throw; the caller owns backoff/give-up.
   *
   * NOTE: not serialized. Two overlapping calls for the same id both spawn a
   * child, and the second spawn drops the first's orchestrator handle — leaving
   * an unmanaged process. A supervisor with more than one trigger (timer +
   * exit event) must not let its passes overlap on one id.
   */
  async respawn(id: string): Promise<DonationView | undefined> {
    const donation = this.requireDonation(id);
    // An allowlist, not a terminal denylist: `terminated` is a loan the borrower
    // ended and `error` one the host gave up on (neither may come back), while
    // `provisioning` is a provision still in flight — replaying its spawn would
    // race that provision and strand the record in `provisioning`, which no reap
    // sweep collects. Callers filter for this already; the guard is here so no
    // future one can resurrect or double-spawn a loan by omission.
    if (donation.status !== 'awaiting_seed' && donation.status !== 'seeded') {
      throw new DonationError(
        'invalid_state',
        `Donation ${id} cannot be respawned in status ${donation.status}`,
      );
    }
    if (!donation.bootstrapNodes?.length || !donation.ownerKeys?.length) {
      log('donation %s is not respawnable (record predates persisted spawn inputs)', id);
      return undefined;
    }

    const attempted: Donation = {
      ...donation,
      respawn: {
        attempts: (donation.respawn?.attempts ?? 0) + 1,
        lastAttemptAt: this.now().toISOString(),
      },
    };

    let dockerId: string | undefined;
    try {
      const result = await this.orchestrator.createContainer({
        containerId: id,
        partyId: donation.partyId,
        bootstrapNodes: donation.bootstrapNodes,
        profile: donation.profile,
        pinnedOwnerKeys: donation.ownerKeys,
      });
      dockerId = result.dockerId;

      const respawned: Donation = {
        ...attempted,
        dockerId: result.dockerId,
        seedEndpoint: result.seedEndpoint,
        seedToken: result.seedToken,
        updatedAt: this.now().toISOString(),
      };
      this.store.put(respawned);
      log('respawned donation %s → %s (status %s)', id, result.dockerId, respawned.status);
      return redact(respawned);
    } catch (err) {
      const message = errorMessage(err);
      log('respawn of donation %s failed: %s', id, message);
      // Stop — never reclaim — a child we spawned but failed to record:
      // `removeContainer` deletes the workdir, which holds the identity key and
      // node-local stores that are the whole reason a respawn is the same node.
      // The orphaned handle's ports are released by the next createContainer for
      // this containerId, so the leak is self-healing.
      if (dockerId) await this.safeStop(dockerId);
      this.storeAttempt(attempted);
      throw new DonationError('orchestrator_error', `Failed to respawn donated node: ${message}`);
    }
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
    const stale = this.store
      .list()
      .filter((d) => d.status === 'awaiting_seed' && Date.parse(d.updatedAt) < cutoff);
    const reaped: string[] = [];
    for (const donation of stale) {
      try {
        await this.terminate(donation.id);
        reaped.push(donation.id);
        log('reaped stale awaiting_seed donation %s (age > %dms)', donation.id, ttlMs);
      } catch (err) {
        log('failed to reap donation %s: %s', donation.id, errorMessage(err));
      }
    }
    return reaped;
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
   * Persist a failed respawn's attempt counters — and ONLY those. The caller's
   * copy predates the orchestrator round-trip and `store.put` replaces the whole
   * row, so writing it back wholesale would undo a `terminate` that landed while
   * the spawn was in flight and resurrect a loan the borrower just ended. Merge
   * the counters onto whatever is on disk now instead.
   *
   * Best-effort: we are already unwinding an orchestrator failure, and a store
   * error here must not mask it. Losing the counter only costs the caller one
   * extra attempt before backoff.
   */
  private storeAttempt(donation: Donation): void {
    try {
      const current = this.store.get(donation.id);
      if (!current || !donation.respawn) return;
      this.store.put({ ...current, respawn: donation.respawn });
    } catch (err) {
      log('failed to record respawn attempt for %s: %s', donation.id, errorMessage(err));
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

/** Derive the node's `/status` URL from its `/seed` URL (same origin/port). */
function toStatusUrl(seedEndpoint: string): string {
  const url = new URL(seedEndpoint);
  url.pathname = '/status';
  return url.toString();
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
