#!/usr/bin/env node

/**
 * CLI entrypoint for cadre-host — the self-hosted cadre node manager.
 *
 * Most subcommands are still stubs at this stage (real implementations land
 * in the sibling tickets cadre-host-nat, cadre-host-installer,
 * cadre-host-local-ui).
 *
 * The `invite` and `trust` commands talk to the running cadre-host
 * management API over loopback. They are thin HTTP clients — they don't
 * spin up an inline service, so cadre-host must be running.
 */

import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

import { Command } from 'commander';

import { parseDuration } from '../auth/duration.js';
import { Installer } from '../installer/index.js';
import { readHostConfig, updateHostConfig } from '../installer/config.js';
import {
  configPath as resolveConfigPath,
  defaultDataDir,
  defaultHostJs,
  defaultServiceDir,
  identityPath as resolveIdentityPath,
} from '../installer/paths.js';
import { detectPlatform } from '../installer/platform.js';
import { createServiceHost } from '../installer/service-host/index.js';
import { UpdateService } from '../update/index.js';
import { HostProcessOrchestrator } from '../orchestrator/index.js';
import { TrustCircleService, TrustCircleStore } from '../auth/index.js';
import { NatService } from '../nat/index.js';
import { createLocalUiServer, HostSettingsStore } from '../server/index.js';
import { openBrowser } from '../installer/browser.js';

const DEFAULT_PORT = Number(process.env.CADRE_HOST_PORT ?? '8765');

/** libp2p peer-ID prefixes by key type: Ed25519, secp256k1, legacy RSA. */
const PEER_ID_PREFIXES = ['12D3Koo', '16Uiu2HAm', 'Qm'] as const;

function looksLikePeerId(id: string): boolean {
  return PEER_ID_PREFIXES.some((p) => id.startsWith(p));
}

function resolvePort(raw: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || n > 65535) {
    // eslint-disable-next-line no-console
    console.error(`Invalid --port: ${raw}`);
    process.exit(1);
  }
  return n;
}

const program = new Command();

program
  .name('cadre-host')
  .description('Sereus cadre node manager for self-hosted basement-PC deployments')
  .version('0.6.0');

// ============================================================================
// install — run the first-run wizard + register the system service
// ============================================================================

program
  .command('install')
  .description('Install cadre-host as a system service and run first-run setup')
  .option('--non-interactive', 'Use defaults / CLI flags only; never prompt')
  .option('--data-dir <path>', 'Override the data directory')
  .option('--ui-port <port>', 'Override the management UI port', parseIntArg)
  .option('--libp2p-port <port>', 'Override the cadre libp2p port', parseIntArg)
  .option('--no-upnp', 'Disable UPnP/NAT-PMP probing on first run')
  .option('--no-browser', 'Do not open a browser after install')
  .option('--no-invite', 'Skip generating the first enrollment invite')
  .option('--system', 'System-wide install (not yet supported in v1)')
  .option('--node-path <path>', 'Override the node binary embedded in the service unit')
  .action(async (opts: {
    nonInteractive?: boolean;
    dataDir?: string;
    uiPort?: number;
    libp2pPort?: number;
    upnp?: boolean;
    browser?: boolean;
    invite?: boolean;
    system?: boolean;
    nodePath?: string;
  }) => {
    const installer = new Installer();
    try {
      const result = await installer.install({
        nonInteractive: Boolean(opts.nonInteractive),
        ...(opts.dataDir ? { dataDir: opts.dataDir } : {}),
        ...(typeof opts.uiPort === 'number' ? { uiPort: opts.uiPort } : {}),
        ...(typeof opts.libp2pPort === 'number' ? { libp2pPort: opts.libp2pPort } : {}),
        noUpnp: opts.upnp === false,
        openBrowser: opts.browser !== false,
        noInvite: opts.invite === false,
        system: Boolean(opts.system),
        ...(opts.nodePath ? { nodePath: opts.nodePath } : {}),
      });
      // eslint-disable-next-line no-console
      console.log(`cadre-host installed.`);
      // eslint-disable-next-line no-console
      console.log(`  Data dir:     ${result.dataDir}`);
      // eslint-disable-next-line no-console
      console.log(`  UI:           ${result.uiUrl}`);
      // eslint-disable-next-line no-console
      console.log(`  Service:      ${result.serviceName}`);
      if (result.enrollmentInvite) {
        printEnrollmentInvite(result.enrollmentInvite);
      }
      process.exit(0);
    } catch (err) {
      // eslint-disable-next-line no-console
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
      // --remove-data is destructive and irreversible (identity + trust circle
      // are wiped). Require explicit --yes when stdin isn't a TTY, and prompt
      // confirmation when it is.
      if (opts.removeData && !opts.yes) {
        if (!process.stdin.isTTY) {
          console.error('uninstall: --remove-data requires --yes when stdin is not a TTY.');
          process.exit(1);
          return;
        }
        const dataDir = opts.dataDir ?? '(default data directory)';
        const confirmed = await confirmDestructive(
          `This will permanently delete ${dataDir} (identity, trust circle, NAT state). Continue? [y/N] `,
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
      // eslint-disable-next-line no-console
      console.log('cadre-host uninstalled.');
      process.exit(0);
    } catch (err) {
      // eslint-disable-next-line no-console
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
      // eslint-disable-next-line no-console
      console.log(`Service installed: ${status.installed ? 'yes' : 'no'}`);
      // eslint-disable-next-line no-console
      console.log(`Service running:   ${status.running ? 'yes' : 'no'}`);
      process.exit(0);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`status failed: ${(err as Error).message}`);
      process.exit(1);
    }
  });

// ============================================================================
// start — load config + identity, bind management API listener, wait
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
        // eslint-disable-next-line no-console
        console.error(
          `cadre-host start: ${cfgPath} not found. ` +
          `Run \`cadre-host install\` first (or pass --data-dir to an existing install).`,
        );
        process.exit(1);
        return;
      }
      const cfg = readHostConfig(cfgPath);
      const idPath = resolveIdentityPath(cfg.dataDir);
      if (!existsSync(idPath)) {
        // eslint-disable-next-line no-console
        console.error(`cadre-host start: identity file not found at ${idPath}. Re-run \`cadre-host install\`.`);
        process.exit(1);
        return;
      }
      // eslint-disable-next-line no-console
      console.log(`cadre-host starting (dataDir=${cfg.dataDir}, uiPort=${cfg.uiPort})`);

      // Update flow: notify-by-default; auto-apply opt-in via host.config.json.
      // The local-UI ticket (6.5) wires the handlers into HTTP routes; here we
      // just construct the service so the in-process timer + state file are
      // populated.
      const serviceHost = createServiceHost(platform);
      const updateService = new UpdateService({
        dataDir: cfg.dataDir,
        currentVersion: readPackageVersionForStart(),
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
          // eslint-disable-next-line no-console
          console.error(`failed to persist updated settings to ${cfgPath}: ${(err as Error).message}`);
        }
      });
      // Don't block startup on the network round-trip — call and forget.
      void updateService.check();
      updateService.start();

      // Wire the long-lived HTTP management server. The trust-circle and
      // NAT services depend on a libp2p `CadreNodeLike`; v1 has no node-
      // spawning path yet (that's a follow-up ticket), so we inject minimal
      // stubs that fail loudly if a real call is attempted. The /auth/* and
      // /nat/* routes are still mounted so the CLI's existing HTTP contract
      // is intact — operations that genuinely need the libp2p node will
      // surface a NatError / TrustCircleError, mapped to 500 by the server.
      const orchestrator = new HostProcessOrchestrator({ rootDir: join(cfg.dataDir, 'orchestrator') });
      await orchestrator.init();

      const trustCircle = new TrustCircleService({
        cadreNode: missingCadreNodeStub('trust-circle'),
        store: new TrustCircleStore(cfg.dataDir),
      });
      const natService = new NatService({
        rootDir: cfg.dataDir,
        cadreNode: missingNatNodeStub(),
      });
      // Best-effort NAT start. Failures here aren't fatal — the local UI
      // can still serve the trust circle, settings, etc.
      try {
        await natService.start();
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(`NAT start failed: ${(err as Error).message}`);
      }

      const settingsStore = new HostSettingsStore({ dataDir: cfg.dataDir });
      const server = createLocalUiServer({
        uiPort: cfg.uiPort,
        dataDir: cfg.dataDir,
        orchestrator,
        trustCircle,
        nat: natService,
        update: updateService,
        settingsStore,
      });
      const { url, port } = await server.start();
      if (port !== cfg.uiPort) {
        // eslint-disable-next-line no-console
        console.log(`(configured port ${cfg.uiPort} was in use — bound on ${port} instead)`);
      }
      // eslint-disable-next-line no-console
      console.log(`cadre-host local UI: ${url}`);

      await waitForTermination();
      try { await server.stop(); } catch { /* ignore */ }
      try { await natService.stop(); } catch { /* ignore */ }
      updateService.stop();
      // eslint-disable-next-line no-console
      console.log('cadre-host stopped.');
      process.exit(0);
    } catch (err) {
      // eslint-disable-next-line no-console
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
        // eslint-disable-next-line no-console
        console.error(`cadre-host ui: ${cfgPath} not found. Run \`cadre-host install\` first.`);
        process.exit(1);
        return;
      }
      const cfg = readHostConfig(cfgPath);
      const url = `http://127.0.0.1:${cfg.uiPort}`;
      // eslint-disable-next-line no-console
      console.log(url);
      if (opts.browser !== false) {
        const res = openBrowser(url);
        if (res.spawned) {
          // eslint-disable-next-line no-console
          console.log('(Opening in your default browser...)');
        } else if (res.error) {
          // eslint-disable-next-line no-console
          console.error(`(unable to launch browser: ${res.error})`);
        }
      }
      process.exit(0);
    } catch (err) {
      // eslint-disable-next-line no-console
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

function readPackageVersionForStart(): string {
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

/**
 * Returns a `CadreNodeLike` for TrustCircleService that fails loudly on any
 * libp2p call. cadre-host v1 doesn't yet spawn the host's own cadre node —
 * that ticket is separate. The trust-circle HTTP endpoints still load the
 * local labels/pending file (listing works), but issuing/redeeming an invite
 * requires a real node and surfaces a 500.
 */
function missingCadreNodeStub(name: string): import('../auth/trust-circle.js').CadreNodeLike {
  return {
    async createInvite() { throw new Error(`${name}: cadre-host v1 has no inline cadre node — cannot issue invite`); },
    async acceptPhone() { throw new Error(`${name}: cadre-host v1 has no inline cadre node — cannot redeem`); },
    async removePeer() { throw new Error(`${name}: cadre-host v1 has no inline cadre node — cannot remove peer`); },
    encodeInvite() { throw new Error(`${name}: cadre-host v1 has no inline cadre node — cannot encode invite`); },
    getControlDatabase() { return null; },
  };
}

function missingNatNodeStub(): import('../nat/nat-service.js').CadreNodeLike {
  return {
    getPeerId() { return ''; },
    getMultiaddrs() { return []; },
  };
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

const requireForQr = createRequire(import.meta.url);

function printEnrollmentInvite(invite: { encodedInvite: string; expiresAt?: string }): void {
  // Best-effort QR render — fall back to the bare token if the lib chokes.
  // eslint-disable-next-line no-console
  console.log('\nEnroll your first device with this invite:');
  try {
    const qr = requireForQr('qrcode-terminal') as { generate: (text: string, opts?: { small?: boolean }, cb?: (s: string) => void) => void };
    qr.generate(invite.encodedInvite, { small: true }, (rendered) => {
      // eslint-disable-next-line no-console
      console.log(rendered);
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`(qrcode-terminal unavailable: ${(err as Error).message})`);
  }
  // eslint-disable-next-line no-console
  console.log(`  ${invite.encodedInvite}`);
  if (invite.expiresAt) {
    // eslint-disable-next-line no-console
    console.log(`  (expires ${invite.expiresAt})`);
  }
}

program
  .command('invite')
  .description('Generate an invite to add a member to the trust circle')
  .argument('<label>', 'Display label for the new member (e.g. "Mom\'s phone")')
  .option('--ttl <duration>', 'Invite lifetime (e.g. 24h, 7d, 30m)', '24h')
  .option('--port <port>', 'cadre-host management API port', String(DEFAULT_PORT))
  .option('--host <host>', 'cadre-host management API host', '127.0.0.1')
  .action(async (label: string, opts: { ttl: string; port: string; host: string }) => {
    let ttlMs: number;
    try {
      ttlMs = parseDuration(opts.ttl);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`Invalid --ttl: ${(err as Error).message}`);
      process.exit(1);
      return;
    }

    const port = resolvePort(opts.port);

    const url = `http://${opts.host}:${port}/auth/invites`;
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ label, ttlMs }),
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(
        `Failed to reach cadre-host at ${url}: ${(err as Error).message}\n` +
        `Hint: is cadre-host running? Try \`cadre-host start\`.`,
      );
      process.exit(2);
      return;
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      // eslint-disable-next-line no-console
      console.error(`cadre-host returned ${response.status}: ${text || response.statusText}`);
      process.exit(1);
      return;
    }

    const body = await response.json() as { encodedInvite?: string; expiresAt?: string; token?: string };
    if (!body.encodedInvite) {
      // eslint-disable-next-line no-console
      console.error('cadre-host returned malformed response (missing encodedInvite)');
      process.exit(1);
      return;
    }

    // eslint-disable-next-line no-console
    console.log(body.encodedInvite);
    if (body.expiresAt) {
      // eslint-disable-next-line no-console
      console.error(`(expires at ${body.expiresAt})`);
    }
    process.exit(0);
  });

const trust = program
  .command('trust')
  .description('Manage the trust circle (list members, revoke invites/members)');

trust
  .command('list')
  .description('List trust-circle members and pending invites')
  .option('--port <port>', 'cadre-host management API port', String(DEFAULT_PORT))
  .option('--host <host>', 'cadre-host management API host', '127.0.0.1')
  .action(async (opts: { port: string; host: string }) => {
    const url = `http://${opts.host}:${resolvePort(opts.port)}/auth/trust-circle`;
    let response: Response;
    try {
      response = await fetch(url);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`Failed to reach cadre-host at ${url}: ${(err as Error).message}`);
      process.exit(2);
      return;
    }
    if (!response.ok) {
      // eslint-disable-next-line no-console
      console.error(`cadre-host returned ${response.status}: ${response.statusText}`);
      process.exit(1);
      return;
    }
    const body = await response.json() as {
      members: Array<{ peerId: string; label: string; addedAt: string; self?: boolean }>;
      pending: Array<{ token: string; label: string; createdAt: string; expiresAt?: string }>;
    };
    // eslint-disable-next-line no-console
    console.log('Members:');
    if (body.members.length === 0) {
      // eslint-disable-next-line no-console
      console.log('  (none)');
    } else {
      for (const m of body.members) {
        const self = m.self ? ' [self]' : '';
        // eslint-disable-next-line no-console
        console.log(`  ${m.peerId}  ${m.label}${self}`);
      }
    }
    // eslint-disable-next-line no-console
    console.log('\nPending invites:');
    if (body.pending.length === 0) {
      // eslint-disable-next-line no-console
      console.log('  (none)');
    } else {
      for (const p of body.pending) {
        const expires = p.expiresAt ? ` (expires ${p.expiresAt})` : '';
        // eslint-disable-next-line no-console
        console.log(`  ${p.token}  ${p.label}${expires}`);
      }
    }
    process.exit(0);
  });

trust
  .command('revoke')
  .description('Revoke a pending invite (by token) or remove a member (by peerId)')
  .argument('<id>', 'Token (pending invite) or peerId (existing member) to remove')
  .option('--kind <kind>', 'Force interpretation: "invite" | "member" (default: auto)', 'auto')
  .option('--port <port>', 'cadre-host management API port', String(DEFAULT_PORT))
  .option('--host <host>', 'cadre-host management API host', '127.0.0.1')
  .action(async (id: string, opts: { kind: string; port: string; host: string }) => {
    const base = `http://${opts.host}:${resolvePort(opts.port)}`;
    const kind = opts.kind === 'auto'
      ? (looksLikePeerId(id) ? 'member' : 'invite')
      : opts.kind;
    const path = kind === 'member'
      ? `/auth/members/${encodeURIComponent(id)}`
      : `/auth/invites/${encodeURIComponent(id)}`;

    let response: Response;
    try {
      response = await fetch(`${base}${path}`, { method: 'DELETE' });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`Failed to reach cadre-host at ${base}: ${(err as Error).message}`);
      process.exit(2);
      return;
    }
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      // eslint-disable-next-line no-console
      console.error(`cadre-host returned ${response.status}: ${text || response.statusText}`);
      process.exit(1);
      return;
    }
    // eslint-disable-next-line no-console
    console.log(`revoked ${kind}: ${id}`);
    process.exit(0);
  });

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
      // eslint-disable-next-line no-console
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
      // eslint-disable-next-line no-console
      console.log(JSON.stringify(body, null, 2));
    } else {
      printNatStatus(body);
    }
    process.exit(0);
  });

nat
  .command('settings')
  .description('Update NAT settings (external port, UPnP toggle)')
  .option('--external-port <port>', 'External port to map')
  .option('--internal-port <port>', 'Internal libp2p port (defaults to external)')
  .option('--no-upnp', 'Disable UPnP/NAT-PMP port mapping')
  .option('--port <port>', 'cadre-host management API port', String(DEFAULT_PORT))
  .option('--host <host>', 'cadre-host management API host', '127.0.0.1')
  .action(async (opts: {
    externalPort?: string;
    internalPort?: string;
    upnp?: boolean;
    port: string;
    host: string;
  }) => {
    const url = `http://${opts.host}:${resolvePort(opts.port)}/nat/settings`;
    const patch: Record<string, unknown> = {};
    if (opts.externalPort) patch.externalPort = resolvePort(opts.externalPort);
    if (opts.internalPort) patch.internalPort = resolvePort(opts.internalPort);
    // Commander assigns `upnp: false` when `--no-upnp` is passed.
    if (opts.upnp === false) patch.upnpEnabled = false;
    if (opts.upnp === true) patch.upnpEnabled = true;

    const body = await putJson(url, patch);
    printNatStatus(body);
    process.exit(0);
  });

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
      // eslint-disable-next-line no-console
      console.error('--hostname is required');
      process.exit(1);
      return;
    }
    const config: Record<string, string> = {};
    if (opts.token) config.token = opts.token;

    if (!config.token) {
      if (!process.stdin.isTTY) {
        // eslint-disable-next-line no-console
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
        // eslint-disable-next-line no-console
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

async function getJson(url: string): Promise<NatStatusLike> {
  return await callJson(url, 'GET');
}

async function postJson(url: string, body: unknown): Promise<NatStatusLike> {
  return await callJson(url, 'POST', body);
}

async function putJson(url: string, body: unknown): Promise<NatStatusLike> {
  return await callJson(url, 'PUT', body);
}

interface NatStatusLike {
  portMode?: string;
  externalPort?: number;
  internalPort?: number;
  externalIp?: string | null;
  routerExternalIp?: string | null;
  cgnatDetected?: boolean;
  directReachability?: string;
  lastTestedAt?: string | null;
  mappingLeaseExpiresAt?: string | null;
  ddns?: {
    providerId?: string | null;
    hostname?: string | null;
    externallyManaged?: boolean;
    lastUpdateAt?: string | null;
    lastUpdateOk?: boolean | null;
    lastError?: string | null;
  };
}

async function callJson(url: string, method: string, body?: unknown): Promise<NatStatusLike> {
  let response: Response;
  try {
    const init: RequestInit = { method };
    if (body !== undefined) {
      init.headers = { 'content-type': 'application/json' };
      init.body = JSON.stringify(body);
    }
    response = await fetch(url, init);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(
      `Failed to reach cadre-host at ${url}: ${(err as Error).message}\n` +
      `Hint: is cadre-host running? Try \`cadre-host start\`.`,
    );
    process.exit(2);
    throw err;
  }
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    // eslint-disable-next-line no-console
    console.error(`cadre-host returned ${response.status}: ${text || response.statusText}`);
    process.exit(1);
    throw new Error('non-ok');
  }
  if (response.status === 204) return {} as NatStatusLike;
  return await response.json() as NatStatusLike;
}

function printNatStatus(s: NatStatusLike): void {
  // eslint-disable-next-line no-console
  console.log(`Port mapping: ${s.portMode ?? '?'} (external ${s.externalPort ?? '?'} → internal ${s.internalPort ?? '?'})`);
  if (s.routerExternalIp) {
    // eslint-disable-next-line no-console
    console.log(`Router IP:    ${s.routerExternalIp}`);
  }
  // eslint-disable-next-line no-console
  console.log(`External IP:  ${s.externalIp ?? '(unknown)'}${s.cgnatDetected ? '  [CGNAT detected]' : ''}`);
  // eslint-disable-next-line no-console
  console.log(`Reachability: ${s.directReachability ?? 'unknown'}${s.lastTestedAt ? `  (tested ${s.lastTestedAt})` : ''}`);
  if (s.mappingLeaseExpiresAt) {
    // eslint-disable-next-line no-console
    console.log(`Lease expires: ${s.mappingLeaseExpiresAt}`);
  }
  const ddns = s.ddns ?? {};
  if (ddns.providerId || ddns.hostname) {
    // eslint-disable-next-line no-console
    console.log(`\nDDNS:`);
    // eslint-disable-next-line no-console
    console.log(`  Provider:   ${ddns.providerId ?? '(none)'}${ddns.externallyManaged ? '  [externally managed]' : ''}`);
    // eslint-disable-next-line no-console
    console.log(`  Hostname:   ${ddns.hostname ?? '(unset)'}`);
    if (ddns.lastUpdateAt) {
      const ok = ddns.lastUpdateOk ? 'OK' : 'FAIL';
      // eslint-disable-next-line no-console
      console.log(`  Last update: ${ok} at ${ddns.lastUpdateAt}${ddns.lastError ? `  — ${ddns.lastError}` : ''}`);
    }
  } else {
    // eslint-disable-next-line no-console
    console.log('\nDDNS: not configured');
  }
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

program.parseAsync();
