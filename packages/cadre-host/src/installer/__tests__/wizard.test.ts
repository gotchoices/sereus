import { describe, expect, it } from 'vitest';

import { runWizardWith, type WizardDefaults } from '../wizard.js';

const defaults: WizardDefaults = {
  dataDir: '/data/cadre-host',
  uiPort: 8765,
  upnpEnabled: true,
};

function scripted(answers: ReadonlyArray<string>): (label: string, fallback: string) => Promise<string> {
  let i = 0;
  return async (_label, _fallback) => {
    if (i >= answers.length) throw new Error(`wizard asked more questions than scripted (i=${i})`);
    return answers[i++]!;
  };
}

describe('runWizardWith', () => {
  it('returns the defaults when every answer is blank', async () => {
    const out = await runWizardWith(defaults, scripted(['', '', '', '']));
    expect(out).toEqual({
      dataDir: '/data/cadre-host',
      uiPort: 8765,
      upnpEnabled: true,
    });
  });

  it('respects overrides', async () => {
    const out = await runWizardWith(defaults, scripted([
      '/srv/host',
      '9000',
      'n',
      'y',
    ]));
    expect(out).toEqual({
      dataDir: '/srv/host',
      uiPort: 9000,
      upnpEnabled: false,
    });
  });

  it('rejects invalid port input', async () => {
    await expect(
      runWizardWith(defaults, scripted(['', 'banana', '', ''])),
    ).rejects.toThrow(/Invalid port/);
  });

  it('asks nothing a flag already answered', async () => {
    const asked: string[] = [];
    const out = await runWizardWith(
      { ...defaults, dataDir: '/srv/host', uiPort: 9000, upnpEnabled: false, given: { dataDir: true, uiPort: true, upnpEnabled: true } },
      async (label) => { asked.push(label); return ''; },
    );
    expect(asked).toEqual([]);
    expect(out).toEqual({ dataDir: '/srv/host', uiPort: 9000, upnpEnabled: false });
  });

  it('does not ask about UPnP on a machine with a public IP, and says why', async () => {
    const asked: string[] = [];
    const said: string[] = [];
    await runWizardWith(
      { ...defaults, given: { dataDir: true }, publicInterfaceIp: '203.0.113.7' },
      async (label) => { asked.push(label); return ''; },
      (line) => said.push(line),
    );
    expect(asked).toEqual(['UI port (localhost only)']);
    expect(said.join(' ')).toMatch(/public IP address \(203\.0\.113\.7\).*no UPnP/);
  });

  it('rejects unrecognized yes/no answers', async () => {
    await expect(
      runWizardWith(defaults, scripted(['', '', 'maybe', ''])),
    ).rejects.toThrow(/Invalid yes\/no/);
  });
});
