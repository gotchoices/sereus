import type { HealthStatus } from '../server/health.js';

/**
 * Minimal subset of the global `fetch` this module depends on. Declaring it
 * explicitly (rather than `typeof fetch`) keeps the testable seam easy to stub:
 * a test passes a function returning `{ ok, status, json }` with no need to
 * fabricate a full `Response`.
 */
export type FetchLike = (
  url: string,
  init?: { signal?: AbortSignal }
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

/**
 * Discriminated outcome of probing a node's health `/status` endpoint.
 * `reachable: false` means "could not read a node here" — NOT "the node is
 * stopped". Callers must not collapse it into a bare `running: false`.
 */
export type RuntimeResult =
  | { reachable: true; url: string; status: HealthStatus }
  | { reachable: false; url: string; reason: string };

/** Static config-file summary, kept distinct from live runtime. */
export interface ConfigSummary {
  config: string;
  partyId: string;
  profile: string;
  bootstrapNodes: number;
  strandFilter: unknown;
  hibernation: boolean;
}

/** Live runtime fields surfaced from a reachable node's HealthStatus. */
export interface RuntimeLive {
  reachable: true;
  url: string;
  running: boolean;
  status: HealthStatus['status'];
  peerId: string | null;
  partyId: string;
  profile: string;
  multiaddrs: string[];
  strands: HealthStatus['node']['strands'];
  uptime: number;
}

export interface RuntimeUnreachable {
  reachable: false;
  url: string;
  reason: string;
}

/** The machine-readable report: config summary (or null) plus runtime outcome. */
export interface StatusReport {
  config: ConfigSummary | null;
  runtime: RuntimeLive | RuntimeUnreachable;
}

/**
 * Probe the health `/status` endpoint, returning a discriminated result.
 *
 * Never throws: a transport failure (ECONNREFUSED), a non-2xx response, a body
 * that won't parse, or a timeout all resolve to `{ reachable: false }`. The
 * fetch is raced against an AbortController-backed timeout so a hung connection
 * (a fetch impl that never settles) still resolves after `timeoutMs`.
 */
export async function queryRuntime(
  fetchImpl: FetchLike,
  url: string,
  timeoutMs: number
): Promise<RuntimeResult> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const timeout = new Promise<RuntimeResult>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve({ reachable: false, url, reason: `timed out after ${timeoutMs}ms` });
    }, timeoutMs);
  });

  const attempt = attemptFetch(fetchImpl, url, controller.signal);

  try {
    return await Promise.race([attempt, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** One fetch attempt, classifying every failure mode into a RuntimeResult. */
async function attemptFetch(
  fetchImpl: FetchLike,
  url: string,
  signal: AbortSignal
): Promise<RuntimeResult> {
  try {
    const res = await fetchImpl(url, { signal });
    if (!res.ok) {
      return { reachable: false, url, reason: `node returned HTTP ${res.status}` };
    }
    const status = (await res.json()) as HealthStatus;
    return { reachable: true, url, status };
  } catch (err) {
    return { reachable: false, url, reason: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Fold a config summary (or null) and a runtime probe into the report object
 * emitted by `--json`. Live runtime is the source of truth when reachable; the
 * unreachable branch deliberately carries NO `running` field.
 */
export function buildStatusReport(
  config: ConfigSummary | null,
  runtime: RuntimeResult
): StatusReport {
  if (runtime.reachable) {
    const s = runtime.status;
    return {
      config,
      runtime: {
        reachable: true,
        url: runtime.url,
        running: s.node.running,
        status: s.status,
        peerId: s.peerId,
        partyId: s.node.partyId,
        profile: s.node.profile,
        multiaddrs: s.multiaddrs,
        strands: s.node.strands,
        uptime: s.uptime,
      },
    };
  }
  return {
    config,
    runtime: { reachable: false, url: runtime.url, reason: runtime.reason },
  };
}

/** Render the human-readable report, labelling Configuration vs Runtime (live). */
export function formatStatusReport(report: StatusReport): string {
  const lines: string[] = [
    'Cadre Node Status',
    '─────────────────────────────────────────',
    ...formatConfigSection(report.config),
    '',
    ...formatRuntimeSection(report.runtime),
  ];
  return lines.join('\n');
}

function formatConfigSection(config: ConfigSummary | null): string[] {
  if (!config) {
    return ['Configuration:   (no config file found; skipped)'];
  }
  return [
    'Configuration:',
    `  Config:          ${config.config}`,
    `  Party ID:        ${config.partyId}`,
    `  Profile:         ${config.profile}`,
    `  Bootstrap Nodes: ${config.bootstrapNodes}`,
    `  Strand Filter:   ${JSON.stringify(config.strandFilter)}`,
    `  Hibernation:     ${config.hibernation ? 'enabled' : 'disabled'}`,
  ];
}

function formatRuntimeSection(runtime: RuntimeLive | RuntimeUnreachable): string[] {
  if (!runtime.reachable) {
    return [
      `Runtime: no running node reachable at ${runtime.url}`,
      `  Reason:          ${runtime.reason}`,
      '  Hint:            start a node with "cadre start"',
    ];
  }
  const s = runtime.strands;
  return [
    `Runtime (live):    ${runtime.url}`,
    `  Running:         ${runtime.running}`,
    `  Health:          ${runtime.status}`,
    `  Peer ID:         ${runtime.peerId ?? '(none)'}`,
    `  Party ID:        ${runtime.partyId}`,
    `  Profile:         ${runtime.profile}`,
    `  Strands:         total=${s.total} active=${s.active} idle=${s.idle} hibernating=${s.hibernating}`,
    ...formatMultiaddrs(runtime.multiaddrs),
  ];
}

function formatMultiaddrs(multiaddrs: string[]): string[] {
  if (multiaddrs.length === 0) {
    return ['  Multiaddrs:      (none)'];
  }
  return ['  Multiaddrs:', ...multiaddrs.map((m) => `    - ${m}`)];
}
