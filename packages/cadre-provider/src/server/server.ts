/**
 * Fastify server setup for cadre-provider.
 */

import Fastify, { type FastifyInstance } from 'fastify';
import fastifyCors from '@fastify/cors';
import debug from 'debug';
import type { ProviderConfig } from '../config/types.js';
import { createStore, type ProviderStore } from '../service/store.js';
import { ContainerService } from '../service/container-service.js';
import { BillingService, type BillingHooks } from '../service/billing-service.js';
import { DockerOrchestrator } from '../service/docker-orchestrator.js';
import { MockOrchestrator, type Orchestrator } from '../service/orchestrator.js';
import { registerRoutes } from './routes.js';
import { registerAuth, type AuthHooks } from './auth.js';

const log = debug('cadre:provider:server');

/** Hard cap on Fastify's drain phase during shutdown */
const SHUTDOWN_DRAIN_TIMEOUT_MS = 5000;

/** Provider server options */
export interface ProviderServerOptions {
  /** Full configuration */
  config: ProviderConfig;
  /** Custom authentication hooks */
  authHooks?: AuthHooks;
  /** Custom billing hooks */
  billingHooks?: BillingHooks;
  /** Custom orchestrator (for testing) */
  orchestrator?: Orchestrator;
  /** Custom store (for testing) */
  store?: ProviderStore;
  /**
   * Process-exit function called at the end of the shutdown sequence.
   * Defaults to `process.exit`; tests inject a spy to avoid killing the runner.
   */
  exitFn?: (code: number) => void;
}

/** Provider server instance */
export interface ProviderServer {
  /** The Fastify instance */
  app: FastifyInstance;
  /** Container service */
  containerService: ContainerService;
  /** Billing service */
  billingService: BillingService;
  /** Start the server */
  start(): Promise<void>;
  /** Stop the server */
  stop(): Promise<void>;
  /**
   * Request a graceful shutdown of the entire process.
   *
   * Idempotent — repeated calls are no-ops. The sequence runs asynchronously
   * (via `setImmediate`) so the caller can return its current response before
   * the server starts draining. Errors during shutdown are logged then
   * `exitFn(1)` is invoked; the success path calls `exitFn(0)`.
   */
  requestShutdown(reason: string): void;
}

/** Create a provider server */
export async function createProviderServer(
  options: ProviderServerOptions
): Promise<ProviderServer> {
  const { config, authHooks, billingHooks } = options;
  const exitFn = options.exitFn ?? process.exit.bind(process);

  log('Creating provider server');

  // Create Fastify instance
  const app = Fastify({
    logger: config.logging.level === 'debug',
  });

  // Register CORS
  await app.register(fastifyCors, {
    origin: config.server.cors?.origin ?? true,
    credentials: config.server.cors?.credentials ?? true,
  });

  // Create store
  const store = options.store ?? createStore(config.storage);

  // Create orchestrator
  let orchestrator: Orchestrator;
  if (options.orchestrator) {
    orchestrator = options.orchestrator;
  } else if (config.docker.socketPath) {
    try {
      orchestrator = new DockerOrchestrator(config.docker);
    } catch (err) {
      log('Docker unavailable, using mock orchestrator: %O', err);
      orchestrator = new MockOrchestrator();
    }
  } else {
    orchestrator = new MockOrchestrator();
  }

  // Create services
  const containerService = new ContainerService({ store, orchestrator });
  const billingService = new BillingService({
    config: config.billing,
    store,
    orchestrator,
    hooks: billingHooks,
  });

  // Register auth middleware
  registerAuth(app, {
    config: config.auth,
    store,
    hooks: authHooks,
  });

  const basePath = config.server.basePath ?? '/api/v1';

  let shuttingDown = false;

  const runShutdownSequence = async (reason: string): Promise<void> => {
    try {
      console.log(`Cadre Provider shutting down: ${reason}`);
      billingService.stop();

      let timer: ReturnType<typeof setTimeout> | undefined;
      const drain = app.close();
      const timeout = new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), SHUTDOWN_DRAIN_TIMEOUT_MS);
      });
      const outcome = await Promise.race([drain.then(() => 'drained' as const), timeout]);
      if (timer) clearTimeout(timer);
      if (outcome === 'timeout') {
        log('Shutdown drain timeout after %dms', SHUTDOWN_DRAIN_TIMEOUT_MS);
      }

      log('Shutdown complete');
      exitFn(0);
    } catch (err) {
      log('Shutdown error: %O', err);
      console.error('Provider shutdown error:', err instanceof Error ? err.message : err);
      exitFn(1);
    }
  };

  const requestShutdown = (reason: string): void => {
    if (shuttingDown) {
      log('requestShutdown ignored (already shutting down): %s', reason);
      return;
    }
    shuttingDown = true;
    log('requestShutdown triggered: %s', reason);

    setImmediate(() => {
      void runShutdownSequence(reason);
    });
  };

  // Register routes
  registerRoutes(app, {
    basePath,
    containerService,
    billingService,
    requestShutdown,
  });

  log('Server configured at %s', basePath);

  // Server lifecycle
  const start = async () => {
    // Start billing service
    billingService.start();

    // Start HTTP server
    const address = await app.listen({
      host: config.server.host ?? '0.0.0.0',
      port: config.server.port ?? 3000,
    });

    log('Server listening at %s', address);
    console.log(`Cadre Provider API listening at ${address}${basePath}`);
  };

  const stop = async () => {
    log('Stopping server');
    billingService.stop();
    await app.close();
    log('Server stopped');
  };

  return {
    app,
    containerService,
    billingService,
    start,
    stop,
    requestShutdown,
  };
}
