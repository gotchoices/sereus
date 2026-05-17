import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { LaunchdServiceHost } from '../service-host/launchd.js';
import { SystemdServiceHost } from '../service-host/systemd.js';
import { NssmServiceHost } from '../service-host/nssm.js';
import { renderTemplate } from '../service-host/template.js';
import type { ServiceHostContext } from '../service-host/types.js';

const here = fileURLToPath(new URL('.', import.meta.url));
const serviceDir = resolve(here, '..', '..', '..', 'service');

function ctx(): ServiceHostContext {
  return {
    nodePath: '/usr/local/bin/node',
    hostJs: '/opt/cadre-host/dist/bin/host.js',
    dataDir: '/var/data/cadre-host',
    serviceDir,
  };
}

describe('renderTemplate', () => {
  it('substitutes @TOKEN@ values', () => {
    expect(renderTemplate('@A@ x @B@', { A: 'foo', B: 'bar' })).toBe('foo x bar');
  });

  it('throws on unknown tokens', () => {
    expect(() => renderTemplate('@A@ @MISSING@', { A: 'foo' })).toThrow(/missing value for token @MISSING@/);
  });
});

describe('SystemdServiceHost.renderUnit', () => {
  it('produces an enable-able [Install] section and substitutes ExecStart', () => {
    const unit = new SystemdServiceHost().renderUnit(ctx());
    expect(unit).toContain('[Install]');
    expect(unit).toContain('WantedBy=default.target');
    expect(unit).toContain('ExecStart=/usr/local/bin/node /opt/cadre-host/dist/bin/host.js start --no-tui --data-dir /var/data/cadre-host');
    expect(unit).toContain('RestartPreventExitStatus=0');
  });
});

describe('LaunchdServiceHost.renderUnit', () => {
  it('produces a plist with the substituted ProgramArguments', () => {
    const unit = new LaunchdServiceHost().renderUnit(ctx());
    expect(unit).toContain('<key>Label</key>');
    expect(unit).toContain('<string>com.serfab.cadre-host</string>');
    expect(unit).toContain('<string>/usr/local/bin/node</string>');
    expect(unit).toContain('<string>/opt/cadre-host/dist/bin/host.js</string>');
    expect(unit).toContain('<string>--data-dir</string>');
    expect(unit).toContain('<string>/var/data/cadre-host</string>');
    expect(unit).toContain('<key>KeepAlive</key>');
    expect(unit).toContain('<key>SuccessfulExit</key>');
    expect(unit).toContain('<key>Crashed</key>');
  });
});

describe('NssmServiceHost', () => {
  it('returns null from renderUnit (NSSM stores config in the registry)', () => {
    expect(new NssmServiceHost().renderUnit(ctx())).toBeNull();
  });
});
