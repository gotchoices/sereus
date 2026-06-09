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
import { createSecretsStore } from '../nat/secrets/index.js';
import {
  resolvePushCredentials,
  setFcmSecret,
  setApnsSecret,
  clearPushSecret,
  pushStatus,
} from '../push/index.js';
import { AuthorityNodeClient } from '../authority/index.js';
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
      console.log(`cadre-host installed.`);
      console.log(`  Data dir:     ${result.dataDir}`);
      console.log(`  UI:           ${result.uiUrl}`);
      console.log(`  Service:      ${result.serviceName}`);
      if (result.enrollmentInvite) {
        printEnrollmentInvite(result.enrollmentInvite);
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
        console.error(`cadre-host start: identity file not found at ${idPath}. Re-run \`cadre-host install\`.`);
        process.exit(1);
        return;
      }
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
          console.error(`failed to persist updated settings to ${cfgPath}: ${(err as Error).message}`);
        }
      });
      // Don't block startup on the network round-trip — call and forget.
      void updateService.check();
      updateService.start();

      // Wire the long-lived HTTP management server. The manager holds no
      // in-process cadre node: it spawns the admin's **authority node** as a
      // managed child and delegates authority/membership/identity operations
      // to it over the node's loopback admin channel (the 6.6 contract). The
      // manager never joins the control network (see docs/cadre-host.md
      // § Control-plane separation).
      // Push (FCM/APNs) credentials are resolved fresh on every node spawn so a
      // restart re-reads the secret store (rotated keys) and nothing raw is
      // persisted in state.json. The non-secret bits (bundle id / sandbox toggle,
      // cooldown/debounce) are re-read from host.config.json each call too.
      const pushSecrets = await createSecretsStore(cfg.dataDir);
      const orchestrator = new HostProcessOrchestrator({
        rootDir: join(cfg.dataDir, 'orchestrator'),
        pushResolver: () => resolvePushCredentials(pushSecrets, readHostConfig(cfgPath).push),
      });
      await orchestrator.init();

      // Spawn the authority node. Best-effort: a spawn failure leaves the
      // management API up (trust-circle listing degrades to local labels,
      // authority ops return 503) rather than taking down the whole process.
      try {
        await orchestrator.ensureAuthorityNode({
          identityPath: idPath,
          partyId: cfg.installId,
          libp2pPort: cfg.libp2pPort,
        });
        console.log('cadre-host: authority node spawned');
      } catch (err) {
        console.error(`authority node spawn failed: ${(err as Error).message}`);
      }

      // The client reads the admin endpoint lazily so a node restart's fresh
      // bearer token is picked up automatically.
      const authority = new AuthorityNodeClient(() => orchestrator.getAuthorityAdminEndpoint());

      const trustCircle = new TrustCircleService({
        cadreNode: authority,
        store: new TrustCircleStore(cfg.dataDir),
      });
      const natService = new NatService({
        rootDir: cfg.dataDir,
        cadreNode: authority,
      });

      // Push NAT-resolved invite addresses to the node on every NAT change.
      // NatService.start() also fires this once as an initial push, retried
      // until the freshly spawned authority node accepts it (bounded; the
      // management API that mints invites comes up only after start() resolves).
      natService.onAddressesChanged(async (addresses) => {
        if (addresses.length === 0) return;
        try {
          await authority.pushInviteAddresses(addresses);
        } catch (err) {
          console.error(`invite-address push failed: ${(err as Error).message}`);
        }
      });

      // Best-effort NAT start. Failures here aren't fatal — the local UI
      // can still serve the trust circle, settings, etc.
      try {
        await natService.start();
      } catch (err) {
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
        console.log(`(configured port ${cfg.uiPort} was in use — bound on ${port} instead)`);
      }
      console.log(`cadre-host local UI: ${url}`);

      await waitForTermination();
      try { await server.stop(); } catch { /* ignore */ }
      try { await natService.stop(); } catch { /* ignore */ }
      try { await orchestrator.stopAuthorityNode(); } catch { /* ignore */ }
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
  console.log('\nEnroll your first device with this invite:');
  try {
    const qr = requireForQr('qrcode-terminal') as { generate: (text: string, opts?: { small?: boolean }, cb?: (s: string) => void) => void };
    qr.generate(invite.encodedInvite, { small: true }, (rendered) => {
      console.log(rendered);
    });
  } catch (err) {
    console.error(`(qrcode-terminal unavailable: ${(err as Error).message})`);
  }
  console.log(`  ${invite.encodedInvite}`);
  if (invite.expiresAt) {
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
      console.error(
        `Failed to reach cadre-host at ${url}: ${(err as Error).message}\n` +
        `Hint: is cadre-host running? Try \`cadre-host start\`.`,
      );
      process.exit(2);
      return;
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      console.error(`cadre-host returned ${response.status}: ${text || response.statusText}`);
      process.exit(1);
      return;
    }

    const body = await response.json() as { encodedInvite?: string; expiresAt?: string; token?: string };
    if (!body.encodedInvite) {
      console.error('cadre-host returned malformed response (missing encodedInvite)');
      process.exit(1);
      return;
    }

    console.log(body.encodedInvite);
    if (body.expiresAt) {
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
      console.error(`Failed to reach cadre-host at ${url}: ${(err as Error).message}`);
      process.exit(2);
      return;
    }
    if (!response.ok) {
      console.error(`cadre-host returned ${response.status}: ${response.statusText}`);
      process.exit(1);
      return;
    }
    const body = await response.json() as {
      members: Array<{ peerId: string; label: string; addedAt: string; self?: boolean }>;
      pending: Array<{ token: string; label: string; createdAt: string; expiresAt?: string }>;
    };
    console.log('Members:');
    if (body.members.length === 0) {
      console.log('  (none)');
    } else {
      for (const m of body.members) {
        const self = m.self ? ' [self]' : '';
        console.log(`  ${m.peerId}  ${m.label}${self}`);
      }
    }
    console.log('\nPending invites:');
    if (body.pending.length === 0) {
      console.log('  (none)');
    } else {
      for (const p of body.pending) {
        const expires = p.expiresAt ? ` (expires ${p.expiresAt})` : '';
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
      console.error(`Failed to reach cadre-host at ${base}: ${(err as Error).message}`);
      process.exit(2);
      return;
    }
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      console.error(`cadre-host returned ${response.status}: ${text || response.statusText}`);
      process.exit(1);
      return;
    }
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
// credentials take effect on the next authority-node (re)spawn — run
// `cadre-host` restart (or restart the service) to apply them immediately.

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
    console.log('✓ FCM credentials stored. Restart cadre-host to apply on the authority node.');
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
      `Restart cadre-host to apply on the authority node.`,
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
    console.log(`✓ Cleared push credentials: ${target}. Restart cadre-host to apply.`);
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
    console.error(
      `Failed to reach cadre-host at ${url}: ${(err as Error).message}\n` +
      `Hint: is cadre-host running? Try \`cadre-host start\`.`,
    );
    process.exit(2);
    throw err;
  }
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    console.error(`cadre-host returned ${response.status}: ${text || response.statusText}`);
    process.exit(1);
    throw new Error('non-ok');
  }
  if (response.status === 204) return {} as NatStatusLike;
  return await response.json() as NatStatusLike;
}

function printNatStatus(s: NatStatusLike): void {
  console.log(`Port mapping: ${s.portMode ?? '?'} (external ${s.externalPort ?? '?'} → internal ${s.internalPort ?? '?'})`);
  if (s.routerExternalIp) {
    console.log(`Router IP:    ${s.routerExternalIp}`);
  }
  console.log(`External IP:  ${s.externalIp ?? '(unknown)'}${s.cgnatDetected ? '  [CGNAT detected]' : ''}`);
  console.log(`Reachability: ${s.directReachability ?? 'unknown'}${s.lastTestedAt ? `  (tested ${s.lastTestedAt})` : ''}`);
  if (s.mappingLeaseExpiresAt) {
    console.log(`Lease expires: ${s.mappingLeaseExpiresAt}`);
  }
  const ddns = s.ddns ?? {};
  if (ddns.providerId || ddns.hostname) {
    console.log(`\nDDNS:`);
    console.log(`  Provider:   ${ddns.providerId ?? '(none)'}${ddns.externallyManaged ? '  [externally managed]' : ''}`);
    console.log(`  Hostname:   ${ddns.hostname ?? '(unset)'}`);
    if (ddns.lastUpdateAt) {
      const ok = ddns.lastUpdateOk ? 'OK' : 'FAIL';
      console.log(`  Last update: ${ok} at ${ddns.lastUpdateAt}${ddns.lastError ? `  — ${ddns.lastError}` : ''}`);
    }
  } else {
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

void program.parseAsync();
