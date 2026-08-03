/**
 * Docker-based orchestrator implementation.
 */

import Docker from 'dockerode';
import debug from 'debug';
import { randomBytes } from 'node:crypto';
import type { DockerConfig } from '../config/types.js';
import type {
  ContainerRunState,
  OrchestratorCreateRequest,
  OrchestratorCreateResult,
  OrchestratorStats,
  RecoverableOrchestrator,
} from './orchestrator.js';
import { CONTAINER_PORTS, buildNodeEnv } from './container-env.js';

const log = debug('cadre:provider:docker');

/** Label carrying the provider's container id on both containers and volumes. */
const CONTAINER_ID_LABEL = 'sereus.container-id';

/** Path inside the image that holds all durable node-local state (see the Dockerfile's `DATA_DIR`). */
const DATA_MOUNT_TARGET = '/data';

/**
 * Name of the durable per-container volume mounted at `/data`.
 *
 * Named (rather than the image's anonymous `VOLUME ["/data"]`) so the provider
 * can find and delete it, and so recreating a container under the same provider
 * container id — an image upgrade — re-attaches the same state and therefore
 * the same libp2p identity. Provider container ids are `ctr_<nanoid16>` and
 * nanoid's alphabet (`A-Za-z0-9_-`) is entirely legal in a Docker volume name.
 */
export function volumeNameFor(containerId: string): string {
  return `cadre-${containerId}-data`;
}

/**
 * Docker's `State.FinishedAt` for a container that has never exited is Go's
 * zero time (`0001-01-01T00:00:00Z`), not an empty string — parsing it naively
 * yields a valid `Date` in year 1 and would report a phantom exit. Anything at
 * or before the Unix epoch is that sentinel (no container exits in 1969), as is
 * an absent or unparseable value.
 */
function parseDockerFinishedAt(finishedAt: string | undefined): Date | undefined {
  if (!finishedAt) return undefined;
  const at = new Date(finishedAt);
  const ms = at.getTime();
  return Number.isNaN(ms) || ms <= 0 ? undefined : at;
}

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
export class DockerOrchestrator implements RecoverableOrchestrator {
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

  /**
   * Ensure the durable `/data` volume for `containerId` exists.
   *
   * Returns `true` only when THIS call created it. A pre-existing volume is
   * re-attached untouched and reported as not-ours, so the create failure path
   * never destroys the state of a container being recreated (image upgrade).
   * Any inspect error other than "not found" is rethrown rather than guessed
   * at — provisioning failing is far cheaper than deleting a tenant's identity.
   */
  private async ensureVolume(containerId: string, partyId: string): Promise<boolean> {
    const name = volumeNameFor(containerId);
    try {
      await this.docker.getVolume(name).inspect();
      log('Reusing existing volume %s', name);
      return false;
    } catch (err) {
      if ((err as { statusCode?: number }).statusCode !== 404) throw err;
    }

    // Labelled so the volume is discoverable by label rather than by parsing names.
    await this.docker.createVolume({
      Name: name,
      Labels: { [CONTAINER_ID_LABEL]: containerId, 'sereus.party-id': partyId },
    });
    log('Created volume %s', name);
    return true;
  }

  /** Best-effort volume removal; a missing volume must never fail a termination. */
  private async removeVolume(name: string): Promise<void> {
    try {
      await this.docker.getVolume(name).remove();
      log('Removed volume %s', name);
    } catch (err) {
      log('Volume %s removal failed (continuing): %O', name, err);
    }
  }

  /**
   * Names of the durable volumes attached to a container, read from a live
   * inspect *before* removal — the container's own record is the only
   * authoritative source. Deliberately not an in-memory map: `containerPorts`
   * already loses its contents across a provider restart, and volume cleanup
   * must not inherit that weakness.
   *
   * Only the volume this orchestrator would itself have created for the
   * container's own id is returned, so an operator-attached mount is never
   * reaped. A container created before named volumes existed matches nothing
   * here; its anonymous volume is reaped by `remove({ v: true })` instead.
   */
  private async durableVolumesOf(container: Docker.Container): Promise<string[]> {
    try {
      const info = await container.inspect();
      const containerId = info.Config?.Labels?.[CONTAINER_ID_LABEL];
      if (!containerId) return [];
      const expected = volumeNameFor(containerId);
      return (info.Mounts ?? [])
        .filter(m => m.Type === 'volume' && m.Name === expected && m.Destination === DATA_MOUNT_TARGET)
        .map(() => expected);
    } catch (err) {
      log('Could not inspect %s for volumes before removal: %O', container.id, err);
      return [];
    }
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

    // Per-container secret gating the node's `POST /seed` route. The container
    // refuses seed delivery unless the caller presents this as a bearer token
    // (and the route is unregistered entirely when the env var is empty), so we
    // mint a fresh high-entropy value per container and hand it back on the
    // result for `ContainerService.applySeed` to send.
    const seedToken = randomBytes(32).toString('base64url');

    // Anything that throws between allocation and the successful record below
    // must release the ports, best-effort remove a partially-created container,
    // and drop a volume this attempt created — otherwise the bounded host-port
    // range leaks permanently and a failed provision strands a volume.
    let container: Docker.Container | undefined;
    let createdVolume = false;
    try {
      // The node mints its own identity key into this volume on first start, so
      // the key never crosses the provider/tenant boundary; the volume is what
      // makes it survive a restart.
      createdVolume = await this.ensureVolume(request.containerId, request.partyId);

      // Create container
      container = await this.docker.createContainer({
        name: `cadre-${request.containerId}`,
        Image: this.config.image,
        Env: buildNodeEnv({ request, seedToken, resources }),
        HostConfig: {
          // Health (which also serves the authenticated `POST /seed`) and metrics
          // are bound to the host's loopback only: the provider reaches them via
          // `http://localhost:<port>` and nothing off-box should touch the seed
          // surface. A bare `HostPort` would bind `0.0.0.0` and expose the seed
          // route to the network. The p2p port (4001) intentionally stays on all
          // interfaces — libp2p peers must reach it remotely.
          PortBindings: {
            [`${CONTAINER_PORTS.health}/tcp`]: [{ HostIp: '127.0.0.1', HostPort: String(healthPort) }],
            [`${CONTAINER_PORTS.metrics}/tcp`]: [{ HostIp: '127.0.0.1', HostPort: String(metricsPort) }],
            [`${CONTAINER_PORTS.p2p}/tcp`]: [{ HostPort: String(p2pPort) }],
          },
          // Durable per-tenant state (identity key, generated config,
          // bootstrap-peer store, trusted-owner anchor, storage) all live under
          // /data. `Mounts` rather than `Binds`: no host path to configure and
          // it works against a remote Docker daemon.
          Mounts: [
            { Type: 'volume', Source: volumeNameFor(request.containerId), Target: DATA_MOUNT_TARGET },
          ],
          Memory: this.parseMemoryLimit(resources.memoryLimit),
          NanoCpus: this.parseCpuLimit(resources.cpuLimit),
          NetworkMode: this.config.network,
          RestartPolicy: { Name: 'unless-stopped' },
        },
        Labels: {
          // The label `resolveDockerId` filters on — the only containerId → handle
          // mapping that survives a provider restart.
          [CONTAINER_ID_LABEL]: request.containerId,
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
      // Only a volume THIS attempt created — a pre-existing one belongs to the
      // container being recreated and still holds its identity.
      if (createdVolume) await this.removeVolume(volumeNameFor(request.containerId));
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
      seedToken,
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

    // Read the attached volumes while the container still exists — removal
    // destroys the only authoritative record of what it was mounting.
    const volumes = await this.durableVolumesOf(container);

    // `v: true` reaps only ANONYMOUS volumes, which is exactly what containers
    // created before named volumes existed have; our named volume needs the
    // explicit removals below.
    await container.remove({ force: true, v: true });
    for (const name of volumes) await this.removeVolume(name);

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
      networkRxBytes: Object.values(stats.networks ?? {}).reduce((sum, n) => sum + (n.rx_bytes ?? 0), 0),
      networkTxBytes: Object.values(stats.networks ?? {}).reduce((sum, n) => sum + (n.tx_bytes ?? 0), 0),
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

  /**
   * Live run state from a single `inspect` — the same call `isRunning` makes,
   * but reporting the restart/exit history too so a caller can tell "still
   * starting" from "died and is being restarted forever".
   *
   * `undefined` means the daemon no longer has the container (404); every other
   * inspect failure rethrows, because a Docker outage read as "the child is
   * fine" is the far more expensive mistake.
   */
  async inspectRunState(dockerId: string): Promise<ContainerRunState | undefined> {
    let info: Docker.ContainerInspectInfo;
    try {
      info = await this.docker.getContainer(dockerId).inspect();
    } catch (err) {
      if ((err as { statusCode?: number }).statusCode === 404) return undefined;
      throw err;
    }

    const exitedAt = parseDockerFinishedAt(info.State.FinishedAt);
    return {
      running: info.State.Running,
      restartCount: info.RestartCount ?? 0,
      ...(exitedAt ? { exitedAt, exitCode: info.State.ExitCode } : {}),
    };
  }

  /**
   * The Docker handle currently carrying this provider container id, found by
   * the `sereus.container-id` label every created container wears.
   *
   * Asks the daemon rather than the in-memory `containerPorts` map on purpose:
   * the map is empty after a provider restart, which is exactly when the reap
   * needs an answer. `all: true` so a container that exited (or never got past
   * creation) is still found — an orphan to reclaim is usually not running.
   *
   * Errors are NOT swallowed: "the daemon could not answer" must not reach the
   * reap as "there is nothing to reclaim".
   */
  async resolveDockerId(containerId: string): Promise<string | undefined> {
    const matches = await this.docker.listContainers({
      all: true,
      filters: { label: [`${CONTAINER_ID_LABEL}=${containerId}`] },
    });
    return matches[0]?.Id;
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

