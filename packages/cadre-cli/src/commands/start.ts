import { writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { Command } from 'commander';
import debug from 'debug';
import {
  CadreNode,
  ed25519KeyPairFromLibp2p,
  pinnedKeyTrustPolicy,
  type CadreNodeConfig,
  type ControlNetworkSeed,
  type SeedTrustPolicy,
  type StorageConfig,
} from '@serfab/cadre-core';
import { createPushNotifier } from '@serfab/cadre-core/push-node';
import { FileTrustedOwnerStore } from '@serfab/cadre-core/trusted-owner-store-file';
import { FileBootstrapPeerStore } from '@serfab/cadre-core/bootstrap-peer-store-file';
import { MemoryRawStorage } from '@optimystic/db-p2p';
import { FileRawStorage } from '@optimystic/db-p2p-storage-fs';
import { fromString } from 'uint8arrays';
import { resolveConfig, type ResolvedConfig } from '../config/index.js';
import { HealthServer } from '../server/health.js';
import { AdminServer } from '../server/admin-server.js';

const log = debug('cadre:cli:start');

/**
 * Convert CLI storage config to cadre-core StorageConfig with provider
 */
function resolveStorageConfig(config: ResolvedConfig['storage']): StorageConfig | undefined {
  if (!config) return undefined;

  if (config.type === 'memory') {
    return {
      provider: () => new MemoryRawStorage(),
      quotaBytes: config.quotaBytes,
    };
  }

  if (config.type === 'file') {
    if (!config.path) {
      throw new Error('Storage path is required for file storage type');
    }
    return {
      provider: (strandId: string) => new FileRawStorage(`${config.path}/${strandId}`),
      quotaBytes: config.quotaBytes,
    };
  }

  return undefined;
}

/**
 * Decode a base64url-encoded seed
 */
function decodeSeed(encoded: string): ControlNetworkSeed {
  const bytes = fromString(encoded, 'base64url');
  const json = new TextDecoder().decode(bytes);
  return JSON.parse(json) as ControlNetworkSeed;
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
 * Keys are NOT validated here: a malformed (non-base64url / wrong-length) pin
 * simply never matches a real `signerKey`, so the seed is rejected by the trust
 * policy with its reason rather than silently accepted.
 */
export function collectPinnedOwnerKeys(
  flagKeys: string[] | undefined,
  env: string | undefined,
): string[] {
  const fromEnv = (env ?? '').split(',');
  return [...new Set([...(flagKeys ?? []), ...fromEnv].map(k => k.trim()).filter(k => k.length > 0))];
}

export const startCommand = new Command('start')
  .description('Start the cadre node with the specified configuration')
  .option('-c, --config <path>', 'Path to config file (YAML or JSON)', 'cadre.yaml')
  .option('-d, --debug', 'Enable debug logging')
  .option('--health-port <port>', 'Health check server port', '8080')
  .option('--metrics-port <port>', 'Prometheus metrics server port', '9090')
  .option('--no-health-server', 'Disable health check and metrics servers')
  .option('--seed <encoded>', 'Apply a base64url-encoded seed on startup')
  .option('--listen-for-seeds', 'Enable the seed protocol listener for receiving seeds')
  .option('--ws-port <port>', 'WebSocket listen port (convenience: appends /ip4/0.0.0.0/tcp/<port>/ws to listen addresses)')
  .option('--startup-token-file <path>', 'After successful node.start(), write $CADRE_STARTUP_TOKEN to this file. Used by external orchestrators to verify the spawned child is the one they expected (vs a recycled PID).')
  .option('--identity-protobuf <path>', 'Load the node identity from a libp2p protobuf private key file (e.g. cadre-host\'s identity.key). Takes precedence over config identity.')
  .option('--owner', 'Run as the owner of this node\'s OWN cadre: initialize seed-bootstrap from the node identity and perform the idempotent genesis OwnerKey insert on a fresh party. This is the founder persona (e.g. cadre-host with ownCadre enabled running its operator\'s personal cadre) — NOT a node donated to a requester. Donated nodes are generic and pin the requester\'s owner key via --pin-owner-key instead.')
  .option('--admin-port <port>', 'Bind the loopback admin channel (127.0.0.1) on this port. Requires CADRE_STARTUP_TOKEN in env.')
  .option('--pin-owner-key <b64url>', 'Pin a base64url owner key as a cold-start seed-trust anchor (repeatable; unions with CADRE_OWNER_KEYS). Required for a cold node to accept --seed / POST /seed.', collectPinKey, [])
  .action(async (options) => {
    if (options.debug) {
      debug.enable('cadre:*,sereus:*');
    }

    console.log('Starting cadre node...');
    log('Loading configuration from: %s', options.config);

    try {
      // A --identity-protobuf flag overrides config identity. Route it through
      // the env mapping (CADRE_IDENTITY_PROTOBUF -> identity.protobufKeyFile)
      // so the loader resolves it the same way as the config-file path.
      if (options.identityProtobuf) {
        process.env.CADRE_IDENTITY_PROTOBUF = options.identityProtobuf;
      }

      const config = await resolveConfig(options.config);

      // --ws-port convenience: append a WebSocket listen address
      if (options.wsPort) {
        const wsPort = parseInt(options.wsPort, 10);
        if (isNaN(wsPort) || wsPort < 1 || wsPort > 65535) {
          throw new Error(`Invalid WebSocket port: ${options.wsPort}`);
        }
        const wsAddr = `/ip4/0.0.0.0/tcp/${wsPort}/ws`;
        if (!config.network) config.network = {};
        if (!config.network.listenAddrs) config.network.listenAddrs = [];
        if (!config.network.listenAddrs.includes(wsAddr)) {
          config.network.listenAddrs.push(wsAddr);
          log('Added WebSocket listen address: %s', wsAddr);
        }
      }

      // Operator-pinned owner keys anchor cold-start seed trust. Build the
      // policy BEFORE constructing CadreNode so every later service-construction
      // site (seed listener, temp-service for applySeed / POST /seed) captures
      // it as the node-wide default — it is read at construction time.
      const pinnedKeys = collectPinnedOwnerKeys(options.pinOwnerKey, process.env.CADRE_OWNER_KEYS);
      const seedTrustPolicy: SeedTrustPolicy | undefined =
        pinnedKeys.length > 0 ? pinnedKeyTrustPolicy(pinnedKeys) : undefined;
      if (pinnedKeys.length > 0) {
        console.log(`✓ Pinned ${pinnedKeys.length} owner key(s) for cold-start seed trust`);
      }

      // Node-local trusted-owner anchor: file-backed next to the protobuf
      // identity key when one is configured (so anchored trust survives
      // restarts), else CadreNode falls back to an in-memory store. The
      // operator pins above seed it either way (source 'operator').
      const trustedOwnerStore = config.identityProtobufKeyFile
        ? await FileTrustedOwnerStore.open(
            dirname(config.identityProtobufKeyFile),
            config.controlNetwork.partyId,
          )
        : undefined;

      // Cold-start bootstrap dial targets: file-backed in the same directory, so a
      // seed pushed at RUNTIME (the /sereus/seed/1.0.0 protocol, or cadre-host's
      // donation flow pushing to POST /seed — neither of which gets a --seed
      // argument on the next start) still has addresses to retry after a process
      // or container restart.
      const bootstrapPeerStore = config.identityProtobufKeyFile
        ? await FileBootstrapPeerStore.open(
            dirname(config.identityProtobufKeyFile),
            config.controlNetwork.partyId,
          )
        : undefined;

      const nodeConfig: CadreNodeConfig = {
        privateKey: config.privateKey,
        trustedOwners: {
          ...(trustedOwnerStore ? { store: trustedOwnerStore } : {}),
          pinnedKeys,
          pinnedSource: 'operator',
        },
        ...(bootstrapPeerStore ? { bootstrapPeers: { store: bootstrapPeerStore } } : {}),
        controlNetwork: config.controlNetwork,
        profile: config.profile,
        strandFilter: config.strandFilter,
        storage: resolveStorageConfig(config.storage),
        network: config.network,
        hibernation: config.hibernation,
        strandWatchInterval: config.strandWatchInterval,
        seedTrustPolicy,
        // Platform push credentials provisioned by the orchestrator (cadre-host
        // writes the `push` block into cadre.json; cadre-provider injects it via
        // CADRE_PUSH). This CLI is the Node host, so it constructs the
        // `PushNotifier` from the Node-only `@serfab/cadre-core/push-node`
        // subpath (keeping node:crypto/node:http2 out of the cross-platform core
        // graph) and injects the instance; CadreNode owns its lifecycle.
        push: config.push
          ? {
              notifier: createPushNotifier(config.push),
              cooldownMs: config.push.cooldownMs,
              debounceMs: config.push.debounceMs,
            }
          : undefined,
      };

      const node = new CadreNode(nodeConfig);

      // Set up event handlers
      node.on('control:connected', () => {
        console.log('✓ Connected to control network');
        console.log(`  Party ID: ${config.controlNetwork.partyId}`);
        console.log(`  Peer ID:  ${node.peerId?.toString()}`);
      });

      node.on('control:disconnected', () => {
        console.log('✗ Disconnected from control network');
      });

      node.on('strand:started', ({ strandId }) => {
        console.log(`✓ Strand started: ${strandId}`);
      });

      node.on('strand:stopped', ({ strandId }) => {
        console.log(`• Strand stopped: ${strandId}`);
      });

      node.on('strand:error', ({ strandId, error }) => {
        console.error(`✗ Strand error (${strandId}): ${error.message}`);
      });

      node.on('strand:idle', ({ strandId }) => {
        log('Strand idle: %s', strandId);
      });

      node.on('strand:hibernating', ({ strandId }) => {
        log('Strand hibernating: %s', strandId);
      });

      // Set up seed event handlers
      node.on('seed:received', ({ partyId, peerId }) => {
        console.log(`✓ Seed received from ${peerId} for party ${partyId}`);
      });

      node.on('seed:applied', ({ partyId, peersAdded }) => {
        console.log(`✓ Seed applied: ${peersAdded} peers added for party ${partyId}`);
      });

      node.on('seed:error', ({ partyId, error }) => {
        console.error(`✗ Seed error (${partyId}): ${error}`);
      });

      // Start health/metrics servers if enabled
      let healthServer: HealthServer | null = null;
      if (options.healthServer !== false) {
        const healthPort = parseInt(process.env.CADRE_HEALTH_PORT ?? options.healthPort, 10);
        const metricsPort = parseInt(process.env.CADRE_METRICS_PORT ?? options.metricsPort, 10);

        // POST /seed is registered only when CADRE_SEED_TOKEN is set; otherwise
        // the health port serves read-only liveness/readiness probes. Keep this
        // distinct from CADRE_STARTUP_TOKEN (PID-verify / admin-channel bearer).
        const seedToken = process.env.CADRE_SEED_TOKEN ?? '';

        healthServer = new HealthServer({ healthPort, metricsPort, profile: config.profile, seedToken });
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

      // Start the node
      await node.start();

      // Write startup-token file once the node is healthy. External orchestrators
      // (e.g. cadre-host's HostProcessOrchestrator) use this to confirm the
      // running PID is the child they spawned and not a recycled one.
      if (options.startupTokenFile) {
        const token = process.env.CADRE_STARTUP_TOKEN ?? '';
        if (token.length > 0) {
          writeFileSync(options.startupTokenFile, token, { encoding: 'utf8' });
          log('Wrote startup token to %s', options.startupTokenFile);
        }
      }

      // Owner init: bridge the libp2p identity into a base64url owner
      // keypair, run the idempotent genesis insert on a fresh party, then bring
      // up seed-bootstrap so this node can mint invites and authorize peers.
      if (options.owner) {
        if (!config.privateKey) {
          throw new Error('--owner requires a node identity (set identity.protobufKeyFile, --identity-protobuf, or identity.keyFile)');
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

        node.initializeSeedBootstrap(privateKeyB64);
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
          skipped: '• Owner self-registration skipped (no self-signing key available)',
        };
        console.log(selfRegMessage[selfReg]);
      }

      // Bind the loopback admin channel if requested. The startup token doubles
      // as the bearer secret, so refuse to expose the surface without it.
      const adminPortRaw = process.env.CADRE_ADMIN_PORT ?? options.adminPort;
      if (adminPortRaw) {
        const adminPort = parseInt(adminPortRaw, 10);
        if (isNaN(adminPort) || adminPort < 0 || adminPort > 65535) {
          throw new Error(`Invalid admin port: ${adminPortRaw}`);
        }
        const token = process.env.CADRE_STARTUP_TOKEN ?? '';
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
        node.enableSeedListener();
        console.log('✓ Seed protocol listener enabled');
      }

      // Apply seed if provided
      if (options.seed) {
        try {
          const seed = decodeSeed(options.seed);
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
          console.error('✗ Failed to decode/apply seed:', err instanceof Error ? err.message : err);
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

