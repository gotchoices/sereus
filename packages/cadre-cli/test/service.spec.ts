import { describe, it, expect } from 'vitest';
import { installSteps, renderService, type ServiceSpec } from '../src/commands/service.js';

/**
 * `cadre service`: the unit runs `cadre start` for one node folder at boot, with absolute paths
 * and no environment (the claim secret lives in the file the config names).
 */
const SPEC: ServiceSpec = {
  kind: 'systemd-user',
  name: 'cadre-node',
  nodePath: '/usr/bin/node',
  cadreJs: '/opt/cadre/node_modules/@serfab/cadre-cli/dist/bin/cadre.js',
  configPath: '/opt/cadre/cadre.yaml',
  workdir: '/opt/cadre',
  user: 'kyle',
};

describe('renderService', () => {
  it('writes a user unit: no User=, no network-online wait, wanted by default.target', () => {
    const unit = renderService(SPEC);
    expect(unit).toContain('ExecStart=/usr/bin/node /opt/cadre/node_modules/@serfab/cadre-cli/dist/bin/cadre.js start -c /opt/cadre/cadre.yaml');
    expect(unit).toContain('WorkingDirectory=/opt/cadre');
    expect(unit).toContain('Restart=on-failure');
    expect(unit).toContain('WantedBy=default.target');
    expect(unit).not.toContain('User=');
    expect(unit).not.toContain('network-online');
  });

  it('writes a system unit run as the user, after the network is up', () => {
    const unit = renderService({ ...SPEC, kind: 'systemd-system', startArgs: ['--health-port', '8081'] });
    expect(unit).toContain('User=kyle');
    expect(unit).toContain('After=network-online.target');
    expect(unit).toContain('WantedBy=multi-user.target');
    expect(unit).toMatch(/ExecStart=.* start -c \/opt\/cadre\/cadre\.yaml --health-port 8081$/m);
  });

  it('quotes paths with spaces for systemd', () => {
    const unit = renderService({ ...SPEC, configPath: '/home/k/my node/cadre.yaml', workdir: '/home/k/my node' });
    expect(unit).toContain('WorkingDirectory="/home/k/my node"');
    expect(unit).toContain('start -c "/home/k/my node/cadre.yaml"');
  });

  it('writes a launchd agent that runs at load, is kept alive, and logs into the node folder', () => {
    const plist = renderService({ ...SPEC, kind: 'launchd', workdir: '/Users/k/a&b', configPath: '/Users/k/a&b/cadre.yaml' });
    expect(plist).toContain('<key>Label</key><string>org.sereus.cadre-node</string>');
    expect(plist).toContain('<string>/Users/k/a&amp;b/cadre.yaml</string>');
    expect(plist).toContain('<key>RunAtLoad</key><true/>');
    expect(plist).toContain('<key>KeepAlive</key><true/>');
    expect(plist).toContain('<string>/Users/k/a&amp;b/cadre-node.err.log</string>');
  });
});

describe('installSteps', () => {
  it('user units need linger to start at boot; system units need sudo instead', () => {
    expect(installSteps('systemd-user', 'cadre-node', 'npx cadre service').join('\n')).toMatch(/enable-linger/);
    const system = installSteps('systemd-system', 'cadre-node', 'npx cadre service --system').join('\n');
    expect(system).toContain('sudo tee /etc/systemd/system/cadre-node.service');
    expect(system).not.toMatch(/linger/);
  });
});
