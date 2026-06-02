/**
 * Docker-based orchestrator implementation.
 */

import Docker from 'dockerode';
import debug from 'debug';
import type { DockerConfig } from '../config/types.js';
import type {
  Orchestrator,
  OrchestratorCreateRequest,
  OrchestratorCreateResult,
  OrchestratorStats,
} from './orchestrator.js';

const log = debug('cadre:provider:docker');

/** Port allocation tracker */
class PortAllocator {
  private usedPorts = new Set<number>();

  constructor(
    private readonly start: number,
    private readonly end: number
  ) {}

  allocate(): number {
    for (let port = this.start; port <= this.end; port++) {
      if (!this.usedPorts.has(port)) {
        this.usedPorts.add(port);
        return port;
      }
    }
    throw new Error('No available ports in range');
  }

  release(port: number): void {
    this.usedPorts.delete(port);
  }
}

/**
 * Docker orchestrator using dockerode.
 */
export class DockerOrchestrator implements Orchestrator {
  private readonly docker: Docker;
  private readonly config: DockerConfig;
  private readonly portAllocator: PortAllocator;
  private readonly containerPorts = new Map<string, { health: number; metrics: number; p2p: number }>();

  constructor(config: DockerConfig, docker?: Docker) {
    this.config = config;
    this.docker = docker ?? new Docker({ socketPath: config.socketPath });
    this.portAllocator = new PortAllocator(
      config.portRange?.start ?? 10000,
      config.portRange?.end ?? 20000
    );
    log('DockerOrchestrator initialized with socket: %s', config.socketPath);
  }

  /** Allocate `count` ports atomically; release any already taken if one fails. */
  private allocatePorts(count: number): number[] {
    const ports: number[] = [];
    try {
      for (let i = 0; i < count; i++) ports.push(this.portAllocator.allocate());
      return ports;
    } catch (err) {
      for (const p of ports) this.portAllocator.release(p);
      throw err;
    }
  }

  /** Release a set of ports (used by both the failure path and removeContainer). */
  private releasePorts(ports: { health: number; metrics: number; p2p: number }): void {
    this.portAllocator.release(ports.health);
    this.portAllocator.release(ports.metrics);
    this.portAllocator.release(ports.p2p);
  }

  async createContainer(request: OrchestratorCreateRequest): Promise<OrchestratorCreateResult> {
    log('Creating container for %s', request.containerId);

    // Pull image if needed
    if (this.config.pullPolicy === 'always') {
      await this.pullImage();
    }

    // Allocate ports atomically (releases partial allocations on failure).
    const [healthPort, metricsPort, p2pPort] = this.allocatePorts(3) as [number, number, number];

    const resources = request.resources ?? this.config.defaultResources ?? {};

    // Anything that throws between allocation and the successful record below
    // must release the ports and best-effort remove a partially-created
    // container — otherwise the bounded host-port range leaks permanently.
    let container: Docker.Container | undefined;
    try {
      // Create container
      container = await this.docker.createContainer({
        name: `cadre-${request.containerId}`,
        Image: this.config.image,
        Env: [
          `CADRE_PARTY_ID=${request.partyId}`,
          `CADRE_BOOTSTRAP_NODES=${request.bootstrapNodes.join(',')}`,
          `CADRE_PROFILE=${request.profile}`,
          `CADRE_HEALTH_PORT=8080`,
          `CADRE_METRICS_PORT=9090`,
          `CADRE_LISTEN_ADDRS=/ip4/0.0.0.0/tcp/4001`,
          request.strandFilter ? `CADRE_STRAND_FILTER=${request.strandFilter}` : '',
          resources.storageQuotaBytes ? `CADRE_STORAGE_QUOTA=${resources.storageQuotaBytes}` : '',
        ].filter(Boolean),
        HostConfig: {
          PortBindings: {
            '8080/tcp': [{ HostPort: String(healthPort) }],
            '9090/tcp': [{ HostPort: String(metricsPort) }],
            '4001/tcp': [{ HostPort: String(p2pPort) }],
          },
          Memory: this.parseMemoryLimit(resources.memoryLimit),
          NanoCpus: this.parseCpuLimit(resources.cpuLimit),
          NetworkMode: this.config.network,
          RestartPolicy: { Name: 'unless-stopped' },
        },
        Labels: {
          'sereus.container-id': request.containerId,
          'sereus.party-id': request.partyId,
          'sereus.profile': request.profile,
        },
      });

      // Start container
      await container.start();
    } catch (err) {
      this.releasePorts({ health: healthPort, metrics: metricsPort, p2p: p2pPort });
      if (container) {
        // Free the reserved name + labels left by a created-but-unstarted container.
        try {
          await container.remove({ force: true });
        } catch (rmErr) {
          log('Cleanup of partial container failed: %O', rmErr);
        }
      }
      throw err;
    }

    const dockerId = container.id;
    this.containerPorts.set(dockerId, { health: healthPort, metrics: metricsPort, p2p: p2pPort });

    log('Container %s started as %s', request.containerId, dockerId);

    return {
      dockerId,
      healthEndpoint: `http://localhost:${healthPort}/health`,
      metricsEndpoint: `http://localhost:${metricsPort}/metrics`,
      // The node's seed API (`POST /seed`) is bound to the same server/port as `/health`.
      seedEndpoint: `http://localhost:${healthPort}/seed`,
      p2pPort,
    };
  }

  async stopContainer(dockerId: string): Promise<void> {
    log('Stopping container %s', dockerId);
    const container = this.docker.getContainer(dockerId);
    await container.stop({ t: 10 });
  }

  async removeContainer(dockerId: string): Promise<void> {
    log('Removing container %s', dockerId);
    const container = this.docker.getContainer(dockerId);
    await container.remove({ force: true });

    // Release ports
    const ports = this.containerPorts.get(dockerId);
    if (ports) {
      this.releasePorts(ports);
      this.containerPorts.delete(dockerId);
    }
  }

  async getStats(dockerId: string): Promise<OrchestratorStats> {
    const container = this.docker.getContainer(dockerId);
    const stats = await container.stats({ stream: false });

    const cpuDelta = stats.cpu_stats.cpu_usage.total_usage - (stats.precpu_stats?.cpu_usage?.total_usage ?? 0);
    const systemDelta = stats.cpu_stats.system_cpu_usage - (stats.precpu_stats?.system_cpu_usage ?? 0);
    const cpuPercent = systemDelta > 0 ? (cpuDelta / systemDelta) * 100 : 0;

    return {
      cpuPercent,
      memoryBytes: stats.memory_stats.usage ?? 0,
      networkRxBytes: Object.values(stats.networks ?? {}).reduce((sum: number, n: any) => sum + (n.rx_bytes ?? 0), 0) as number,
      networkTxBytes: Object.values(stats.networks ?? {}).reduce((sum: number, n: any) => sum + (n.tx_bytes ?? 0), 0) as number,
    };
  }

  async isRunning(dockerId: string): Promise<boolean> {
    try {
      const container = this.docker.getContainer(dockerId);
      const info = await container.inspect();
      return info.State.Running;
    } catch {
      return false;
    }
  }

  async getLogs(dockerId: string, tail = 100): Promise<string> {
    const container = this.docker.getContainer(dockerId);
    const logs = await container.logs({ stdout: true, stderr: true, tail });
    return logs.toString();
  }

  private async pullImage(): Promise<void> {
    log('Pulling image %s', this.config.image);
    await new Promise<void>((resolve, reject) => {
      this.docker.pull(this.config.image, {}, (err: Error | null, stream?: NodeJS.ReadableStream) => {
        if (err) return reject(err);
        if (!stream) return reject(new Error('No stream returned from pull'));
        this.docker.modem.followProgress(stream, (err2: Error | null) => err2 ? reject(err2) : resolve());
      });
    });
  }

  private parseMemoryLimit(limit?: string): number | undefined {
    if (!limit) return undefined;
    const match = limit.match(/^(\d+(?:\.\d+)?)\s*(B|K|M|G|T)?$/i);
    if (!match) return undefined;
    const [, num, unit] = match;
    const multipliers: Record<string, number> = { B: 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 };
    return Math.floor(parseFloat(num!) * (multipliers[unit?.toUpperCase() ?? 'B'] ?? 1));
  }

  private parseCpuLimit(limit?: string): number | undefined {
    if (!limit) return undefined;
    return Math.floor(parseFloat(limit) * 1e9); // Convert to nanocpus
  }
}

