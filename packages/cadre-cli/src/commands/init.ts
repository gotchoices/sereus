import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { Command } from 'commander';
import yaml from 'js-yaml';
import { multiaddr } from '@multiformats/multiaddr';
import { CLAIM_SECRET_BYTES, EnrollmentService } from '@serfab/cadre-core';
import type { CliConfigFile } from '../config/types.js';

/** The files `cadre init` writes, by name inside the node's directory. */
export const INIT_FILES = {
  config: 'cadre.yaml',
  key: 'cadre-peer.key',
  id: 'cadre-peer.id',
  secret: 'claim.secret',
} as const;

const DEFAULT_TCP_PORT = 4001;
const DEFAULT_WS_PORT = 4002;

export interface InitOptions {
  /** The node's directory; created when missing. */
  dir: string;
  /** libp2p TCP port (servers and desktop peers). */
  port?: number;
  /** libp2p WebSocket port: the one a phone dials, so the one to forward through a router. */
  wsPort?: number;
  /**
   * Public addresses phones reach this node at, each `host`, `host:port` or a full multiaddr.
   * `host[:port]` becomes `/dns4|ip4|ip6/<host>/tcp/<port or wsPort>/ws`; a multiaddr (for a
   * `/wss` address behind a TLS proxy, say) is taken as written.
   */
  publicAddrs?: string[];
}

export interface InitResult {
  dir: string;
  peerId: string;
  files: { config: string; key: string; id: string; secret: string };
  appendAnnounceAddrs: string[];
  /** Scripts added to an existing package.json in `dir`. */
  scriptsAdded: string[];
}

/**
 * Turn one `--public` entry into the WebSocket multiaddr a phone dials (no `/p2p/` suffix; the
 * node appends its peer id when it announces). Throws, naming the entry, on a malformed one.
 */
export function publicMultiaddr(spec: string, defaultPort: number): string {
  const trimmed = spec.trim();
  if (trimmed.startsWith('/')) {
    try {
      multiaddr(trimmed);
    } catch (err) {
      throw new Error(`--public ${trimmed} is not a valid multiaddr: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
    }
    return trimmed;
  }
  const match = /^(?:\[(?<v6>[^\]]+)\]|(?<host>[^:\s]+))(?::(?<port>\d+))?$/.exec(trimmed);
  const host = match?.groups?.v6 ?? match?.groups?.host;
  if (!host) {
    throw new Error(`--public ${trimmed} must be host, host:port, [ipv6]:port or a multiaddr starting with /`);
  }
  const port = match?.groups?.port ? Number(match.groups.port) : defaultPort;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`--public ${trimmed} names port ${port}, which is outside 1-65535`);
  }
  const family = net.isIP(host);
  const proto = family === 4 ? 'ip4' : family === 6 ? 'ip6' : 'dns4';
  return `/${proto}/${host}/tcp/${port}/ws`;
}

/** The config `cadre init` writes: absolute paths, waiting to be claimed, TCP plus a WebSocket listener. */
export function initConfig(dir: string, tcpPort: number, wsPort: number, appendAnnounceAddrs: string[]): CliConfigFile {
  return {
    identity: { keyFile: path.join(dir, INIT_FILES.key) },
    controlNetwork: { partyId: 'unclaimed', bootstrapNodes: [] },
    profile: 'storage',
    claim: { secretFile: path.join(dir, INIT_FILES.secret) },
    nodeState: { dir: path.join(dir, 'state') },
    storage: { type: 'file', path: path.join(dir, 'data') },
    network: {
      listenAddrs: [`/ip4/0.0.0.0/tcp/${tcpPort}`, `/ip4/0.0.0.0/tcp/${wsPort}/ws`],
      ...(appendAnnounceAddrs.length > 0 ? { appendAnnounceAddrs } : {}),
    },
  };
}

const CONFIG_HEADER = `# Written by 'cadre init'. This node is waiting to be claimed: 'cadre start' runs it,
# 'cadre code' prints the code the owner's phone scans to claim it. After the claim the
# node serves the phone's cadre; partyId stays the placeholder (the claim record names the party).
`;

/**
 * Set up a node directory that waits to be claimed: identity key, claim secret, config, and
 * empty `state/` and `data/`. Refuses, writing nothing, when any of the files already exists:
 * the key is the node's identity and the secret its one-time claim, and replacing either
 * silently would orphan a node already claimed.
 */
export async function initNode(options: InitOptions): Promise<InitResult> {
  const dir = path.resolve(options.dir);
  const tcpPort = options.port ?? DEFAULT_TCP_PORT;
  const wsPort = options.wsPort ?? DEFAULT_WS_PORT;
  for (const [name, port] of [['--port', tcpPort], ['--ws-port', wsPort]] as const) {
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`${name} ${port} is outside 1-65535`);
  }
  if (tcpPort === wsPort) throw new Error(`--port and --ws-port must differ (both ${tcpPort})`);
  const appendAnnounceAddrs = (options.publicAddrs ?? []).map((spec) => publicMultiaddr(spec, wsPort));

  const files = {
    config: path.join(dir, INIT_FILES.config),
    key: path.join(dir, INIT_FILES.key),
    id: path.join(dir, INIT_FILES.id),
    secret: path.join(dir, INIT_FILES.secret),
  };
  const existing = Object.values(files).filter((file) => fs.existsSync(file));
  if (existing.length > 0) {
    throw new Error(`Refusing to overwrite ${existing.join(', ')}: this directory already holds a node. `
      + 'Its key is the node\'s identity and its secret a one-time claim; move them away first, or init another --dir.');
  }

  fs.mkdirSync(dir, { recursive: true });
  const { peerId, privateKey } = await new EnrollmentService().createCadrePeer();
  writePrivate(files.key, privateKey);
  fs.writeFileSync(files.id, peerId.toString(), 'utf-8');
  writePrivate(files.secret, `${randomBytes(CLAIM_SECRET_BYTES).toString('base64url')}\n`);
  fs.writeFileSync(files.config, CONFIG_HEADER + yaml.dump(initConfig(dir, tcpPort, wsPort, appendAnnounceAddrs)), 'utf-8');
  fs.mkdirSync(path.join(dir, 'state'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });

  return { dir, peerId: peerId.toString(), files, appendAnnounceAddrs, scriptsAdded: addPackageScripts(dir) };
}

/** Write a file only its owner can read (mode 600 from creation, not chmod after). */
function writePrivate(file: string, data: string | Uint8Array): void {
  fs.writeFileSync(file, data, { mode: 0o600 });
  fs.chmodSync(file, 0o600); // an umask may have narrowed the create mode further; never widen past 600
}

/**
 * When `dir` holds a package.json (the usual `npm init -y && npm i @serfab/cadre-cli` folder),
 * add `start` and `code` scripts it lacks, so `npm start` runs the node. Existing scripts are
 * never replaced. Returns the names added.
 */
function addPackageScripts(dir: string): string[] {
  const pkgPath = path.join(dir, 'package.json');
  if (!fs.existsSync(pkgPath)) return [];
  let pkg: { scripts?: Record<string, string> } & Record<string, unknown>;
  try {
    pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
  } catch {
    return [];
  }
  const wanted: Record<string, string> = { start: 'cadre start', code: 'cadre code --qr' };
  const scripts = { ...(pkg.scripts ?? {}) };
  // `npm init -y` writes a placeholder test script; a start script it never writes.
  const added = Object.keys(wanted).filter((name) => scripts[name] === undefined);
  if (added.length === 0) return [];
  for (const name of added) scripts[name] = wanted[name]!;
  fs.writeFileSync(pkgPath, `${JSON.stringify({ ...pkg, scripts }, null, 2)}\n`, 'utf-8');
  return added;
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function parsePort(value: string): number {
  return Number(value);
}

export const initCommand = new Command('init')
  .description('Set up a node that waits to be claimed by its owner\'s phone: identity, claim secret and cadre.yaml in one folder')
  .option('--dir <path>', 'The node\'s folder (created when missing)', '.')
  .option('--port <port>', 'libp2p TCP port', parsePort, DEFAULT_TCP_PORT)
  .option('--ws-port <port>', 'libp2p WebSocket port: the one phones dial, so forward this one through a router', parsePort, DEFAULT_WS_PORT)
  .option('--public <addr>', 'Where phones reach this node from outside: host[:port] (port defaults to --ws-port) or a full multiaddr, e.g. /dns4/node.example.com/tcp/443/wss. Repeatable', collect, [])
  .action(async (options: { dir: string; port: number; wsPort: number; public: string[] }) => {
    try {
      const result = await initNode({ dir: options.dir, port: options.port, wsPort: options.wsPort, publicAddrs: options.public });
      const rel = (file: string) => path.relative(process.cwd(), file) || file;
      console.log('✓ Node set up, waiting to be claimed');
      console.log(`  Peer ID:   ${result.peerId}`);
      console.log(`  Config:    ${rel(result.files.config)}`);
      console.log(`  Identity:  ${rel(result.files.key)}  (back this up; it is the node's identity)`);
      console.log(`  Secret:    ${rel(result.files.secret)}  (one-time claim secret; whoever claims first owns the node)`);
      if (result.appendAnnounceAddrs.length > 0) {
        console.log(`  Public:    ${result.appendAnnounceAddrs.join(', ')}`);
      } else {
        console.log('  Public:    none — phones reach this node on its LAN only (re-run with --public host[:port] to add one)');
      }
      if (result.scriptsAdded.length > 0) console.log(`  package.json: added scripts ${result.scriptsAdded.join(', ')}`);
      console.log('');
      console.log('Next:');
      console.log(`  1. Open TCP ${options.wsPort} (WebSocket, for phones) and ${options.port} to this machine; forward ${options.wsPort} through your router for phones away from home.`);
      const inDir = path.resolve(options.dir) === process.cwd() ? '' : `cd ${rel(result.dir)} && `;
      console.log(`  2. ${inDir}cadre start            (or npm start)`);
      console.log(`  3. ${inDir}cadre code --qr        in another terminal, then scan it with the Sereus app on the phone that owns the cadre`);
    } catch (err) {
      console.error(`✗ ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });
