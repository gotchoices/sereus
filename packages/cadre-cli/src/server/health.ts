import http from 'node:http';
import debug from 'debug';
import { emptyConnectionPathSummary } from '@serfab/cadre-core';
import type { CadreNode, ConnectionPathSummary } from '@serfab/cadre-core';
import { checkBearer } from './bearer.js';

const log = debug('cadre:cli:health');

/** Maximum seed request body size (256 KiB) — seeds are small. Mirrors AdminServer. */
const MAX_SEED_BODY_BYTES = 256 * 1024;

export interface HealthServerOptions {
  /** Port for health check endpoint (default: 8080) */
  healthPort?: number;
  /** Port for metrics endpoint (default: 9090) */
  metricsPort?: number;
  /** Configured node profile (e.g. 'storage' or 'transaction'); surfaced in /status */
  profile?: string;
  /**
   * Bearer token that gates `POST /seed`. When empty/undefined (the default),
   * the seed route is **not registered** — requests fall through to 404, so a
   * node never exposes a remotely-mutable control surface unless an operator
   * opts in. When set, `POST /seed` requires `Authorization: Bearer <token>`.
   *
   * NOTE: this protects the *delivery path* only — it is independent from seed
   * *trust*. Whether an applied seed is honoured is anchored by the node's
   * `seedTrustPolicy` (operator-pinned via `CADRE_AUTHORITY_KEYS` /
   * `--pin-authority-key`, unioned with DB-known authority keys). A request must
   * clear BOTH layers: a valid bearer does not imply the seed's contents are
   * trusted, and a trusted seed still requires a valid bearer to be delivered.
   */
  seedToken?: string;
}

export interface HealthStatus {
  status: 'healthy' | 'unhealthy' | 'starting';
  timestamp: string;
  uptime: number;
  peerId: string | null;
  multiaddrs: string[];
  node: {
    running: boolean;
    peerId: string | null;
    partyId: string;
    profile: string;
    strands: {
      total: number;
      active: number;
      idle: number;
      hibernating: number;
    };
    /**
     * Connection-path counts (relayed vs direct, per transport, stuck-on-relay).
     * Counts only — the full `paths[]` array is omitted to keep the probe cheap.
     */
    connectionPaths: Omit<ConnectionPathSummary, 'paths'>;
  };
}

export interface MetricsData {
  // Node metrics
  cadre_node_running: number;
  cadre_node_uptime_seconds: number;

  // Strand metrics
  cadre_strands_total: number;
  cadre_strands_active: number;
  cadre_strands_idle: number;
  cadre_strands_hibernating: number;

  // Connection metrics (sourced from CadreNode.getConnectionPaths())
  /** Total connected peers; kept for back-compat with existing scrape configs (== cadre_connections_total). */
  cadre_peers_connected: number;
  cadre_connections_total: number;
  cadre_connections_relayed: number;
  cadre_connections_direct: number;
  cadre_connections_stuck_on_relay: number;
  /** One entry per transport with a non-zero count; emitted as a labelled series. */
  cadre_connections_by_transport: Record<string, number>;
}

/**
 * Health and metrics server for container orchestration.
 * Provides:
 * - /health - liveness/readiness probe
 * - /ready - readiness-only probe
 * - /status - detailed JSON status
 */
export class HealthServer {
  private node: CadreNode | null = null;
  private healthServer: http.Server | null = null;
  private metricsServer: http.Server | null = null;
  private readonly options: Required<HealthServerOptions>;
  private startTime: Date = new Date();

  constructor(options: HealthServerOptions = {}) {
    this.options = {
      healthPort: options.healthPort ?? 8080,
      metricsPort: options.metricsPort ?? 9090,
      profile: options.profile ?? '',
      seedToken: options.seedToken ?? '',
    };
  }

  /** Attach to a CadreNode instance */
  attach(node: CadreNode): void {
    this.node = node;
    log('HealthServer attached to CadreNode');
  }

  /** The actually-bound health port (useful when constructed with port 0). */
  get healthBoundPort(): number {
    const addr = this.healthServer?.address();
    if (addr && typeof addr === 'object') return addr.port;
    return this.options.healthPort;
  }

  /** Start the health and metrics servers */
  async start(): Promise<void> {
    await this.startHealthServer();
    await this.startMetricsServer();
    this.startTime = new Date();
    log('HealthServer started on ports %d (health) and %d (metrics)',
      this.options.healthPort, this.options.metricsPort);
  }

  /** Stop the servers */
  async stop(): Promise<void> {
    await Promise.all([
      this.stopServer(this.healthServer, 'health'),
      this.stopServer(this.metricsServer, 'metrics'),
    ]);
    this.healthServer = null;
    this.metricsServer = null;
    log('HealthServer stopped');
  }

  private getHealthStatus(): HealthStatus {
    const strands = this.node?.getStrands() ?? new Map();
    let active = 0, idle = 0, hibernating = 0;

    for (const strand of strands.values()) {
      if (strand.status === 'active') active++;
      else if (strand.status === 'idle') idle++;
      else if (strand.status === 'hibernating') hibernating++;
    }

    const isRunning = this.node?.isRunning ?? false;
    const peerId = this.node?.peerId?.toString() ?? null;
    const multiaddrs = this.node?.getMultiaddrs() ?? [];

    // Counts only — drop the per-connection `paths[]` array to keep /status cheap.
    const { paths: _paths, ...connectionPaths } =
      this.node?.getConnectionPaths() ?? emptyConnectionPathSummary();

    return {
      status: isRunning ? 'healthy' : 'starting',
      timestamp: new Date().toISOString(),
      uptime: (Date.now() - this.startTime.getTime()) / 1000,
      peerId,
      multiaddrs,
      node: {
        running: isRunning,
        peerId,
        partyId: this.node?.partyId ?? '',
        profile: this.options.profile,
        strands: { total: strands.size, active, idle, hibernating },
        connectionPaths,
      },
    };
  }

  private getMetrics(): MetricsData {
    const strands = this.node?.getStrands() ?? new Map();
    let active = 0, idle = 0, hibernating = 0;
    
    for (const strand of strands.values()) {
      if (strand.status === 'active') active++;
      else if (strand.status === 'idle') idle++;
      else if (strand.status === 'hibernating') hibernating++;
    }

    const paths = this.node?.getConnectionPaths() ?? emptyConnectionPathSummary();
    // Only emit labelled series for transports actually in use.
    const byTransport: Record<string, number> = {};
    for (const [transport, count] of Object.entries(paths.byTransport)) {
      if (count > 0) byTransport[transport] = count;
    }

    return {
      cadre_node_running: this.node?.isRunning ? 1 : 0,
      cadre_node_uptime_seconds: (Date.now() - this.startTime.getTime()) / 1000,
      cadre_strands_total: strands.size,
      cadre_strands_active: active,
      cadre_strands_idle: idle,
      cadre_strands_hibernating: hibernating,
      cadre_peers_connected: paths.total, // back-compat alias for cadre_connections_total
      cadre_connections_total: paths.total,
      cadre_connections_relayed: paths.relayed,
      cadre_connections_direct: paths.direct,
      cadre_connections_stuck_on_relay: paths.stuckOnRelay,
      cadre_connections_by_transport: byTransport,
    };
  }

  private formatPrometheusMetrics(data: MetricsData): string {
    const lines: string[] = [
      '# HELP cadre_node_running Whether the cadre node is running (1=yes, 0=no)',
      '# TYPE cadre_node_running gauge',
      `cadre_node_running ${data.cadre_node_running}`,
      '',
      '# HELP cadre_node_uptime_seconds Uptime of the cadre node in seconds',
      '# TYPE cadre_node_uptime_seconds counter',
      `cadre_node_uptime_seconds ${data.cadre_node_uptime_seconds.toFixed(3)}`,
      '',
      '# HELP cadre_strands_total Total number of strands',
      '# TYPE cadre_strands_total gauge',
    ];
    // Continued in next sections due to line limit
    return lines
      .concat(this.formatStrandMetrics(data))
      .concat(this.formatConnectionMetrics(data))
      .join('\n');
  }

  private formatStrandMetrics(data: MetricsData): string[] {
    return [
      `cadre_strands_total ${data.cadre_strands_total}`,
      '', '# HELP cadre_strands_active Number of active strands',
      '# TYPE cadre_strands_active gauge',
      `cadre_strands_active ${data.cadre_strands_active}`,
      '', '# HELP cadre_strands_idle Number of idle strands',
      '# TYPE cadre_strands_idle gauge',
      `cadre_strands_idle ${data.cadre_strands_idle}`,
      '', '# HELP cadre_strands_hibernating Number of hibernating strands',
      '# TYPE cadre_strands_hibernating gauge',
      `cadre_strands_hibernating ${data.cadre_strands_hibernating}`,
    ];
  }

  private formatConnectionMetrics(data: MetricsData): string[] {
    const lines = [
      '', '# HELP cadre_peers_connected Number of connected peers (alias of cadre_connections_total)',
      '# TYPE cadre_peers_connected gauge',
      `cadre_peers_connected ${data.cadre_peers_connected}`,
      '', '# HELP cadre_connections_total Total open connections',
      '# TYPE cadre_connections_total gauge',
      `cadre_connections_total ${data.cadre_connections_total}`,
      '', '# HELP cadre_connections_relayed Connections via a /p2p-circuit relay',
      '# TYPE cadre_connections_relayed gauge',
      `cadre_connections_relayed ${data.cadre_connections_relayed}`,
      '', '# HELP cadre_connections_direct Direct (non-relayed) connections',
      '# TYPE cadre_connections_direct gauge',
      `cadre_connections_direct ${data.cadre_connections_direct}`,
      '', '# HELP cadre_connections_stuck_on_relay Relayed connections past the settle window with no direct sibling',
      '# TYPE cadre_connections_stuck_on_relay gauge',
      `cadre_connections_stuck_on_relay ${data.cadre_connections_stuck_on_relay}`,
      '', '# HELP cadre_connections_by_transport Open connections by transport',
      '# TYPE cadre_connections_by_transport gauge',
    ];
    for (const [transport, count] of Object.entries(data.cadre_connections_by_transport)) {
      lines.push(`cadre_connections_by_transport{transport="${transport}"} ${count}`);
    }
    return lines;
  }

  private async startHealthServer(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.healthServer = http.createServer(async (req, res) => {
        const url = new URL(req.url ?? '/', `http://localhost`);

        try {
          if (url.pathname === '/health' || url.pathname === '/') {
            const status = this.getHealthStatus();
            const isHealthy = status.status === 'healthy';
            res.writeHead(isHealthy ? 200 : 503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: status.status }));
          } else if (url.pathname === '/ready') {
            const isReady = this.node?.isRunning ?? false;
            res.writeHead(isReady ? 200 : 503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ready: isReady }));
          } else if (url.pathname === '/status') {
            const status = this.getHealthStatus();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(status, null, 2));
          } else if (url.pathname === '/seed' && req.method === 'POST' && this.options.seedToken.length > 0) {
            // Seed delivery is registered only when a token is configured;
            // otherwise it falls through to 404 (no remotely-mutable surface).
            await this.handleSeedRequest(req, res);
          } else {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('Not Found');
          }
        } catch (error) {
          log('Health server error: %o', error);
          res.writeHead(500, { 'Content-Type': 'text/plain' });
          res.end('Internal Server Error');
        }
      });

      this.healthServer.on('error', reject);
      this.healthServer.listen(this.options.healthPort, '0.0.0.0', () => {
        log('Health server listening on port %d', this.options.healthPort);
        resolve();
      });
    });
  }

  private async handleSeedRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    // Authenticate the *delivery path* before touching the body. This gate only
    // stops anonymous peers from driving applySeed / peer-store mutation; it does
    // NOT imply the seed contents are trusted. Trust is anchored separately by
    // the node's `seedTrustPolicy` (operator-pinned authority keys unioned with
    // DB-known keys), evaluated inside the applySeed call below — so a cold node
    // with no pin rejects the seed even with a valid bearer.
    if (!checkBearer(req, this.options.seedToken)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'unauthorized' }));
      return;
    }

    if (!this.node) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'Node not attached' }));
      return;
    }

    // Read request body, bounded so an unauthenticated-sized body can't be used
    // for memory exhaustion before the JSON parse.
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of req) {
      const buf = chunk as Buffer;
      total += buf.length;
      if (total > MAX_SEED_BODY_BYTES) {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Request body too large' }));
        return;
      }
      chunks.push(buf);
    }
    const body = Buffer.concat(chunks).toString('utf8');

    try {
      const { seed } = JSON.parse(body) as { seed?: string };
      if (!seed) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'seed is required' }));
        return;
      }

      // Decode and apply the seed
      const { fromString } = await import('uint8arrays');
      const bytes = fromString(seed, 'base64url');
      const json = new TextDecoder().decode(bytes);
      const decodedSeed = JSON.parse(json);

      const result = await this.node.applySeed(decodedSeed);
      res.writeHead(result.success ? 200 : 400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (error) {
      log('Seed request error: %o', error);
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: error instanceof Error ? error.message : 'Invalid request' }));
    }
  }

  private async startMetricsServer(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.metricsServer = http.createServer((req, res) => {
        const url = new URL(req.url ?? '/', `http://localhost`);

        try {
          if (url.pathname === '/metrics' || url.pathname === '/') {
            const metrics = this.getMetrics();
            const formatted = this.formatPrometheusMetrics(metrics);
            res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end(formatted);
          } else {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('Not Found');
          }
        } catch (error) {
          log('Metrics server error: %o', error);
          res.writeHead(500, { 'Content-Type': 'text/plain' });
          res.end('Internal Server Error');
        }
      });

      this.metricsServer.on('error', reject);
      this.metricsServer.listen(this.options.metricsPort, '0.0.0.0', () => {
        log('Metrics server listening on port %d', this.options.metricsPort);
        resolve();
      });
    });
  }

  private async stopServer(server: http.Server | null, name: string): Promise<void> {
    if (!server) return;
    return new Promise((resolve) => {
      server.close(() => {
        log('%s server stopped', name);
        resolve();
      });
    });
  }
}

