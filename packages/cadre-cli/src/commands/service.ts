import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command, InvalidArgumentError } from 'commander';

/** Which service manager the unit is for. */
export type ServiceKind = 'systemd-user' | 'systemd-system' | 'launchd';

export interface ServiceSpec {
  kind: ServiceKind;
  /** Service name: the unit is `<name>.service`, the launchd label `org.sereus.<name>`. */
  name: string;
  /** Absolute path of the node binary to run (`process.execPath`). */
  nodePath: string;
  /** Absolute path of `dist/bin/cadre.js`. */
  cadreJs: string;
  /** Absolute path of the node's config file. */
  configPath: string;
  /** The node's folder: the working directory, and where launchd writes its logs. */
  workdir: string;
  /** Run as this account (`systemd-system` only; user units and launch agents run as their owner). When absent, systemd runs it as root. */
  user?: string;
  /** Extra `cadre start` arguments, such as `--health-port 8081`. */
  startArgs?: string[];
}

/**
 * The unit (or launchd plist) that runs `cadre start` for one node folder at boot and restarts it
 * when it exits. The node needs no environment: `cadre init` keeps the claim secret in the file
 * the config names (`claim.secretFile`), and every path here is absolute.
 */
export function renderService(spec: ServiceSpec): string {
  assertServiceName(spec.name);
  const argv = [spec.nodePath, spec.cadreJs, 'start', '-c', spec.configPath, ...(spec.startArgs ?? [])];
  return spec.kind === 'launchd' ? renderLaunchd(spec, argv) : renderSystemd(spec, argv);
}

/**
 * The name becomes a unit file name, a launchd label, log file names and words in the printed
 * shell commands, so it is held to characters that are safe in all of them (no `@`: that would
 * make a systemd template unit).
 */
function assertServiceName(name: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
    throw new Error(`--name '${name}' must start with a letter or digit and hold only letters, digits, '.', '_' and '-'.`);
  }
}

function renderSystemd(spec: ServiceSpec, argv: string[]): string {
  const system = spec.kind === 'systemd-system';
  for (const value of [spec.workdir, ...argv]) assertSystemdLine(value);
  return [
    '[Unit]',
    `Description=Sereus cadre node (${systemdSpecifierEscape(spec.workdir)})`,
    // A user manager has no network-online.target to wait for; a system unit does.
    ...(system ? ['After=network-online.target', 'Wants=network-online.target'] : []),
    '',
    '[Service]',
    'Type=simple',
    ...(system && spec.user ? [`User=${systemdSpecifierEscape(spec.user)}`] : []),
    // WorkingDirectory= takes the rest of the line as the path: quotes would be part of it.
    `WorkingDirectory=${systemdSpecifierEscape(spec.workdir)}`,
    `ExecStart=${argv.map(systemdExecWord).join(' ')}`,
    'Restart=on-failure',
    'RestartSec=10',
    'Environment=NODE_ENV=production',
    // The node folder may sit anywhere the account can write (home, /tmp), so the file system is
    // left as the account sees it: no ProtectHome=, ProtectSystem= or PrivateTmp=, which also need
    // namespaces a user manager may lack. contrib/cadre-node.service is the sandboxed layout.
    'NoNewPrivileges=true',
    '',
    '[Install]',
    `WantedBy=${system ? 'multi-user.target' : 'default.target'}`,
    '',
  ].join('\n');
}

/** A unit file setting is one line: a control character (a newline above all) cannot be written into it. */
function assertSystemdLine(value: string): void {
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(value)) {
    throw new Error(`cannot write ${JSON.stringify(value)} into a systemd unit: it holds a control character.`);
  }
}

/** systemd expands `%` specifiers in every setting this writes; `%%` is a literal `%`. */
function systemdSpecifierEscape(value: string): string {
  return value.replace(/%/g, '%%');
}

/**
 * One ExecStart word, taken literally: specifiers and `$` variable references doubled, and the
 * word quoted (with C escapes) when it holds whitespace, quotes or backslashes, since systemd
 * splits ExecStart on whitespace.
 */
function systemdExecWord(word: string): string {
  const literal = systemdSpecifierEscape(word).replace(/\$/g, '$$$$');
  return /[\s"'\\]/.test(literal) ? `"${literal.replace(/[\\"]/g, '\\$&')}"` : literal;
}

function renderLaunchd(spec: ServiceSpec, argv: string[]): string {
  const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  // launchd is macOS-only: POSIX joins, whatever platform renders the plist.
  const log = (stream: string) => xml(path.posix.join(spec.workdir, `${spec.name}.${stream}.log`));
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    `  <key>Label</key><string>${xml(launchdLabel(spec.name))}</string>`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    ...argv.map((a) => `    <string>${xml(a)}</string>`),
    '  </array>',
    `  <key>WorkingDirectory</key><string>${xml(spec.workdir)}</string>`,
    '  <key>RunAtLoad</key><true/>',
    '  <key>KeepAlive</key><true/>',
    `  <key>StandardOutPath</key><string>${log('out')}</string>`,
    `  <key>StandardErrorPath</key><string>${log('err')}</string>`,
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

export function launchdLabel(name: string): string {
  return `org.sereus.${name}`;
}

/** The commands that install, start and follow the unit `cadre service` printed, one per line. */
export function installSteps(kind: ServiceKind, name: string, invocation: string): string[] {
  assertServiceName(name);
  switch (kind) {
    case 'systemd-user':
      return [
        'mkdir -p ~/.config/systemd/user',
        `${invocation} > ~/.config/systemd/user/${name}.service`,
        `systemctl --user daemon-reload && systemctl --user enable --now ${name}`,
        'sudo loginctl enable-linger $USER     # start at boot and keep running after you log out',
        `journalctl --user -u ${name} -f        # follow the log`,
      ];
    case 'systemd-system':
      return [
        `${invocation} | sudo tee /etc/systemd/system/${name}.service >/dev/null`,
        `sudo systemctl daemon-reload && sudo systemctl enable --now ${name}`,
        `journalctl -u ${name} -f               # follow the log`,
      ];
    case 'launchd': {
      const plist = `~/Library/LaunchAgents/${launchdLabel(name)}.plist`;
      return [
        `${invocation} > ${plist}`,
        // NOTE: `load -w` is the legacy launchctl form (bootstrap gui/$UID is the current one); if a
        // macOS release drops it, switch to bootstrap + enable.
        `launchctl load -w ${plist}`,
        `tail -f ${name}.out.log ${name}.err.log    # follow the log (in the node folder)`,
      ];
    }
  }
}

/** `dist/bin/cadre.js`, from this module's own location (`dist/commands/`). */
function cadreJsPath(): string {
  return fileURLToPath(new URL('../bin/cadre.js', import.meta.url));
}

function defaultKind(system: boolean | undefined): ServiceKind {
  if (process.platform === 'darwin') return 'launchd';
  if (process.platform === 'win32') {
    throw new Error('cadre service writes systemd units (Linux) and launchd agents (macOS); on Windows, run cadre start under a service wrapper such as NSSM.');
  }
  return system ? 'systemd-system' : 'systemd-user';
}

/** A port passed through to `cadre start`, checked here so nothing else reaches the unit or the printed commands. */
function parsePort(value: string): string {
  const port = Number(value);
  if (!/^\d+$/.test(value) || port < 1 || port > 65535) throw new InvalidArgumentError('expected a port number from 1 to 65535.');
  return value;
}

/** A word for the printed POSIX shell commands: single-quoted unless it is plainly safe. */
function shellWord(word: string): string {
  return /^[\w./-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`;
}

interface ServiceOptions {
  config: string;
  name: string;
  system?: boolean;
  healthPort?: string;
  metricsPort?: string;
}

export const serviceCommand = new Command('service')
  .description('Print a service definition that runs this node at boot (systemd on Linux, launchd on macOS), then how to install it. The definition goes to stdout; the steps to stderr')
  .option('-c, --config <path>', 'Path to the node\'s config file', 'cadre.yaml')
  .option('--name <name>', 'Service name: letters, digits, \'.\', \'_\' and \'-\'', 'cadre-node')
  .option('--system', 'Linux: a system unit run as you (installed with sudo; no linger needed) instead of a user unit')
  .option('--health-port <port>', 'Pass --health-port to cadre start', parsePort)
  .option('--metrics-port <port>', 'Pass --metrics-port to cadre start', parsePort)
  .action((options: ServiceOptions) => {
    try {
      const kind = defaultKind(options.system);
      const configPath = path.resolve(options.config);
      const startArgs = [
        ...(options.healthPort ? ['--health-port', options.healthPort] : []),
        ...(options.metricsPort ? ['--metrics-port', options.metricsPort] : []),
      ];
      process.stdout.write(renderService({
        kind,
        name: options.name,
        nodePath: process.execPath,
        cadreJs: cadreJsPath(),
        configPath,
        workdir: path.dirname(configPath),
        // os.userInfo() throws for an account with no passwd entry; only a system unit needs it.
        user: kind === 'systemd-system' ? os.userInfo().username : undefined,
        startArgs,
      }));
      // The steps run from the node folder, so a config named relative to here is passed absolute.
      const flags = [
        ...(options.config !== 'cadre.yaml' ? [`-c ${shellWord(configPath)}`] : []),
        ...(options.name !== 'cadre-node' ? [`--name ${options.name}`] : []),
        ...(options.system ? ['--system'] : []),
        ...(options.healthPort ? [`--health-port ${options.healthPort}`] : []),
        ...(options.metricsPort ? [`--metrics-port ${options.metricsPort}`] : []),
      ];
      const invocation = ['npx cadre service', ...flags].join(' ');
      console.error('');
      console.error(`To run this node as a service (stop any copy running in a terminal or tmux first), from ${path.dirname(configPath)}:`);
      for (const step of installSteps(kind, options.name, invocation)) console.error(`  ${step}`);
    } catch (err) {
      console.error(`✗ ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });
