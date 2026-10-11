import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import dgram from 'node:dgram';
import { Command } from 'commander';
import QRCode from 'qrcode';
import { encodeNodeClaimPayload } from '@serfab/cadre-core';
import { specifiedEnv } from '@serfab/config-check';
import { loadValidatedConfig } from '../config/loader.js';
import { commandEnv } from '../config/env.js';
import { resolveClaimSecret } from './claim-secret.js';
import { queryRuntime } from './status-query.js';

/** Exit code when no running node answered, as `cadre status` uses. */
const EXIT_UNREACHABLE = 3;

const LOOPBACK = /^\/(ip4\/127\.|ip6\/::1\/|dns[46]?\/localhost\/)/;
const DNS = /^\/dns[46]?\//;
/** A phone has no TCP transport: it dials WebSocket and relay addresses only. */
const PHONE_DIALABLE = /\/wss?(\/|$)|\/p2p-circuit(\/|$)/;

const IP_ADDR = /^\/ip[46]\/([^/]+)\//;
const PRIVATE_V4 = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/;
const PRIVATE_V6 = /^(f[cd]|fe80)/i;

/** Whether an /ip4 or /ip6 address is on a private network (RFC 1918, CGNAT, link-local, ULA). */
function isPrivateIp(ip: string): boolean {
  return ip.includes(':') ? PRIVATE_V6.test(ip) : PRIVATE_V4.test(ip);
}

/**
 * The addresses a node code carries, from those the node reports on `/status`: loopback
 * dropped, each ending in `/p2p/<peerId>`, DNS names first (the public names an operator
 * announced, which work away from home), then the rest in the node's order.
 *
 * Unless `all`: only addresses a phone can dial (no TCP), and of the private addresses only
 * those on `primaryIp`, the machine's main LAN address. A server also reports Docker bridges,
 * VPN and other interfaces no phone can reach, and the phone dials every address in turn, each
 * on its own timeout, so each dead one delays a failed claim. Without a `primaryIp` every
 * private address is kept. Shorter is also a smaller QR code.
 */
export function selectClaimAddresses(reported: readonly string[], peerId: string, all = false, primaryIp?: string): string[] {
  const suffix = `/p2p/${peerId}`;
  const usable = reported
    .filter((addr) => !LOOPBACK.test(addr))
    .filter((addr) => all || PHONE_DIALABLE.test(addr))
    .filter((addr) => {
      const ip = IP_ADDR.exec(addr)?.[1];
      return all || primaryIp === undefined || ip === undefined || !isPrivateIp(ip) || ip === primaryIp;
    })
    .map((addr) => (addr.endsWith(suffix) ? addr : `${addr}${suffix}`));
  return [...new Set([...usable.filter((a) => DNS.test(a)), ...usable.filter((a) => !DNS.test(a))])];
}

/**
 * A link that carries the code in its fragment: `<base>#sereus-join:1.…`. The fragment never
 * reaches a web server, so the secret stays out of its logs; an app's link handler (and a
 * landing page's script) reads it from there. Throws on a base that is not an absolute URL or
 * already has a fragment.
 */
export function nodeCodeLink(base: string, code: string): string {
  let url: URL;
  try {
    url = new URL(base);
  } catch (err) {
    throw new Error(`--link ${base} is not an absolute URL (e.g. https://example.org/join)`, { cause: err });
  }
  if (url.hash || base.includes('#')) throw new Error(`--link ${base} already has a #fragment; the code goes there`);
  return `${base}#${code}`;
}

/**
 * The machine's main LAN address: the local address the OS would use to reach the internet,
 * learned by "connecting" a UDP socket (which sends nothing) to a public address. Undefined
 * when there is no route (offline), and then no private address is dropped.
 */
export async function primaryLocalIp(): Promise<string | undefined> {
  return new Promise((resolve) => {
    const socket = dgram.createSocket('udp4');
    const done = (ip?: string) => { try { socket.close(); } catch { /* already closed */ } resolve(ip); };
    socket.on('error', () => done());
    try {
      socket.connect(53, '1.1.1.1', () => {
        try { done(socket.address().address); } catch { done(); }
      });
    } catch {
      done();
    }
  });
}

/** The command that opens a file in the desktop's default viewer, or why there is none. */
export function openerFor(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): { command: string; args: (file: string) => string[] } | { none: string } {
  if (platform === 'darwin') return { command: 'open', args: (file) => [file] };
  if (platform === 'win32') return { command: 'cmd', args: (file) => ['/c', 'start', '""', file] };
  if (env.DISPLAY || env.WAYLAND_DISPLAY) return { command: 'xdg-open', args: (file) => [file] };
  return { none: 'no graphical display here (DISPLAY and WAYLAND_DISPLAY are unset)' };
}

interface CodeOptions {
  config: string;
  healthHost: string;
  healthPort: string;
  timeout: string;
  all?: boolean;
  qr?: boolean;
  png?: string;
  svg?: string;
  open?: boolean;
  link?: string;
}

const QR_OPTIONS = { errorCorrectionLevel: 'L', margin: 1 } as const;

export const codeCommand = new Command('code')
  .description('Print the node code the owner\'s phone scans to claim this node (it must be running and waiting to be claimed). The code goes to stdout; everything else to stderr')
  .option('-c, --config <path>', 'Path to config file (YAML or JSON) — where claim.secretFile is read', 'cadre.yaml')
  .option('--health-host <host>', 'Host of the running node\'s health server', 'localhost')
  .option('--health-port <port>', 'Port of the running node\'s health server (env: CADRE_HEALTH_PORT)', '8080')
  .option('--timeout <ms>', 'Status query timeout in milliseconds', '2000')
  .option('--all', 'Include every address the node reports: TCP (phones cannot dial it) and private addresses on interfaces other than the main LAN one (Docker bridges, VPNs)')
  .option('--qr', 'Also show the code as a QR code in the terminal')
  .option('--png <file>', 'Also write the QR code as a PNG image (mode 600: it carries the secret)')
  .option('--svg <file>', 'Also write the QR code as an SVG image (mode 600)')
  .option('--open', 'Open the QR image in the desktop\'s viewer (macOS, Windows, Linux with a display); writes a temporary PNG when neither --png nor --svg is given')
  .option('--link <url>', 'Print a link carrying the code in its fragment, <url>#sereus-join:1.…, and encode that in the QR code')
  .action(async (options: CodeOptions) => {
    try {
      const secret = await claimSecretFor(options.config);
      const port = parseInt(commandEnv('CADRE_HEALTH_PORT') ?? options.healthPort, 10);
      const timeoutMs = parseInt(options.timeout, 10);
      const runtime = await queryRuntime(fetch, `http://${options.healthHost}:${port}/status`, Number.isFinite(timeoutMs) ? timeoutMs : 2000);
      if (!runtime.reachable) {
        console.error(`✗ No node answered at ${runtime.url} (${runtime.reason}). Start it with 'cadre start', or pass --health-port.`);
        process.exit(EXIT_UNREACHABLE);
      }
      const { status } = runtime;
      const claim = status.node.claim;
      if (claim === 'claimed') {
        throw new Error(`This node is already claimed${status.node.claimedBy ? ` by owner ${status.node.claimedBy.slice(0, 8)}` : ''} into cadre ${status.node.partyId}; its code no longer claims it.`);
      }
      if (claim !== 'awaiting') {
        throw new Error('The running node was started without a claim secret, so nothing can claim it. Start it with claim.secretFile (cadre init writes one) or CADRE_CLAIM_SECRET.');
      }
      const peerId = status.node.peerId ?? status.peerId;
      if (!peerId) throw new Error('The node has not reported its peer id yet; try again in a moment.');

      const multiaddrs = selectClaimAddresses(status.multiaddrs, peerId, options.all, options.all ? undefined : await primaryLocalIp());
      if (multiaddrs.length === 0) {
        throw new Error(`The node reports no address a phone can dial (${options.all ? 'none at all' : 'no /ws, /wss or relay address'}). `
          + 'Add a WebSocket listener (/ip4/0.0.0.0/tcp/<port>/ws, or cadre start --ws-port).');
      }
      const code = encodeNodeClaimPayload({ peerId, multiaddrs, secret });
      const text = options.link ? nodeCodeLink(options.link, code) : code;

      console.error(`Node ${peerId}, waiting to be claimed, reachable at:`);
      for (const addr of multiaddrs) console.error(`  ${addr}`);
      if (!multiaddrs.some((addr) => DNS.test(addr))) {
        console.error('  (no public DNS name: a phone away from home may not reach these; see network.appendAnnounceAddrs)');
      }
      console.error('Whoever uses this code first owns the node. Show it only to the phone that should claim it.');
      if (options.qr) console.error(await QRCode.toString(text, { ...QR_OPTIONS, type: 'terminal', small: true }));
      await writeImages(text, options);
      console.log(text);
    } catch (err) {
      console.error(`✗ ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

/** The claim secret, from CADRE_CLAIM_SECRET or the config's claim.secretFile; the config may be absent when the env names it. */
async function claimSecretFor(configPath: string): Promise<string> {
  const envSecret = specifiedEnv(commandEnv('CADRE_CLAIM_SECRET'));
  let secretFile: string | undefined;
  if (fs.existsSync(path.resolve(configPath))) {
    const config = await loadValidatedConfig(configPath);
    secretFile = config.claim?.secretFile ? path.resolve(config.claim.secretFile) : undefined;
  } else if (envSecret === undefined) {
    throw new Error(`Config file not found: ${path.resolve(configPath)} (it names the claim secret file; or set CADRE_CLAIM_SECRET)`);
  }
  const { secret, warnings } = resolveClaimSecret(envSecret, secretFile);
  for (const warning of warnings) console.error(`⚠ ${warning}`);
  if (secret === undefined) {
    throw new Error(`${configPath} names no claim.secretFile and CADRE_CLAIM_SECRET is unset, so there is no secret to put in the code.`);
  }
  return secret;
}

/** Write the --png / --svg images (private: they carry the secret) and --open one of them. */
async function writeImages(text: string, options: CodeOptions): Promise<void> {
  const written: string[] = [];
  for (const [type, file] of [['png', options.png], ['svg', options.svg]] as const) {
    if (!file) continue;
    await writeQrImage(file, type, text);
    written.push(file);
    console.error(`QR code written to ${file}`);
  }
  if (!options.open) return;
  const opener = openerFor(process.platform, process.env);
  if ('none' in opener) {
    console.error(`(not opening an image: ${opener.none}${written.length > 0 ? `; copy ${written[0]} to a machine with a screen` : '; use --qr, or --png <file> and copy it to a machine with a screen'})`);
    return;
  }
  let file = written[0];
  if (!file) {
    file = path.join(os.tmpdir(), `cadre-node-code-${process.pid}.png`);
    await writeQrImage(file, 'png', text);
    console.error(`QR code written to ${file} (delete it once the node is claimed)`);
  }
  const child = spawn(opener.command, opener.args(file), { detached: true, stdio: 'ignore' });
  child.on('error', (err) => console.error(`(could not open ${file}: ${err.message})`));
  child.unref();
}

async function writeQrImage(file: string, type: 'png' | 'svg', text: string): Promise<void> {
  if (type === 'png') {
    await QRCode.toFile(file, text, { ...QR_OPTIONS, type: 'png', width: 512 });
  } else {
    fs.writeFileSync(file, await QRCode.toString(text, { ...QR_OPTIONS, type: 'svg' }));
  }
  fs.chmodSync(file, 0o600);
}
