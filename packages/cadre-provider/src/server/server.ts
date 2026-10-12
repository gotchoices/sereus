/**
 * Fastify server setup for cadre-provider.
 */

import Fastify, { type FastifyInstance } from 'fastify';
import fastifyCors from '@fastify/cors';
import fastifyFormbody from '@fastify/formbody';
import debug from 'debug';
import type { ProviderConfig } from '../config/types.js';
import { createStore, type ProviderStore } from '../service/store.js';
import { ContainerService } from '../service/container-service.js';
import { BillingService, type BillingHooks } from '../service/billing-service.js';
import { DockerOrchestrator } from '../service/docker-orchestrator.js';
import { MockOrchestrator, type Orchestrator } from '../service/orchestrator.js';
import { registerRoutes } from './routes.js';
import { registerAuth, type AuthHooks } from './auth.js';
import { registerOAuthRoutes } from './oauth.js';
import { registerDescriptorRoute } from './descriptor.js';

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

  // The OAuth token endpoint takes form-encoded bodies (RFC 6749 §4.1.3) as well as JSON,
  // and the dev consent page posts a form. Registered once, for the whole app.
  await app.register(fastifyFormbody);

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
  const containerService = new ContainerService({
    store,
    orchestrator,
    ...(config.push ? { push: config.push } : {}),
    // The host a node code's addresses must carry: a phone dials a container only there.
    ...(config.docker.publicHost !== undefined ? { publicHost: config.docker.publicHost } : {}),
  });
  const billingService = new BillingService({
    config: config.billing,
    store,
    orchestrator,
    hooks: billingHooks,
    readStatus: container => containerService.readStatus(container),
  });

  const basePath = config.server.basePath ?? '/api/v1';

  // Register auth middleware
  registerAuth(app, {
    config: config.auth,
    store,
    hooks: authHooks,
    basePath,
  });

  let shuttingDown = false;

  const runShutdownSequence = async (reason: string): Promise<void> => {
    try {
      console.log(`Cadre Provider shutting down: ${reason}`);
      billingService.stop();
      containerService.stopReaper();

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
    // A container can be dialed only at the public host it announces.
    bootstrapNodesOptional: config.docker.publicHost !== undefined,
  });

  // The built-in sign-in endpoints, when the provider runs its own (`auth.oauth`), and the
  // descriptor an app's store screen reads (404 until a `provider` block names this provider).
  if (config.auth.mode === 'oauth' && config.auth.oauth) {
    registerOAuthRoutes(app, { basePath, oauth: config.auth.oauth, store, billingService, hooks: authHooks });
  }
  registerDescriptorRoute(app, { basePath, config });

  log('Server configured at %s', basePath);

  // Server lifecycle
  const start = async () => {
    // Start billing service
    billingService.start();

    // Reap container records this provider abandoned mid-flight (a crash between
    // writing the record and finishing the orchestrator call, or an `enrolling`
    // record whose in-process waiter died with the last process). Sweeps once
    // immediately, so records recovered from disk are handled at startup.
    containerService.startReaper();

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
    containerService.stopReaper();
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
