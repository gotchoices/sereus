import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Command } from 'commander';
import QRCode from 'qrcode';
import { encodeNodeClaimPayload, selectNodeClaimAddresses } from '@serfab/cadre-core';
import { primaryLanAddress } from '@serfab/cadre-core/primary-lan-address';
import { specifiedEnv } from '@serfab/config-check';
import { loadValidatedConfig } from '../config/loader.js';
import { commandEnv } from '../config/env.js';
import { resolveClaimSecret } from './claim-secret.js';
import { queryRuntime } from './status-query.js';

/** Exit code when no running node answered, as `cadre status` uses. */
const EXIT_UNREACHABLE = 3;

const DNS = /^\/dns/;

/** How `cadre code` chooses addresses: its `--addr`, `--lan` / `--no-lan` and `--all` options. */
export interface ClaimAddressChoice {
  /** An exact list (`--addr`, repeatable), used as given apart from appending `/p2p/<peerId>`. */
  addr?: string[];
  /** `--lan <ip>`: the LAN address to keep; `false` from `--no-lan`: none; otherwise found automatically. */
  lan?: string | boolean;
  /** `--all`: every address the node reports, TCP and every interface included. */
  all?: boolean;
}

/**
 * The addresses `cadre code` puts in the node code: the operator's exact `--addr` list when
 * given, else cadre-core's {@link selectNodeClaimAddresses} over what the node reports, with
 * the LAN address from `--lan`, none for `--no-lan`, or the machine's primary address.
 */
export async function claimAddressesFor(
  reported: readonly string[],
  peerId: string,
  choice: ClaimAddressChoice,
  detectLan: () => Promise<string | undefined> = primaryLanAddress,
): Promise<string[]> {
  if (choice.addr && choice.addr.length > 0) {
    return [...new Set(choice.addr.map((a) => (a.trim().includes('/p2p/') ? a.trim() : `${a.trim()}/p2p/${peerId}`)))];
  }
  if (choice.all) return selectNodeClaimAddresses(reported, peerId, { includeTcp: true });
  const lan = choice.lan === false ? null : typeof choice.lan === 'string' ? choice.lan : await detectLan();
  return selectNodeClaimAddresses(reported, peerId, { lan });
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
  addr?: string[];
  lan?: string | boolean;
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
  .option('--lan <ip>', 'The LAN address phones at home use (default: the machine\'s primary address); other private addresses, such as Docker bridges and VPNs, are left out')
  .option('--no-lan', 'Leave every LAN address out: phones reach this node by its public name only')
  .option('--addr <multiaddr>', 'Put exactly these addresses in the code, in this order (repeatable); /p2p/<peer id> is appended when missing', (value: string, previous: string[]) => [...previous, value], [] as string[])
  .option('--all', 'Include every address the node reports: TCP (phones cannot dial it) and every interface')
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

      const multiaddrs = await claimAddressesFor(status.multiaddrs, peerId, options);
      if (multiaddrs.length === 0) {
        throw new Error('The node reports no address a phone can dial (no /ws, /wss or relay address after --lan/--no-lan). '
          + 'Add a WebSocket listener (/ip4/0.0.0.0/tcp/<port>/ws, or cadre start --ws-port), or name addresses with --addr.');
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
