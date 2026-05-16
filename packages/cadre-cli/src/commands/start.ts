import { writeFileSync } from 'node:fs';
import { Command } from 'commander';
import debug from 'debug';
import { CadreNode, type CadreNodeConfig, type ControlNetworkSeed, type StorageConfig } from '@serfab/cadre-core';
import { MemoryRawStorage } from '@optimystic/db-p2p';
import { FileRawStorage } from '@optimystic/db-p2p-storage-fs';
import { resolveConfig, type ResolvedConfig } from '../config/index.js';
import { HealthServer } from '../server/health.js';

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
  const { fromString } = require('uint8arrays');
  const bytes = fromString(encoded, 'base64url');
  const json = new TextDecoder().decode(bytes);
  return JSON.parse(json) as ControlNetworkSeed;
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
  .action(async (options) => {
    if (options.debug) {
      debug.enable('cadre:*,sereus:*');
    }

    console.log('Starting cadre node...');
    log('Loading configuration from: %s', options.config);

    try {
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

      const nodeConfig: CadreNodeConfig = {
        privateKey: config.privateKey,
        controlNetwork: config.controlNetwork,
        profile: config.profile,
        strandFilter: config.strandFilter,
        storage: resolveStorageConfig(config.storage),
        network: config.network,
        hibernation: config.hibernation,
        strandWatchInterval: config.strandWatchInterval,
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

        healthServer = new HealthServer({ healthPort, metricsPort });
        healthServer.attach(node);
        await healthServer.start();
        console.log(`✓ Health server on port ${healthPort}, metrics on port ${metricsPort}`);
      }

      // Handle graceful shutdown
      const shutdown = async () => {
        console.log('\nShutting down...');
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
          const result = await node.applySeed(seed);
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

