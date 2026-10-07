import { writeFileSync } from 'node:fs';
import { Command } from 'commander';
import debug from 'debug';
import {
  ed25519KeyPairFromLibp2p,
  pinnedKeyTrustPolicy,
  requireEd25519PublicKeyB64,
  type ControlNetworkSeed,
  type NodeClaimRecord,
  type SeedTrustPolicy,
  type CadreInvitation,
} from '@serfab/cadre-core';
import { fromString } from 'uint8arrays';
import { specifiedEnv } from '@serfab/config-check';
import { resolveConfig, type ResolvedConfig } from '../config/index.js';
import { commandEnv } from '../config/env.js';
import { claimRecordPath, partyOnRecord, type ClaimRecord } from './claim-record.js';
import { afterClaimSeedSettles, buildClaimedNode, buildConfiguredNode, claimConfigFor } from './start-node.js';
import {
  decodeInvitationFor,
  redeemStartupInvitation,
  refuseInvitationConflicts,
  startupInvitation,
  type StartupInvitation,
} from './start-invitation.js';
import { HealthServer, type InvitationStatus } from '../server/health.js';
import { AdminServer } from '../server/admin-server.js';

const log = debug('cadre:cli:start');

/**
 * Decode `--seed` and check that it belongs to this node's party, throwing when either fails.
 *
 * `applySeed` never compares the two (see the NOTE in cadre-core's `SeedBootstrapService.applySeed`),
 * so a seed copied onto a machine whose config names another party would otherwise be applied
 * while the node went on serving the configured party. Both are configuration errors caught
 * before anything starts, so they stop start-up rather than leave the node running unseeded.
 */
export function decodeSeedFor(encoded: string, partyId: string): ControlNetworkSeed {
  let decoded: unknown;
  try {
    decoded = JSON.parse(new TextDecoder().decode(fromString(encoded, 'base64url')));
  } catch (err) {
    throw new Error(
      `--seed does not decode as a control network seed: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err }
    );
  }
  const seedPartyId = (decoded as Partial<ControlNetworkSeed> | null)?.partyId;
  if (typeof seedPartyId !== 'string') {
    throw new Error('--seed does not decode as a control network seed: it names no party');
  }
  if (seedPartyId !== partyId) {
    throw new Error(
      `--seed was minted for party ${seedPartyId}, but this node's config names party ${partyId} `
      + '(controlNetwork.partyId). Use a seed minted by this party\'s owner, or correct the config.'
    );
  }
  return decoded as ControlNetworkSeed;
}

/** Commander collector for the repeatable `--pin-owner-key` option. */
function collectPinKey(value: string, previous: string[]): string[] {
  return [...previous, value];
}

/**
 * Union the operator's pinned owner keys from the repeatable
 * `--pin-owner-key` flag and the comma-separated `CADRE_OWNER_KEYS`
 * env var. Trims each entry, drops empties, and dedupes — so the same key via
 * both sources appears once and a whitespace-only env (`",, "`) yields `[]`.
 *
 * Does not validate key shape — see {@link validatePinnedOwnerKeys}, applied
 * separately so this function's trim/dedupe contract stays easy to unit-test
 * against plain placeholder strings.
 */
export function collectPinnedOwnerKeys(
  flagKeys: string[] | undefined,
  env: string | undefined,
): string[] {
  const fromEnv = (env ?? '').split(',');
  return [...new Set([...(flagKeys ?? []), ...fromEnv].map(k => k.trim()).filter(k => k.length > 0))];
}

/**
 * Reject a malformed pinned owner key at startup, naming the bad value, instead
 * of letting it sit in the trust anchor un-diagnosed: previously a typo'd
 * `--pin-owner-key` / `CADRE_OWNER_KEYS` entry never matched a real signer key,
 * so the node started fine and only failed much later — as an opaque "seed
 * signer not anchored" rejection — with nothing pointing at the typo.
 */
export function validatePinnedOwnerKeys(keys: string[]): string[] {
  return keys.map(key => requireEd25519PublicKeyB64(key, 'pinned owner key (--pin-owner-key / CADRE_OWNER_KEYS)'));
}

/**
 * Refuse every start-up option that cannot be combined with a claim, all named in one error.
 * A node waiting to be claimed takes its owner from the claim, and a claimed node took it from
 * the claim on record; each of these is another way in: `--owner` founds a cadre on this node,
 * `--seed` and an invitation (`--invitation`, `CADRE_INVITATION`) join one, and a pinned owner
 * key (`--pin-owner-key`, `CADRE_OWNER_KEYS`) trusts a signer the claim never named. The node
 * refuses a pin beside a
 * claim itself (`CadreNodeConfig.claim`), but its message names the config field; this check
 * runs first — for the secret, before the config is loaded — and names the options the
 * operator actually passed. `subject` is what the message blames: the secret, or the record.
 */
export function refuseClaimConflicts(
  options: { owner?: boolean; seed?: string; invitation?: StartupInvitation; pinOwnerKey?: string[] },
  ownerKeysEnv: string | undefined,
  subject: string = 'CADRE_CLAIM_SECRET',
): void {
  const conflicts = [
    options.owner ? '--owner' : undefined,
    options.seed ? '--seed' : undefined,
    options.invitation?.source,
    collectPinnedOwnerKeys(options.pinOwnerKey, undefined).length > 0 ? '--pin-owner-key' : undefined,
    collectPinnedOwnerKeys(undefined, ownerKeysEnv).length > 0 ? 'CADRE_OWNER_KEYS' : undefined,
  ].filter((name): name is string => name !== undefined);
  if (conflicts.length > 0) {
    throw new Error(`${subject} cannot be combined with ${conflicts.join(', ')}: a node that is claimed, or waiting to be, `
      + 'takes its owner from the claim. Remove the claim, or start without the conflicting options.');
  }
}

/**
 * Write `$CADRE_STARTUP_TOKEN` to `path` (the `--startup-token-file`), if both are given.
 *
 * The file is an identity proof, not a readiness signal: an orchestrator
 * (cadre-host's `HostProcessOrchestrator`) reads it to confirm that a live PID is
 * the child it spawned rather than a recycled one. So it is written first, before
 * the health server binds its port and before `node.start()` — a child that bound
 * its ports but had not yet written the file would read as "not running" for its
 * whole start-up, and the orchestrator would launch a second copy that dies on
 * those same ports.
 */
function writeStartupToken(path: string | undefined): void {
  const token = commandEnv('CADRE_STARTUP_TOKEN') ?? '';
  if (!path || token.length === 0) return;
  writeFileSync(path, token, { encoding: 'utf8' });
  log('Wrote startup token to %s', path);
}

/** `--ws-port` convenience: append a WebSocket listen address to the config's listen addresses. */
function applyWsPortOption(config: ResolvedConfig, wsPort: string | undefined): void {
  if (!wsPort) return;
  const port = parseInt(wsPort, 10);
  if (isNaN(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid WebSocket port: ${wsPort}`);
  }
  const wsAddr = `/ip4/0.0.0.0/tcp/${port}/ws`;
  if (!config.network) config.network = {};
  if (!config.network.listenAddrs) config.network.listenAddrs = [];
  if (!config.network.listenAddrs.includes(wsAddr)) {
    config.network.listenAddrs.push(wsAddr);
    log('Added WebSocket listen address: %s', wsAddr);
  }
}

/** Say which party a node started from its claim record serves, and that the config's is ignored when it differs. */
function reportClaimOnRecord(claim: ClaimRecord, configuredPartyId: string): void {
  const placeholder = configuredPartyId === claim.partyId
    ? ''
    : ` (controlNetwork.partyId '${configuredPartyId}' is a placeholder and is ignored)`;
  console.log(`• Claimed by owner ${claim.ownerKey.slice(0, 8)} into party ${claim.partyId}${placeholder}`);
}

export const startCommand = new Command('start')
  .description('Start the cadre node with the specified configuration')
  .option('-c, --config <path>', 'Path to config file (YAML or JSON)', 'cadre.yaml')
  .option('-d, --debug', 'Enable debug logging')
  .option('--health-port <port>', 'Health check server port', '8080')
  .option('--metrics-port <port>', 'Prometheus metrics server port', '9090')
  .option('--no-health-server', 'Disable health check and metrics servers')
  // NOTE: the seed rides the command line, and Windows caps a command line near 32K characters.
  // Each seed peer is a few hundred bytes of JSON before base64. If cadres grow to dozens of
  // machines, add a --seed-file.
  .option('--seed <encoded>', 'Apply a base64url-encoded seed on startup — what `cadre enroll add` prints on the owner machine. Start-up fails if it does not decode or names a party other than the config\'s controlNetwork.partyId')
  .option('--invitation <encoded>', 'Redeem a cadre invitation on startup — what `cadre enroll invite` prints on the owner machine — at any member of the cadre it names, so this node can join while the owner is offline. CADRE_INVITATION is the same, kept out of the process list; pass one of the two. Needs a node identity (the redemption is signed with it); cannot be combined with --seed or --owner. Start-up fails if it does not decode or names another party')
  .option('--listen-for-seeds', 'Enable the seed protocol listener for receiving seeds')
  .option('--ws-port <port>', 'WebSocket listen port (convenience: appends /ip4/0.0.0.0/tcp/<port>/ws to listen addresses)')
  .option('--startup-token-file <path>', 'Write $CADRE_STARTUP_TOKEN to this file as the first step of start-up, before any port is bound. Used by external orchestrators to verify a live PID is the child they spawned (vs a recycled PID) — an identity check, not a readiness signal.')
  .option('--identity-file <path>', 'Load the node identity from a libp2p protobuf private key file — the one identity format, written by \'cadre enroll create\' and by cadre-host for each node it runs (identity.key). Takes precedence over the config file\'s identity.keyFile.')
  .option('--owner', 'Run as the owner of this node\'s OWN cadre: initialize seed-bootstrap from the node identity and perform the idempotent genesis OwnerKey insert on a fresh party. This is the founder persona — NOT a node donated to a requester. Donated nodes are generic and pin the requester\'s owner key via --pin-owner-key instead.')
  .option('--admin-port <port>', 'Bind the loopback admin channel (127.0.0.1) on this port. Requires CADRE_STARTUP_TOKEN in env.')
  .option('--pin-owner-key <b64url>', 'Pin a base64url owner key as a cold-start seed-trust anchor (repeatable; unions with CADRE_OWNER_KEYS). Required for a cold node to accept --seed / POST /seed.', collectPinKey, [])
  .action(async (options) => {
    if (options.debug) {
      debug.enable('cadre:*,sereus:*');
    }

    console.log('Starting cadre node...');
    log('Loading configuration from: %s', options.config);

    try {
      writeStartupToken(options.startupTokenFile);

      // Env only, never a flag: a flag value shows in the process list. Set-but-empty is unset,
      // as for every other variable.
      const claimSecret = specifiedEnv(commandEnv('CADRE_CLAIM_SECRET'));
      const startup = startupInvitation(options.invitation, commandEnv('CADRE_INVITATION'));
      const conflictOptions = { owner: options.owner, seed: options.seed, invitation: startup, pinOwnerKey: options.pinOwnerKey };
      if (claimSecret !== undefined) refuseClaimConflicts(conflictOptions, commandEnv('CADRE_OWNER_KEYS'));

      // A --identity-file flag overrides the config file's identity. Route it through the env
      // mapping (CADRE_KEY_FILE -> identity.keyFile) so the loader resolves it exactly as the
      // config-file path, and so applyEnvironmentOverrides' env-beats-file precedence carries it.
      // Overwriting a CADRE_KEY_FILE the ambient environment already set (the docker entrypoint
      // exports one) is intended: an explicit flag outranks the environment.
      if (options.identityFile) {
        process.env.CADRE_KEY_FILE = options.identityFile;
      }

      const config = await resolveConfig(options.config);
      applyWsPortOption(config, options.wsPort);

      // The claim on record names the party this node serves and the owner it belongs to; the
      // config's party is then a placeholder. A malformed record throws here and stops the
      // start (`claim-record.ts` says why). The record refuses the same options the secret
      // does, whether or not the secret is still set.
      const { partyId, claim: claimOnRecord } = await partyOnRecord(config);
      if (claimOnRecord) {
        refuseClaimConflicts(conflictOptions, commandEnv('CADRE_OWNER_KEYS'), `The claim on record (${claimRecordPath(config.nodeStateDir)})`);
        reportClaimOnRecord(claimOnRecord, config.controlNetwork.partyId);
      }

      // The conflict check comes before either decode, so an operator who passed both flags
      // is told that, not that one of the two values failed to decode.
      if (startup) refuseInvitationConflicts(startup, options);
      const seed = options.seed ? decodeSeedFor(options.seed, partyId) : undefined;
      let invitation: CadreInvitation | undefined;
      if (startup) {
        if (!config.privateKey) {
          throw new Error(`${startup.source} requires a node identity (set identity.keyFile in the config, or pass --identity-file): the redemption is signed with it`);
        }
        invitation = decodeInvitationFor(startup, partyId);
      }
      // How the redemption below stands, as `/status` reports it to a launcher following the join.
      let invitationStatus: InvitationStatus | undefined = invitation ? { state: 'pending' } : undefined;

      // Operator-pinned owner keys anchor cold-start seed trust. Build the
      // policy BEFORE constructing CadreNode so every later service-construction
      // site (seed listener, temp-service for applySeed / POST /seed) captures
      // it as the node-wide default — it is read at construction time.
      const pinnedKeys = validatePinnedOwnerKeys(collectPinnedOwnerKeys(options.pinOwnerKey, commandEnv('CADRE_OWNER_KEYS')));
      const seedTrustPolicy: SeedTrustPolicy | undefined =
        pinnedKeys.length > 0 ? pinnedKeyTrustPolicy(pinnedKeys) : undefined;
      if (pinnedKeys.length > 0) {
        console.log(`✓ Pinned ${pinnedKeys.length} owner key(s) for cold-start seed trust`);
      }

      // The claim on record as `/status` reports it: read above, or written by the node's claim
      // policy when a claim is accepted in this process.
      // NOTE: the record is written before the anchor, so if the anchor persist then fails the
      // policy refuses `claim-not-persisted` and no restart follows, while `/status` already
      // reads `claimed` by that owner under the placeholder party; the claimant's retry, or the
      // next process start from the record, repairs it. If that window is ever seen, exit
      // non-zero on a refusal after a record so the supervisor restarts from the record.
      let claimRecord = claimOnRecord;
      const claimConfig = claimConfigFor(claimSecret, config.nodeStateDir, (record) => { claimRecord = record; });

      // The current node. Reassigned once, by the restart into the claimed party below; the
      // servers and the shutdown handler go through this variable so they follow it.
      let node = claimOnRecord
        ? await buildClaimedNode(config, claimOnRecord, claimConfig)
        : await buildConfiguredNode(config, pinnedKeys, seedTrustPolicy, claimConfig);

      // Start health/metrics servers if enabled
      let healthServer: HealthServer | null = null;
      if (options.healthServer !== false) {
        const healthPort = parseInt(commandEnv('CADRE_HEALTH_PORT') ?? options.healthPort, 10);
        const metricsPort = parseInt(commandEnv('CADRE_METRICS_PORT') ?? options.metricsPort, 10);

        // POST /seed is registered only when CADRE_SEED_TOKEN is set; otherwise
        // the health port serves read-only liveness/readiness probes. Keep this
        // distinct from CADRE_STARTUP_TOKEN (PID-verify / admin-channel bearer).
        const seedToken = commandEnv('CADRE_SEED_TOKEN') ?? '';

        healthServer = new HealthServer({
          healthPort,
          metricsPort,
          profile: config.profile,
          seedToken,
          claim: () => ({ secretConfigured: claimSecret !== undefined, claimedBy: claimRecord?.ownerKey }),
          invitation: () => invitationStatus,
        });
        healthServer.attach(node);
        await healthServer.start();
        console.log(`✓ Health server on port ${healthPort}, metrics on port ${metricsPort}`);
        if (seedToken.length > 0) {
          console.log('✓ Seed endpoint authenticated (POST /seed requires bearer token)');
        } else {
          log('Seed endpoint disabled (set CADRE_SEED_TOKEN to enable authenticated POST /seed)');
        }
      }

      // The admin channel is created after owner init below; declared here
      // so graceful shutdown can close it.
      let adminServer: AdminServer | null = null;

      // Handle graceful shutdown
      const shutdown = async () => {
        console.log('\nShutting down...');
        if (adminServer) {
          await adminServer.stop();
        }
        if (healthServer) {
          await healthServer.stop();
        }
        await node.stop();
        console.log('Cadre node stopped.');
        process.exit(0);
      };

      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);

      /**
       * Replace the node with one built for the claimed party — the path the next start takes
       * from the record, taken now so the owner's cadre gets its node without a process restart.
       * The servers stay up and are re-pointed; the listen addresses are rebound. A restart that
       * fails (a store that will not open, a port that will not rebind) exits non-zero rather
       * than leaving a process with no node in it: the embedder's supervisor respawns it, and
       * that start takes the claimed path from the record.
       */
      const restartIntoClaimedParty = async (accepted: NodeClaimRecord): Promise<void> => {
        console.log(`• Restarting into party ${accepted.partyId}`);
        await node.stop();
        node = await buildClaimedNode(config, accepted, claimConfig);
        healthServer?.attach(node);
        adminServer?.attach(node);
        await node.start();
        console.log(`✓ Restarted into party ${accepted.partyId} as a node claimed by owner ${accepted.ownerKey.slice(0, 8)}`);
      };
      if (claimSecret !== undefined && !claimOnRecord) {
        const unclaimedNode = node;
        unclaimedNode.on('claim:accepted', (accepted) => {
          afterClaimSeedSettles(unclaimedNode, accepted.partyId, () => {
            restartIntoClaimedParty(accepted).catch((err: unknown) => {
              console.error('✗ Failed to restart into the claimed party; exiting so the supervisor restarts from the claim record:',
                err instanceof Error ? err.message : err);
              log('Restart error details: %o', err);
              process.exit(1);
            });
          });
        });
      }

      // Start the node
      await node.start();

      if (claimSecret !== undefined) {
        console.log(node.isAwaitingClaim() ? '✓ Awaiting claim' : '• Already claimed; CADRE_CLAIM_SECRET is ignored');
      }

      // Join by invitation, right after the node is up: the redemption dials the members the
      // bundle names and the node then syncs the control database over the connection it holds.
      if (invitation) invitationStatus = await redeemStartupInvitation(node, invitation);

      // Owner init: bridge the libp2p identity into a base64url owner
      // keypair, run the idempotent genesis insert on a fresh party, then bring
      // up seed-bootstrap so this node can mint invites and authorize peers.
      if (options.owner) {
        if (!config.privateKey) {
          throw new Error('--owner requires a node identity (set identity.keyFile in the config, or pass --identity-file)');
        }
        const { privateKeyB64, publicKeyB64 } = ed25519KeyPairFromLibp2p(config.privateKey);

        const controlDb = node.getControlDatabase();
        if (!controlDb) {
          throw new Error('Control database unavailable after start; cannot run owner genesis');
        }
        const inserted = await controlDb.ensureOwnerKey(publicKeyB64);
        console.log(inserted
          ? '✓ Genesis: inserted founding owner key'
          : '• Owner key already present; skipping genesis');

        await node.initializeSeedBootstrap(privateKeyB64);
        console.log('✓ Owner seed-bootstrap initialized');

        // Write the owner's own signed CadrePeer row up-front, before any
        // seed can be minted. The background heartbeat keeps it fresh, but it
        // fires too late for the first invite/seed — without this, createSeed()
        // would omit the owner peer, so a freshly-seeded node would have no
        // owner multiaddr to dial (applySeed dials the seed's isOwner
        // peers) until the ~7.5 min heartbeat first published the row.
        const selfReg = await node.registerSelf();
        const selfRegMessage: Record<typeof selfReg, string> = {
          inserted: '✓ Owner self-registered into CadrePeer (row inserted)',
          refreshed: '✓ Owner CadrePeer record refreshed',
          skipped: '• Owner self-registration skipped (see logs for the reason; the heartbeat retries)',
        };
        console.log(selfRegMessage[selfReg]);
      }

      // Bind the loopback admin channel if requested. The startup token doubles
      // as the bearer secret, so refuse to expose the surface without it.
      const adminPortRaw = commandEnv('CADRE_ADMIN_PORT') ?? options.adminPort;
      if (adminPortRaw) {
        const adminPort = parseInt(adminPortRaw, 10);
        if (isNaN(adminPort) || adminPort < 0 || adminPort > 65535) {
          throw new Error(`Invalid admin port: ${adminPortRaw}`);
        }
        const token = commandEnv('CADRE_STARTUP_TOKEN') ?? '';
        if (token.length === 0) {
          throw new Error('--admin-port requires CADRE_STARTUP_TOKEN in env (used as the admin bearer token)');
        }
        adminServer = new AdminServer({ port: adminPort, token });
        adminServer.attach(node);
        await adminServer.start();
        console.log(`✓ Admin channel on 127.0.0.1:${adminServer.port}`);
      }

      // Enable seed listener if requested
      if (options.listenForSeeds) {
        await node.enableSeedListener();
        console.log('✓ Seed protocol listener enabled');
      }

      // Apply seed if provided
      if (seed) {
        try {
          log('Applying seed for party: %s', seed.partyId);
          // Pass the pinned policy as the per-call override too: self-documenting,
          // and covers the cold path where neither --owner nor
          // --listen-for-seeds initialized a service (temp-service reads the
          // configured default, but the explicit override is unambiguous).
          const result = await node.applySeed(seed, seedTrustPolicy ? { trustPolicy: seedTrustPolicy } : undefined);
          if (result.success) {
            console.log(`✓ Seed applied: ${result.peersAdded} peers added`);
          } else {
            console.error(`✗ Failed to apply seed: ${result.error}`);
          }
        } catch (err) {
          console.error('✗ Failed to apply seed:', err instanceof Error ? err.message : err);
        }
      }

      console.log('Cadre node running. Press Ctrl+C to stop.');

      // Keep the process alive
      await new Promise(() => {});

    } catch (error) {
      console.error('Failed to start cadre node:', error instanceof Error ? error.message : error);
      log('Error details: %o', error);
      process.exit(1);
    }
  });
