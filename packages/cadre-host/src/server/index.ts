/**
 * Public surface for the cadre-host local UI server.
 *
 * `createLocalUiServer(opts)` wires:
 *   - the origin guard + error handler
 *   - existing trust-circle / NAT / update typed handlers, mounted at
 *     `/auth/*`, `/nat/*`, `/update/*` (the CLI contract)
 *   - new UI-only routes under `/api/*` (status, nodes, settings, events)
 *   - the static SPA mount at `/`
 *
 * Callers (cadre-host start) own the subsystems and pass them in. The
 * server doesn't construct them — start has to own their lifecycle anyway
 * (orchestrator init, trust-circle/NAT bring-up, update timer).
 */

import type { FastifyInstance } from 'fastify';

import type { HostProcessOrchestrator } from '../orchestrator/index.js';
import type { TrustCircleService } from '../auth/index.js';
import { createTrustCircleHandlers } from '../auth/index.js';
import type { NatService } from '../nat/index.js';
import { createNatHandlers } from '../nat/index.js';
import type { UpdateService } from '../update/index.js';
import { createUpdateHandlers } from '../update/index.js';
import type { GrantService } from '../donation/index.js';
import { createGrantAdminHandlers } from '../donation/index.js';

import { EventBus } from './events/bus.js';
import { registerSseRoute } from './events/sse-route.js';
import { registerErrorHandler } from './error-handler.js';
import { registerOriginGuard } from './origin-guard.js';
import { registerStaticMount } from './static.js';
import { buildFastify, startListening, stopListening } from './server.js';
import { registerNatRoutes } from './routes/nat.js';
import { registerTrustCircleRoutes } from './routes/trust-circle.js';
import { registerUpdateRoutes } from './routes/update.js';
import { registerStatusRoute } from './routes/status.js';
import { registerNodesRoutes } from './routes/nodes.js';
import { registerSettingsRoutes } from './routes/settings.js';
import { registerGrantsAdminRoutes } from './routes/grants-admin.js';
import { HostSettingsStore } from './settings-store.js';

export interface LocalUiServerOptions {
  /** Configured UI port from host.config.json. May be re-bound on collision. */
  uiPort: number;
  /** Resolved data dir (passed by cadre-host start). */
  dataDir: string;
  /** Wired dependencies — all owned by the caller. */
  orchestrator: HostProcessOrchestrator;
  /**
   * Trust-circle service — present only when the host runs its own personal
   * cadre (`ownCadre.enabled`). Absent in donor-only mode, where `/auth/*`
   * stays unmounted and 404s.
   */
  trustCircle?: TrustCircleService;
  /**
   * NAT service — present only when the host runs its own personal cadre.
   * Absent in donor-only mode (loopback-only in v1), where `/nat/*` stays
   * unmounted and 404s.
   */
  nat?: NatService;
  /** Optional — 6.4.2 lands this; nullable while still iterating. */
  update?: UpdateService;
  /**
   * Donation grant layer. When present, mounts the loopback admin surface at
   * `/grants-admin` (issue/list/revoke). Optional so existing callers/tests
   * that don't exercise donations need not wire it.
   */
  grants?: GrantService;
  /** Settings I/O facade. Defaults to a new one rooted at `dataDir`. */
  settingsStore?: HostSettingsStore;
  /** Bus instance — pass the same one to subsystems that publish events. */
  events?: EventBus;
  /**
   * Static asset root override. Defaults to `<package>/dist/ui`. When the
   * directory is absent the root handler returns a placeholder HTML.
   */
  staticRoot?: string;
  /**
   * Test-only: bind to port 0 (OS picks any free port). The returned URL
   * reflects the actual bound port.
   */
  forcePort?: 0;
  /**
   * SSE heartbeat interval (ms). Defaults to 15 000 ms. Tests reduce this
   * so the heartbeat can be observed quickly.
   */
  sseHeartbeatMs?: number;
}

export interface LocalUiServer {
  app: FastifyInstance;
  events: EventBus;
  /** Resolves with the actually-bound port. */
  start(): Promise<{ port: number; url: string }>;
  stop(): Promise<void>;
}

/** How often to poll UpdateService.getState() looking for new versions. */
const UPDATE_OBSERVER_INTERVAL_MS = 60_000;

export function createLocalUiServer(opts: LocalUiServerOptions): LocalUiServer {
  const events = opts.events ?? new EventBus();
  const settingsStore = opts.settingsStore ?? new HostSettingsStore({ dataDir: opts.dataDir });

  const app = buildFastify();

  // Bound port is unknown until start(); the guard is registered then.

  registerErrorHandler(app);

  // /api/events (SSE) — must be registered before the static fallback so
  // the not-found handler doesn't try to serve it.
  registerSseRoute(app, {
    events,
    ...(opts.sseHeartbeatMs !== undefined ? { heartbeatIntervalMs: opts.sseHeartbeatMs } : {}),
  });

  registerStatusRoute(app, {
    orchestrator: opts.orchestrator,
    ...(opts.trustCircle ? { trustCircle: opts.trustCircle } : {}),
    ...(opts.nat ? { nat: opts.nat } : {}),
    ...(opts.update ? { update: opts.update } : {}),
  });
  registerNodesRoutes(app, { orchestrator: opts.orchestrator });
  registerSettingsRoutes(app, { settingsStore, ...(opts.nat ? { nat: opts.nat } : {}), ...(opts.update ? { update: opts.update } : {}) });

  // Trust-circle + NAT surfaces exist only when the host runs its own personal
  // cadre. In donor-only mode they're left unmounted, so `/auth/*` and `/nat/*`
  // fall through to the static not-found handler and 404 (see static.ts).
  if (opts.trustCircle) {
    registerTrustCircleRoutes(app, { handlers: createTrustCircleHandlers(opts.trustCircle), events });
  }
  if (opts.nat) {
    registerNatRoutes(app, { handlers: createNatHandlers(opts.nat), events });
  }
  if (opts.update) {
    registerUpdateRoutes(app, { handlers: createUpdateHandlers(opts.update), events });
  }
  if (opts.grants) {
    registerGrantsAdminRoutes(app, { handlers: createGrantAdminHandlers(opts.grants) });
  }

  // Static mount registers as the not-found handler — declared last so the
  // API paths above win.
  registerStaticMount(app, { ...(opts.staticRoot !== undefined ? { rootDir: opts.staticRoot } : {}) });

  let bound: { port: number; url: string } | null = null;
  let stopped = false;
  const teardown: Array<() => void> = [];

  return {
    app,
    events,
    async start() {
      if (bound) return bound;
      // Origin guard reads the port at request time via the getter so the
      // post-fallback bound port is honoured. Registered here (not at
      // factory time) so it lives in the same lifecycle as listen.
      registerOriginGuard(app, { port: () => bound?.port ?? opts.uiPort });
      const started = await startListening(app, {
        preferredPort: opts.uiPort,
        ...(opts.forcePort === 0 ? { forcePort: 0 as const } : {}),
      });
      bound = started;

      // Orchestrator → bus adapter: forward node state changes.
      teardown.push(
        opts.orchestrator.onStateChange((info) => {
          events.publish({
            type: 'node-state-changed',
            nodeId: info.id,
            status: info.status === 'running' ? 'running' : 'stopped',
          });
        }),
      );

      // One-shot connectivity publish — the SPA will get a sane initial
      // signal even if no settings have changed yet this session. Skipped in
      // donor-only mode, where there is no NatService.
      if (opts.nat) {
        try {
          const snap = opts.nat.getStatus();
          events.publish({
            type: 'connectivity-changed',
            portMode: snap.portMode,
            directReachability: snap.directReachability,
          });
        } catch {
          // NatService.start may not have completed; harmless to skip.
        }
      }

      // Update observer: poll UpdateService.getState() every 60 s and emit
      // `update-available` when `available.version` changes. Cheap, avoids
      // poking at the service's internals.
      if (opts.update) {
        const update = opts.update;
        let lastVersion: string | undefined;
        const tick = async (): Promise<void> => {
          try {
            const state = await update.getState();
            const available = state.available;
            if (available && available.version && available.version !== lastVersion) {
              lastVersion = available.version;
              events.publish({
                type: 'update-available',
                version: available.version,
                ...(available.releaseNotesUrl ? { releaseNotesUrl: available.releaseNotesUrl } : {}),
              });
            }
          } catch {
            // Update store I/O failure — silent, will retry next tick.
          }
        };
        // Fire once on boot in case the timer set `available` before the server bound.
        void tick();
        const timer = setInterval(() => { void tick(); }, UPDATE_OBSERVER_INTERVAL_MS);
        if (typeof timer === 'object' && 'unref' in timer) {
          (timer as { unref?: () => void }).unref?.();
        }
        teardown.push(() => clearInterval(timer));
      }

      return started;
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      for (const fn of teardown.splice(0, teardown.length)) {
        try { fn(); } catch { /* ignore teardown errors */ }
      }
      await stopListening(app);
    },
  };
}

export { EventBus } from './events/bus.js';
export type { LocalUiEventListener } from './events/bus.js';
export type { LocalUiEvent, LocalUiEventType } from './events/types.js';
export { HostSettingsStore } from './settings-store.js';
