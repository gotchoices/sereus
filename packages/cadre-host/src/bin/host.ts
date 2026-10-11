#!/usr/bin/env node

/**
 * CLI entrypoint for cadre-host — the self-hosted cadre node manager.
 *
 * Most subcommands (`join`, `node`, `nat`) are thin HTTP clients against the
 * running cadre-host management API on loopback — they don't spin up an inline
 * service, so cadre-host must be running.
 *
 * The exceptions operate on disk directly and need no running service:
 * `install`, `uninstall`, `start`, `ui`, and the `push` group.
 *
 * Every command here needs a matching `### ` heading in the package README's
 * `## CLI reference`; `__tests__/cli-reference.test.ts` enforces that.
 *
 * NOTE: this file is ~1200 lines; `nat-output.ts` shows the split to make —
 * when a command group's code grows, move it to its own module under `bin/`.
 */

import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';

import { Command, InvalidArgumentError } from 'commander';

import { Installer } from '../installer/index.js';
import { readHostConfig, updateHostConfig } from '../installer/config.js';
import {
  configPath as resolveConfigPath,
  defaultDataDir,
  defaultHostJs,
  defaultServiceDir,
} from '../installer/paths.js';
import { detectPlatform } from '../installer/platform.js';
import { createServiceHost } from '../installer/service-host/index.js';
import { UpdateService } from '../update/index.js';
import { HostProcessOrchestrator } from '../orchestrator/index.js';
import {
  HostedNodeService,
  HostedNodeStore,
  HostedNodeSupervisor,
  HOSTED_NODE_REAP_SWEEP_MS,
  HOSTED_NODE_SPAWNING_TTL_MS,
} from '../hosted/index.js';
import { NatService } from '../nat/index.js';
import type { ManualForwardPatch } from '../nat/types.js';
import { createSecretsStore } from '../nat/secrets/index.js';
import {
  resolvePushCredentials,
  setFcmSecret,
  setApnsSecret,
  clearPushSecret,
  pushStatus,
} from '../push/index.js';
import { createLocalUiServer, HostSettingsStore } from '../server/index.js';
import { openBrowser } from '../installer/browser.js';
import { printForwardResult, printNatStatus, type NatStatusLike } from './nat-output.js';
import {
  printClaimPayload,
  printClaimed,
  printInvitationOutcome,
  printNodeList,
  type ClaimDetailsLike,
  type HostedNodeLike,
} from './join-output.js';

const DEFAULT_PORT = Number(process.env.CADRE_HOST_PORT ?? '8765');

function resolvePort(raw: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || n > 65535) {
    console.error(`Invalid --port: ${raw}`);
    process.exit(1);
  }
  return n;
}

const program = new Command();

program
  .name('cadre-host')
  .description('Sereus cadre node manager for self-hosted basement-PC deployments')
  .version(readPackageVersion());

// ============================================================================
// install — run the first-run wizard + register the system service
// ============================================================================

program
  .command('install')
  .description('Install cadre-host as a system service and run first-run setup')
  .option('--non-interactive', 'Use defaults / CLI flags only; never prompt')
  .option('--data-dir <path>', 'Override the data directory')
  .option('--ui-port <port>', 'Override the management UI port', parseIntArg)
  .option('--no-upnp', 'Disable UPnP/NAT-PMP probing on first run')
  .option('--no-browser', 'Do not open a browser after install')
  .option('--system', 'System-wide install (not yet supported in v1)')
  .option('--node-path <path>', 'Override the node binary embedded in the service unit')
  .option('--no-service', 'Write the data dir only; register no OS service (run the host with `cadre-host start`)')
  .action(async (opts: {
    nonInteractive?: boolean;
    dataDir?: string;
    uiPort?: number;
    upnp?: boolean;
    browser?: boolean;
    system?: boolean;
    nodePath?: string;
    service?: boolean;
  }) => {
    const installer = new Installer();
    try {
      const result = await installer.install({
        nonInteractive: Boolean(opts.nonInteractive),
        ...(opts.dataDir ? { dataDir: opts.dataDir } : {}),
        ...(typeof opts.uiPort === 'number' ? { uiPort: opts.uiPort } : {}),
        noUpnp: opts.upnp === false,
        openBrowser: opts.browser !== false,
        system: Boolean(opts.system),
        ...(opts.nodePath ? { nodePath: opts.nodePath } : {}),
        noService: opts.service === false,
      });
      console.log(`cadre-host installed.`);
      console.log(`  Data dir:     ${result.dataDir}`);
      console.log(`  UI:           ${result.uiUrl}`);
      if (result.serviceName) {
        console.log(`  Service:      ${result.serviceName}`);
      } else {
        console.log('  Service:      not registered (--no-service)');
        console.log(`  Run the host: cadre-host start --data-dir "${result.dataDir}"`);
      }
      process.exit(0);
    } catch (err) {
      console.error(`install failed: ${(err as Error).message}`);
      process.exit(1);
    }
  });

// ============================================================================
// uninstall — stop + deregister the system service
// ============================================================================

program
  .command('uninstall')
  .description('Stop and uninstall the cadre-host service')
  .option('--yes', 'Skip the confirmation prompt (for scripts)')
  .option('--remove-data', 'Also remove the data directory (default: preserve)')
  .option('--data-dir <path>', 'Override the data directory to clean up')
  .action(async (opts: { yes?: boolean; removeData?: boolean; dataDir?: string }) => {
    const installer = new Installer();
    try {
      // --remove-data is destructive and irreversible (node identities, hosted-node
      // records and NAT state are wiped). Require explicit --yes when stdin isn't a TTY, and prompt
      // confirmation when it is.
      if (opts.removeData && !opts.yes) {
        if (!process.stdin.isTTY) {
          console.error('uninstall: --remove-data requires --yes when stdin is not a TTY.');
          process.exit(1);
          return;
        }
        const dataDir = opts.dataDir ?? '(default data directory)';
        const confirmed = await confirmDestructive(
          `This will permanently delete ${dataDir} (node identities, hosted-node records, NAT state). Continue? [y/N] `,
        );
        if (!confirmed) {
          console.error('uninstall aborted.');
          process.exit(1);
          return;
        }
      }
      await installer.uninstall({
        yes: Boolean(opts.yes),
        removeData: Boolean(opts.removeData),
        ...(opts.dataDir ? { dataDir: opts.dataDir } : {}),
      });
      console.log('cadre-host uninstalled.');
      process.exit(0);
    } catch (err) {
      console.error(`uninstall failed: ${(err as Error).message}`);
      process.exit(1);
    }
  });

// ============================================================================
// status — show service-host registration / running state
// ============================================================================

program
  .command('status')
  .description('Show running status of cadre-host and the cadre nodes it manages')
  .action(async () => {
    const installer = new Installer();
    try {
      const status = await installer.status();
      console.log(`Service installed: ${status.installed ? 'yes' : 'no'}`);
      console.log(`Service running:   ${status.running ? 'yes' : 'no'}`);
      process.exit(0);
    } catch (err) {
      console.error(`status failed: ${(err as Error).message}`);
      process.exit(1);
    }
  });

// ============================================================================
// start — load config, bind management API listener, wait
// ============================================================================

program
  .command('start')
  .description('Start cadre-host in the foreground')
  .option('--data-dir <path>', 'Override the data directory (env: CADRE_HOST_DATA_DIR)')
  .option('--no-tui', 'Reserved — currently a no-op (no TUI implemented yet)')
  .action(async (opts: { dataDir?: string; tui?: boolean }) => {
    try {
      void opts.tui;
      const platform = detectPlatform();
      const dataDir = opts.dataDir ?? process.env.CADRE_HOST_DATA_DIR ?? defaultDataDir(platform);
      const cfgPath = resolveConfigPath(dataDir);
      if (!existsSync(cfgPath)) {
        console.error(
          `cadre-host start: ${cfgPath} not found. ` +
          `Run \`cadre-host install\` first (or pass --data-dir to an existing install).`,
        );
        process.exit(1);
        return;
      }
      const cfg = readHostConfig(cfgPath);
      console.log(`cadre-host starting (dataDir=${cfg.dataDir}, uiPort=${cfg.uiPort})`);

      // Update flow: notify-by-default; auto-apply opt-in via host.config.json.
      // The local-UI ticket (6.5) wires the handlers into HTTP routes; here we
      // just construct the service so the in-process timer + state file are
      // populated.
      const serviceHost = createServiceHost(platform);
      const updateService = new UpdateService({
        dataDir: cfg.dataDir,
        currentVersion: readPackageVersion(),
        settings: cfg.updates,
        ...(cfg.updates.manifestUrl ? { manifestUrl: cfg.updates.manifestUrl } : {}),
        restart: async () => {
          try {
            await serviceHost.restart({
              nodePath: process.execPath,
              hostJs: defaultHostJs(),
              dataDir: cfg.dataDir,
              serviceDir: defaultServiceDir(),
            });
            return undefined;
          } catch (err) {
            return (err as Error).message;
          }
        },
      });
      // Persist settings changes back to host.config.json on PUT /update/settings.
      updateService.onSettingsChanged((next) => {
        try {
          updateHostConfig(cfgPath, { updates: next });
        } catch (err) {
          console.error(`failed to persist updated settings to ${cfgPath}: ${(err as Error).message}`);
        }
      });
      // Don't block startup on the network round-trip — call and forget.
      void updateService.check();
      updateService.start();

      // Wire the long-lived HTTP management server. cadre-host spawns cadre
      // nodes for cadres that live on people's phones (the hosted-node service
      // below); it holds no owner key and never founds a cadre. The manager
      // never joins the control network (docs/cadre-host.md § Control-plane
      // separation).
      // Push (FCM/APNs) credentials are resolved fresh on every node spawn so a
      // restart re-reads the secret store (rotated keys) and nothing raw is
      // persisted in state.json. The non-secret bits (bundle id / sandbox toggle,
      // cooldown/debounce) are re-read from host.config.json each call too.
      const pushSecrets = await createSecretsStore(cfg.dataDir);
      // Each node is spawned announcing its public addresses. Read through a late-bound
      // reference: NatService takes the orchestrator as its node source, so it is built after.
      const addresses: { source?: NatService } = {};
      const orchestrator = new HostProcessOrchestrator({
        rootDir: join(cfg.dataDir, 'orchestrator'),
        pushResolver: () => resolvePushCredentials(pushSecrets, readHostConfig(cfgPath).push),
        announceAddrs: (id, ports) => addresses.source?.publicAddressesFor(id, ports) ?? [],
      });
      await orchestrator.init();

      // NAT layer: every node the host runs gets its two libp2p ports mapped
      // on the router (or the user's manual forward recorded for them). Started
      // before anything is spawned so the first spawns see a discovered gateway. `start()` awaits
      // only gateway discovery and IP detection (both bounded); the mappings
      // for re-attached nodes land in the background. Best-effort: a failure
      // here leaves the management API up.
      const natService = new NatService({ rootDir: cfg.dataDir, nodeSource: orchestrator });
      addresses.source = natService;
      try {
        await natService.start();
      } catch (err) {
        console.error(`NAT start failed: ${(err as Error).message}`);
      }

      // Hosted nodes — "Join a cadre": a child started waiting to be claimed, the
      // QR code the owner's phone scans, and the record of whose cadre it joined.
      // Drives `/api/hosted-nodes` (mounted by createLocalUiServer below).
      const hostedNodeStore = new HostedNodeStore(cfg.dataDir);
      const hostedNodes = new HostedNodeService({
        orchestrator,
        store: hostedNodeStore,
        addresses: natService,
        // Re-read per claim code so a Settings edit (or a hand edit) applies to the next code shown.
        claimAddressSettings: () => readHostConfig(cfgPath).claimAddresses,
      });

      // Respawn supervision — nothing else brings a hosted node back. A crash,
      // an OOM kill, or a reboot otherwise leaves the record reading `joined`
      // with no process behind it, costing its cadre a node. Sweeps at startup,
      // on every child exit, and on its own timer.
      const hostedNodeSupervisor = new HostedNodeSupervisor({
        service: hostedNodes,
        store: hostedNodeStore,
        orchestrator,
      });
      hostedNodeSupervisor.start();
      // Follows each node's /status: the claim, and whether it holds a connection.
      hostedNodes.startWatching();

      // A node learns its public addresses only at start, so one whose addresses
      // changed (a mapping on another port, a forward, the DDNS hostname, the external
      // IP) is restarted, at most once per node per 10 minutes.
      natService.onNodeAddressesStale((id) => hostedNodeSupervisor.restart(id));

      // Reap records stuck in `spawning`: a host that died between writing the
      // row and finishing the spawn leaves it stuck forever (nothing else ever
      // revisits it). Sweep once at startup (for records recovered from disk by
      // orchestrator.init()), then periodically.
      const reapStale = (): void => {
        void hostedNodes
          .reapStuckSpawning(HOSTED_NODE_SPAWNING_TTL_MS)
          .catch((err) => console.error(`hosted node reap failed: ${(err as Error).message}`));
      };
      reapStale();
      const reapTimer = setInterval(reapStale, HOSTED_NODE_REAP_SWEEP_MS);
      reapTimer.unref();

      const settingsStore = new HostSettingsStore({ dataDir: cfg.dataDir });
      const server = createLocalUiServer({
        uiPort: cfg.uiPort,
        dataDir: cfg.dataDir,
        orchestrator,
        nat: natService,
        update: updateService,
        hostedNodes,
        settingsStore,
      });
      const { url, port } = await server.start();
      if (port !== cfg.uiPort) {
        console.log(`(configured port ${cfg.uiPort} was in use — bound on ${port} instead)`);
      }
      console.log(`cadre-host local UI: ${url}`);

      await waitForTermination();
      clearInterval(reapTimer);
      hostedNodes.stopWatching();
      hostedNodeSupervisor.stop();
      try { await server.stop(); } catch { /* ignore */ }
      try { await natService.stop(); } catch { /* ignore */ }
      updateService.stop();
      console.log('cadre-host stopped.');
      process.exit(0);
    } catch (err) {
      console.error(`start failed: ${(err as Error).message}`);
      process.exit(1);
    }
  });

// ============================================================================
// ui — print the local-UI URL and open it in a browser
// ============================================================================

program
  .command('ui')
  .description('Print the local-UI URL and open it in the default browser')
  .option('--data-dir <path>', 'Override the data directory (env: CADRE_HOST_DATA_DIR)')
  .option('--no-browser', 'Print the URL but do not open a browser')
  .action((opts: { dataDir?: string; browser?: boolean }) => {
    try {
      const platform = detectPlatform();
      const dataDir = opts.dataDir ?? process.env.CADRE_HOST_DATA_DIR ?? defaultDataDir(platform);
      const cfgPath = resolveConfigPath(dataDir);
      if (!existsSync(cfgPath)) {
        console.error(`cadre-host ui: ${cfgPath} not found. Run \`cadre-host install\` first.`);
        process.exit(1);
        return;
      }
      const cfg = readHostConfig(cfgPath);
      const url = `http://127.0.0.1:${cfg.uiPort}`;
      console.log(url);
      if (opts.browser !== false) {
        const res = openBrowser(url);
        if (res.spawned) {
          console.log('(Opening in your default browser...)');
        } else if (res.error) {
          console.error(`(unable to launch browser: ${res.error})`);
        }
      }
      process.exit(0);
    } catch (err) {
      console.error(`ui failed: ${(err as Error).message}`);
      process.exit(1);
    }
  });

function parseIntArg(raw: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    throw new Error(`Invalid integer: ${raw}`);
  }
  return n;
}

function readPackageVersion(): string {
  try {
    // dist/bin/host.js -> ../../package.json
    const here = dirname(fileURLToPath(import.meta.url));
    const pkgPath = resolve(here, '..', '..', 'package.json');
    const raw = readFileSync(pkgPath, 'utf8');
    const parsed = JSON.parse(raw) as { version?: string };
    return parsed.version ?? '0.0.0-unknown';
  } catch {
    return '0.0.0-unknown';
  }
}

function waitForTermination(): Promise<void> {
  return new Promise<void>((resolveTerm) => {
    const done = () => resolveTerm();
    process.once('SIGINT', done);
    process.once('SIGTERM', done);
  });
}

async function confirmDestructive(message: string): Promise<boolean> {
  const { createInterface } = await import('node:readline');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await new Promise<string>((res) => rl.question(message, res));
    return /^(y|yes)$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

// ============================================================================
// join — start a node waiting to be claimed and show the QR code, or one that
// redeems a cadre invitation
// ============================================================================
//
// The host's one action. The owner's phone scans the code (or takes the pasted
// text), claims the node, and the node joins that phone's cadre. To put up a
// node for a friend, run it again and let the friend scan. With `--invitation`
// the node instead redeems an invitation the owner's app copied, at whichever
// member of the cadre it can reach. These commands are thin HTTP clients of the
// loopback `/api/hosted-nodes` surface — no bearer (same-machine admin), same
// posture as `nat`.

/** How long `join` waits for the new child's `/status` before giving up on the claim details. */
const CLAIM_DETAILS_WAIT_MS = 60_000;
const CLAIM_DETAILS_POLL_MS = 500;
/** How often `join` re-reads the node while waiting for the claim or the redemption. */
const CLAIM_WAIT_POLL_MS = 2_000;

interface JoinOptions {
  qr?: boolean;
  wait?: boolean;
  invitation?: string;
  port: string;
  host: string;
}

program
  .command('join')
  .description('Start a node waiting to be claimed and show the code the owner\'s phone scans to add it to their cadre, or with --invitation one that redeems a cadre invitation')
  .option('--invitation <encoded>', 'Join with a cadre invitation the owner\'s app copied instead of showing a code; a member of the cadre must be reachable from this machine')
  .option('--no-qr', 'Print only the join text, no QR code')
  .option('--no-wait', 'Exit once the code is shown (or the node started) instead of waiting for it to join')
  .option('--port <port>', 'cadre-host management API port', String(DEFAULT_PORT))
  .option('--host <host>', 'cadre-host management API host', '127.0.0.1')
  .action(async (opts: JoinOptions) => {
    const base = `http://${opts.host}:${resolvePort(opts.port)}`;
    if (opts.invitation !== undefined) {
      const { node } = await callApi<{ node: HostedNodeLike }>(
        `${base}/api/hosted-nodes`, 'POST', { invitation: opts.invitation },
        (error) => `cadre-host refused the invitation: ${error.message} (${error.code})`,
      );
      process.exit(await followInvitationJoin(base, node, opts));
    }
    const { node } = await callApi<{ node: HostedNodeLike }>(`${base}/api/hosted-nodes`, 'POST', {});
    await showClaimAndWait(base, node, opts);
    process.exit(0);
  });

/**
 * Print the node's claim code once its child answers, then — unless `--no-wait`
 * — follow the node until a phone claims it. Ctrl-C leaves the node waiting.
 */
async function showClaimAndWait(base: string, node: HostedNodeLike, opts: JoinOptions): Promise<void> {
  const id = node.id ?? '';
  console.error(`Started hosted node ${id}; waiting for it to report its addresses…`);
  const details = await waitForClaimDetails(base, id);
  printClaimPayload(details, { qr: opts.qr !== false });
  if (opts.wait === false) return;
  console.error('Waiting for a phone to claim this node (Ctrl-C leaves it waiting)…');
  const settled = await waitUntilSettled(base, id);
  if (settled.status === 'error') {
    console.error(`✗ Hosted node ${id} failed: ${settled.error ?? 'unknown error'}`);
    process.exit(1);
  }
  printClaimed(settled);
}

/**
 * Follow a node redeeming its invitation until a member admits it or the redemption fails,
 * unless `--no-wait`. Returns the exit code: 1 when it failed. Ctrl-C leaves the node joining.
 */
async function followInvitationJoin(base: string, node: HostedNodeLike, opts: { wait?: boolean }): Promise<number> {
  console.error(`Joining cadre ${node.partyId ?? '?'} through the invitation…`);
  if (opts.wait === false) return 0;
  const settled = await waitUntilSettled(base, node.id ?? '');
  printInvitationOutcome(settled);
  return settled.status === 'joined' ? 0 : 1;
}

/** Poll `GET …/:id/claim` until the child answers (503 meanwhile), up to `CLAIM_DETAILS_WAIT_MS`. */
async function waitForClaimDetails(base: string, id: string): Promise<ClaimDetailsLike> {
  const url = `${base}/api/hosted-nodes/${encodeURIComponent(id)}/claim`;
  const deadline = Date.now() + CLAIM_DETAILS_WAIT_MS;
  while (true) {
    const response = await fetchOrExit(url, { method: 'GET' });
    if (response.ok) return (await response.json() as ApiEnvelope<ClaimDetailsLike>).data;
    if (response.status !== 503 || Date.now() >= deadline) {
      const text = await response.text().catch(() => '');
      console.error(`cadre-host returned ${response.status}: ${text || response.statusText}`);
      process.exit(1);
    }
    await sleep(CLAIM_DETAILS_POLL_MS);
  }
}

/** Poll `GET …/:id` until the node is `joined` or `error`. */
async function waitUntilSettled(base: string, id: string): Promise<HostedNodeLike> {
  const url = `${base}/api/hosted-nodes/${encodeURIComponent(id)}`;
  while (true) {
    const { node } = await callApi<{ node: HostedNodeLike }>(url, 'GET');
    if (node.status === 'joined' || node.status === 'error') return node;
    await sleep(CLAIM_WAIT_POLL_MS);
  }
}

// ============================================================================
// node subcommands — the nodes this host runs
// ============================================================================

const node = program
  .command('node')
  .description('List, remove, reset or retry the nodes this host runs');

node
  .command('list')
  .description('List hosted nodes: id, status, cadre, owner fingerprint, connected')
  .option('--port <port>', 'cadre-host management API port', String(DEFAULT_PORT))
  .option('--host <host>', 'cadre-host management API host', '127.0.0.1')
  .action(async (opts: { port: string; host: string }) => {
    const base = `http://${opts.host}:${resolvePort(opts.port)}`;
    const { nodes } = await callApi<{ nodes: HostedNodeLike[] }>(`${base}/api/hosted-nodes`, 'GET');
    printNodeList(nodes);
    process.exit(0);
  });

node
  .command('remove')
  .description('Stop a hosted node and delete its data on this machine (its cadre keeps its row until the owner removes it there)')
  .argument('<id>', 'Hosted node id (hn_…), as `cadre-host node list` shows it')
  .option('--port <port>', 'cadre-host management API port', String(DEFAULT_PORT))
  .option('--host <host>', 'cadre-host management API host', '127.0.0.1')
  .action(async (id: string, opts: { port: string; host: string }) => {
    const base = `http://${opts.host}:${resolvePort(opts.port)}`;
    await callApi(`${base}/api/hosted-nodes/${encodeURIComponent(id)}`, 'DELETE', undefined, (error) => (error.code === 'not_found'
      ? `No hosted node with id "${id}". Run \`cadre-host node list\` to list them.`
      : `cadre-host refused the removal: ${error.message} (${error.code})`));
    console.log(`removed hosted node ${id}`);
    process.exit(0);
  });

node
  .command('reset')
  .description('Remove a hosted node and start a fresh one with a new code (for a node someone else claimed, or one that failed)')
  .argument('<id>', 'Hosted node id (hn_…) to replace')
  .option('--no-qr', 'Print only the join text, no QR code')
  .option('--no-wait', 'Exit once the code is shown instead of waiting for the claim')
  .option('--port <port>', 'cadre-host management API port', String(DEFAULT_PORT))
  .option('--host <host>', 'cadre-host management API host', '127.0.0.1')
  .action(async (id: string, opts: JoinOptions) => {
    const base = `http://${opts.host}:${resolvePort(opts.port)}`;
    const { node: fresh } = await callApi<{ node: HostedNodeLike }>(
      `${base}/api/hosted-nodes/${encodeURIComponent(id)}/reset`, 'POST', {},
      (error) => (error.code === 'not_found'
        ? `No hosted node with id "${id}". Run \`cadre-host node list\` to list them.`
        : `cadre-host refused the reset: ${error.message} (${error.code})`),
    );
    console.error(`Removed hosted node ${id}.`);
    await showClaimAndWait(base, fresh, opts);
    process.exit(0);
  });

node
  .command('retry')
  .description('Start an invitation node again after no member of its cadre could be reached, and wait until it joins or fails')
  .argument('<id>', 'Hosted node id (hn_…) whose invitation failed')
  .option('--no-wait', 'Exit once the node is started again instead of waiting for it to join')
  .option('--port <port>', 'cadre-host management API port', String(DEFAULT_PORT))
  .option('--host <host>', 'cadre-host management API host', '127.0.0.1')
  .action(async (id: string, opts: { wait?: boolean; port: string; host: string }) => {
    const base = `http://${opts.host}:${resolvePort(opts.port)}`;
    const { node: retried } = await callApi<{ node: HostedNodeLike }>(
      `${base}/api/hosted-nodes/${encodeURIComponent(id)}/retry`, 'POST', {},
      (error) => (error.code === 'not_found'
        ? `No hosted node with id "${id}". Run \`cadre-host node list\` to list them.`
        : `cadre-host refused the retry: ${error.message} (${error.code})`),
    );
    process.exit(await followInvitationJoin(base, retried, opts));
  });

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

// ============================================================================
// nat subcommands
// ============================================================================

const nat = program
  .command('nat')
  .description('Manage NAT traversal, port forwarding, and dynamic DNS');

nat
  .command('status')
  .description('Show NAT, external-IP, and DDNS status')
  .option('--port <port>', 'cadre-host management API port', String(DEFAULT_PORT))
  .option('--host <host>', 'cadre-host management API host', '127.0.0.1')
  .option('--json', 'Output raw JSON instead of a human-readable summary')
  .action(async (opts: { port: string; host: string; json?: boolean }) => {
    const url = `http://${opts.host}:${resolvePort(opts.port)}/nat/status`;
    const body = await getJson(url);
    if (opts.json) {
      console.log(JSON.stringify(body, null, 2));
    } else {
      printNatStatus(body);
    }
    process.exit(0);
  });

nat
  .command('test')
  .description('Re-run reachability probes and print the result')
  .option('--port <port>', 'cadre-host management API port', String(DEFAULT_PORT))
  .option('--host <host>', 'cadre-host management API host', '127.0.0.1')
  .option('--json', 'Output raw JSON instead of a human-readable summary')
  .action(async (opts: { port: string; host: string; json?: boolean }) => {
    const url = `http://${opts.host}:${resolvePort(opts.port)}/nat/test`;
    const body = await postJson(url, {});
    if (opts.json) {
      console.log(JSON.stringify(body, null, 2));
    } else {
      printNatStatus(body);
    }
    process.exit(0);
  });

nat
  .command('settings')
  .description('Update NAT settings (UPnP toggle)')
  .option('--upnp', 'Ask the router for port mappings over UPnP')
  .option('--no-upnp', 'Stop asking the router for port mappings (manual forwards stay)')
  .option('--port <port>', 'cadre-host management API port', String(DEFAULT_PORT))
  .option('--host <host>', 'cadre-host management API host', '127.0.0.1')
  .action(async (opts: {
    upnp?: boolean;
    port: string;
    host: string;
  }) => {
    const url = `http://${opts.host}:${resolvePort(opts.port)}/nat/settings`;
    const patch: Record<string, unknown> = {};
    // Commander assigns `upnp: false` when `--no-upnp` is passed.
    if (opts.upnp === false) patch.upnpEnabled = false;
    if (opts.upnp === true) patch.upnpEnabled = true;

    const body = await putJson(url, patch);
    printNatStatus(body);
    process.exit(0);
  });

interface ForwardOptions {
  tcp?: number;
  ws?: number;
  clearTcp?: boolean;
  clearWs?: boolean;
  clear?: boolean;
  port: string;
  host: string;
}

nat
  .command('forward')
  .description('Tell cadre-host the external ports you forwarded on your router for one node')
  .argument('<nodeId>', 'Node id as `cadre-host nat status` lists it')
  .option('--tcp <port>', "External port your router forwards to the node's TCP port", parsePortArg)
  .option('--ws <port>', "External port your router forwards to the node's WebSocket port", parsePortArg)
  .option('--clear-tcp', 'Forget the TCP forward')
  .option('--clear-ws', 'Forget the WebSocket forward')
  .option('--clear', 'Forget both forwards')
  .option('--port <port>', 'cadre-host management API port', String(DEFAULT_PORT))
  .option('--host <host>', 'cadre-host management API host', '127.0.0.1')
  .action(async (nodeId: string, opts: ForwardOptions) => {
    const patch = forwardPatchFrom(opts);
    const url = `http://${opts.host}:${resolvePort(opts.port)}/nat/nodes/${encodeURIComponent(nodeId)}/forward`;
    const body = await callJson<NatStatusLike>(url, 'PUT', patch, (error) => (error.code === 'unknown_node'
      ? `No node with id "${nodeId}" runs on this host. Run \`cadre-host nat status\` to list node ids.`
      : `cadre-host refused the forward: ${error.message} (${error.code})`));
    printForwardResult(nodeId, body);
    process.exit(0);
  });

/** The route's patch: a port sets that forward, a clear flag sends `null`. Exits on conflicting or missing flags. */
function forwardPatchFrom(opts: ForwardOptions): ManualForwardPatch {
  const patch: ManualForwardPatch = {};
  const clears = { tcp: opts.clearTcp === true, ws: opts.clearWs === true };
  for (const kind of ['tcp', 'ws'] as const) {
    const value = opts[kind];
    const clear = opts.clear === true || clears[kind];
    if (value !== undefined && clear) {
      console.error(`--${kind} conflicts with ${opts.clear ? '--clear' : `--clear-${kind}`}`);
      process.exit(1);
    }
    if (value !== undefined) patch[kind] = value;
    else if (clear) patch[kind] = null;
  }
  if (Object.keys(patch).length === 0) {
    console.error('Nothing to change: pass --tcp, --ws, --clear-tcp, --clear-ws or --clear.');
    process.exit(1);
  }
  return patch;
}

/** Commander parser for an external port. */
function parsePortArg(raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new InvalidArgumentError('expected a whole number from 1 to 65535.');
  }
  return n;
}

const ddns = nat
  .command('ddns')
  .description('Configure dynamic DNS');

ddns
  .command('set')
  .description('Configure a DDNS provider (and store credentials in the keychain)')
  .argument('<provider>', 'Provider ID (e.g. "duckdns")')
  .option('--hostname <hostname>', 'Hostname to publish (e.g. foo.duckdns.org)')
  .option('--token <token>', 'Provider token (a secret value; prompts if omitted)')
  .option('--port <port>', 'cadre-host management API port', String(DEFAULT_PORT))
  .option('--host <host>', 'cadre-host management API host', '127.0.0.1')
  .action(async (provider: string, opts: {
    hostname?: string;
    token?: string;
    port: string;
    host: string;
  }) => {
    if (!opts.hostname) {
      console.error('--hostname is required');
      process.exit(1);
      return;
    }
    const config: Record<string, string> = {};
    if (opts.token) config.token = opts.token;

    if (!config.token) {
      if (!process.stdin.isTTY) {
        console.error(
          'Missing --token for provider "' + provider + '" and stdin is not a TTY. ' +
          'Re-run with --token <secret>.',
        );
        process.exit(1);
        return;
      }
      try {
        config.token = await readSecretLine('DDNS token: ');
      } catch (err) {
        console.error('Failed to read token: ' + (err as Error).message);
        process.exit(1);
        return;
      }
    }

    const url = `http://${opts.host}:${resolvePort(opts.port)}/nat/ddns`;
    const body = await putJson(url, {
      providerId: provider,
      hostname: opts.hostname,
      config,
      externallyManaged: false,
    });
    printNatStatus(body);
    process.exit(0);
  });

ddns
  .command('external')
  .description('Declare an externally-managed DDNS hostname (cadre-host does not update it)')
  .requiredOption('--hostname <hostname>', 'Hostname (no provider; cadre-host will not push updates)')
  .option('--port <port>', 'cadre-host management API port', String(DEFAULT_PORT))
  .option('--host <host>', 'cadre-host management API host', '127.0.0.1')
  .action(async (opts: { hostname: string; port: string; host: string }) => {
    const url = `http://${opts.host}:${resolvePort(opts.port)}/nat/settings`;
    const body = await putJson(url, {
      ddns: {
        providerId: 'external',
        hostname: opts.hostname,
        externallyManaged: true,
      },
    });
    printNatStatus(body);
    process.exit(0);
  });

// ============================================================================
// push subcommands — provision FCM/APNs credentials for strand-wake delivery
// ============================================================================
//
// These operate directly on the data dir's secret store + host.config.json (they
// do NOT go through the running management API). Private keys land in the OS
// keychain (keytar) or the 0600 file-store fallback; the non-secret bits (APNs
// bundle id / sandbox toggle, cooldown/debounce) land in host.config.json. New
// credentials reach a node the next time it is spawned.

const push = program
  .command('push')
  .description('Configure FCM/APNs push credentials for mobile strand-wake delivery');

push
  .command('fcm')
  .description('Store Firebase Cloud Messaging (Android) service-account credentials')
  .requiredOption('--project-id <id>', 'GCP / Firebase project id')
  .requiredOption('--client-email <email>', 'Service-account email')
  .option('--private-key-file <path>', 'Path to the service-account private key (PEM)')
  .option('--private-key <pem>', 'Inline PEM private key (prefer --private-key-file)')
  .option('--data-dir <path>', 'Override the data directory (env: CADRE_HOST_DATA_DIR)')
  .action(async (opts: {
    projectId: string;
    clientEmail: string;
    privateKeyFile?: string;
    privateKey?: string;
    dataDir?: string;
  }) => {
    const { dataDir } = resolveHostPaths(opts.dataDir);
    const privateKey = readPrivateKeyArg(opts.privateKeyFile, opts.privateKey, 'FCM');
    const secrets = await createSecretsStore(dataDir);
    await setFcmSecret(secrets, {
      projectId: opts.projectId,
      clientEmail: opts.clientEmail,
      privateKey,
    });
    console.log('✓ FCM credentials stored. A node picks them up the next time it is spawned.');
    process.exit(0);
  });

push
  .command('apns')
  .description('Store Apple Push Notification service (iOS) auth-key credentials')
  .requiredOption('--key-id <id>', 'APNs key id (the .p8 key identifier)')
  .requiredOption('--team-id <id>', 'Apple developer team id')
  .requiredOption('--bundle-id <id>', 'App bundle id (becomes the apns-topic)')
  .option('--private-key-file <path>', 'Path to the .p8 auth key (PEM)')
  .option('--private-key <pem>', 'Inline .p8 PEM key (prefer --private-key-file)')
  .option('--production', 'Target the production APNs host (default: sandbox)')
  .option('--data-dir <path>', 'Override the data directory (env: CADRE_HOST_DATA_DIR)')
  .action(async (opts: {
    keyId: string;
    teamId: string;
    bundleId: string;
    privateKeyFile?: string;
    privateKey?: string;
    production?: boolean;
    dataDir?: string;
  }) => {
    const { dataDir, cfgPath } = resolveHostPaths(opts.dataDir);
    const privateKey = readPrivateKeyArg(opts.privateKeyFile, opts.privateKey, 'APNs');
    const secrets = await createSecretsStore(dataDir);
    // Secret bits → secret store; non-secret app-config → host.config.json.
    await setApnsSecret(secrets, { keyId: opts.keyId, teamId: opts.teamId, privateKey });
    const current = readHostConfig(cfgPath);
    updateHostConfig(cfgPath, {
      push: {
        ...current.push,
        apns: { bundleId: opts.bundleId, production: opts.production === true },
      },
    });
    console.log(
      `✓ APNs credentials stored (${opts.production ? 'production' : 'sandbox'}). ` +
      `A node picks them up the next time it is spawned.`,
    );
    process.exit(0);
  });

push
  .command('options')
  .description('Set non-secret push tuning (anti-spam cooldown / burst-coalesce window)')
  .option('--cooldown-ms <ms>', 'Per-(peer,strand) minimum gap between wakes', parseIntArg)
  .option('--debounce-ms <ms>', 'Per-strand burst-coalescing window', parseIntArg)
  .option('--data-dir <path>', 'Override the data directory (env: CADRE_HOST_DATA_DIR)')
  .action((opts: { cooldownMs?: number; debounceMs?: number; dataDir?: string }) => {
    const { cfgPath } = resolveHostPaths(opts.dataDir);
    const current = readHostConfig(cfgPath);
    const nextPush = { ...current.push };
    if (typeof opts.cooldownMs === 'number') nextPush.cooldownMs = opts.cooldownMs;
    if (typeof opts.debounceMs === 'number') nextPush.debounceMs = opts.debounceMs;
    updateHostConfig(cfgPath, { push: nextPush });
    console.log('✓ Push options updated.');
    process.exit(0);
  });

push
  .command('clear')
  .description('Remove stored push credentials')
  .argument('<target>', 'Which to clear: "fcm", "apns", or "all"')
  .option('--data-dir <path>', 'Override the data directory (env: CADRE_HOST_DATA_DIR)')
  .action(async (target: string, opts: { dataDir?: string }) => {
    if (!['fcm', 'apns', 'all'].includes(target)) {
      console.error(`push clear: target must be one of fcm | apns | all (got "${target}")`);
      process.exit(1);
      return;
    }
    const { dataDir, cfgPath } = resolveHostPaths(opts.dataDir);
    const secrets = await createSecretsStore(dataDir);
    if (target === 'fcm' || target === 'all') await clearPushSecret(secrets, 'fcm');
    if (target === 'apns' || target === 'all') {
      await clearPushSecret(secrets, 'apns');
      const current = readHostConfig(cfgPath);
      if (current.push?.apns) {
        const { apns: _drop, ...rest } = current.push;
        updateHostConfig(cfgPath, { push: rest });
      }
    }
    console.log(`✓ Cleared push credentials: ${target}. A node stops carrying them the next time it is spawned.`);
    process.exit(0);
  });

push
  .command('status')
  .description('Show which push platforms are configured (no secret material)')
  .option('--data-dir <path>', 'Override the data directory (env: CADRE_HOST_DATA_DIR)')
  .action(async (opts: { dataDir?: string }) => {
    const { dataDir, cfgPath } = resolveHostPaths(opts.dataDir);
    const secrets = await createSecretsStore(dataDir);
    const status = await pushStatus(secrets);
    const cfg = readHostConfig(cfgPath);
    console.log('Push credentials:');
    console.log(`  FCM:  ${status.fcm ? 'configured' : 'not configured'}`);
    const prod = cfg.push?.apns?.production ? 'production' : 'sandbox';
    const bundle = cfg.push?.apns?.bundleId ? ` bundle=${cfg.push.apns.bundleId} (${prod})` : '';
    console.log(`  APNs: ${status.apns ? `configured${bundle}` : 'not configured'}`);
    if (cfg.push?.cooldownMs !== undefined) console.log(`  cooldownMs: ${cfg.push.cooldownMs}`);
    if (cfg.push?.debounceMs !== undefined) console.log(`  debounceMs: ${cfg.push.debounceMs}`);
    process.exit(0);
  });

/** Resolve the data dir + config path for a direct-on-disk push subcommand. */
function resolveHostPaths(dataDirOpt?: string): { dataDir: string; cfgPath: string } {
  const platform = detectPlatform();
  const dataDir = dataDirOpt ?? process.env.CADRE_HOST_DATA_DIR ?? defaultDataDir(platform);
  const cfgPath = resolveConfigPath(dataDir);
  if (!existsSync(cfgPath)) {
    console.error(`${cfgPath} not found. Run \`cadre-host install\` first (or pass --data-dir).`);
    process.exit(1);
  }
  // Resolve the real data dir from the persisted config (handles default-dir installs).
  const cfg = readHostConfig(cfgPath);
  return { dataDir: cfg.dataDir, cfgPath };
}

/** Read a private key from a file or inline flag; exit with a clear error if neither. */
function readPrivateKeyArg(file: string | undefined, inline: string | undefined, label: string): string {
  if (file) {
    try {
      return readFileSync(file, 'utf8');
    } catch (err) {
      console.error(`Failed to read ${label} private key file ${file}: ${(err as Error).message}`);
      process.exit(1);
    }
  }
  if (inline) return inline;
  console.error(`${label}: supply --private-key-file <path> (or --private-key <pem>).`);
  process.exit(1);
  throw new Error('unreachable');
}

async function getJson(url: string): Promise<NatStatusLike> {
  return await callJson<NatStatusLike>(url, 'GET');
}

async function postJson(url: string, body: unknown): Promise<NatStatusLike> {
  return await callJson<NatStatusLike>(url, 'POST', body);
}

async function putJson(url: string, body: unknown): Promise<NatStatusLike> {
  return await callJson<NatStatusLike>(url, 'PUT', body);
}

/** The `{ code, message }` of a management-API error response. */
interface ApiErrorBody {
  code: string;
  message: string;
}

/** The `/api/*` routes' success envelope. */
interface ApiEnvelope<T> {
  ok: true;
  data: T;
}

/**
 * One request to an `/api/*` route, unwrapping its `{ ok, data }` envelope.
 * Exits on failure as `callJson` does; a 204 answers `undefined`.
 */
async function callApi<T = undefined>(
  url: string,
  method: string,
  body?: unknown,
  describeError?: (error: ApiErrorBody) => string,
): Promise<T> {
  const envelope = await callJson<ApiEnvelope<T> | undefined>(url, method, body, describeError);
  return envelope?.data as T;
}

/**
 * One request to the management API, exiting on failure: 2 when cadre-host is
 * unreachable, 1 on a non-OK response, printed by `describeError` when the
 * response carries a typed error and the caller has words for it.
 */
async function callJson<T>(
  url: string,
  method: string,
  body?: unknown,
  describeError?: (error: ApiErrorBody) => string,
): Promise<T> {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.headers = { 'content-type': 'application/json' };
    init.body = JSON.stringify(body);
  }
  const response = await fetchOrExit(url, init);
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    const error = describeError ? apiErrorOf(response, text) : null;
    console.error(error && describeError
      ? describeError(error)
      : `cadre-host returned ${response.status}: ${text || response.statusText}`);
    process.exit(1);
    throw new Error('non-ok');
  }
  if (response.status === 204) return undefined as T;
  return await response.json() as T;
}

/** `fetch`, exiting 2 with a hint when cadre-host cannot be reached at all. */
async function fetchOrExit(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (err) {
    console.error(
      `Failed to reach cadre-host at ${url}: ${(err as Error).message}\n` +
      `Hint: is cadre-host running? Try \`cadre-host start\`.`,
    );
    process.exit(2);
    throw err;
  }
}

/** The typed error in a `{ ok: false, error: { code, message } }` body (`server/error-handler.ts`), or null. */
function apiErrorOf(response: Response, text: string): ApiErrorBody | null {
  if (!response.headers.get('content-type')?.includes('application/json')) return null;
  let parsed: { error?: { code?: unknown; message?: unknown } };
  try {
    parsed = JSON.parse(text) as typeof parsed;
  } catch {
    // Malformed JSON: the caller prints the raw text instead.
    return null;
  }
  const { code, message } = parsed.error ?? {};
  if (typeof code !== 'string') return null;
  return { code, message: typeof message === 'string' ? message : '' };
}

/** Read a single line from stdin with echo suppressed (TTY only). */
function readSecretLine(prompt: string): Promise<string> {
  return new Promise<string>((resolveLine, rejectLine) => {
    const stdin = process.stdin;
    const stdout = process.stdout;
    const wasRaw = stdin.isRaw;
    try {
      stdout.write(prompt);
      stdin.setRawMode(true);
    } catch (err) {
      rejectLine(err);
      return;
    }
    stdin.resume();
    stdin.setEncoding('utf8');

    let buf = '';
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === '\n' || ch === '\r' || ch === '') {
          stdin.removeListener('data', onData);
          try { stdin.setRawMode(wasRaw); } catch { /* ignore */ }
          stdin.pause();
          stdout.write('\n');
          resolveLine(buf);
          return;
        }
        if (ch === '') {
          // Ctrl-C
          stdin.removeListener('data', onData);
          try { stdin.setRawMode(wasRaw); } catch { /* ignore */ }
          stdin.pause();
          stdout.write('\n');
          rejectLine(new Error('cancelled'));
          return;
        }
        if (ch === '' || ch === '\b') {
          buf = buf.slice(0, -1);
          continue;
        }
        buf += ch;
      }
    };
    stdin.on('data', onData);
  });
}

/**
 * True when this module is the process entry point rather than an import.
 * `import.meta.url` is already realpath-resolved by Node's ESM loader, so
 * `process.argv[1]` gets the same treatment before comparing — a package-manager
 * bin symlink otherwise fails to match.
 *
 * NOTE: accepted tradeoff — a false negative here is a CLI that exits 0 having
 * printed nothing, which is a quiet failure. Gating on `process.env.VITEST`
 * instead was rejected (a test-runner variable has no business in shipped CLI
 * source); the counter-guard is `src/__tests__/cli.smoke.test.ts`, which spawns
 * `dist/bin/host.js --help` and asserts on non-empty stdout. Revisit if that
 * smoke test is ever weakened or removed.
 */
function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return pathToFileURL(realpathSync(entry)).href === import.meta.url;
  } catch {
    return false;
  }
}

export { program };

if (isEntryPoint()) void program.parseAsync();
