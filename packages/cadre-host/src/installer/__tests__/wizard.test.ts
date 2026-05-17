import { describe, expect, it } from 'vitest';

import { runWizardWith, type WizardDefaults } from '../wizard.js';

const defaults: WizardDefaults = {
  dataDir: '/data/cadre-host',
  uiPort: 8765,
  libp2pPort: 4001,
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
    const out = await runWizardWith(defaults, scripted(['', '', '', '', '']));
    expect(out).toEqual({
      dataDir: '/data/cadre-host',
      uiPort: 8765,
      libp2pPort: 4001,
      upnpEnabled: true,
      configureDdns: false,
    });
  });

  it('respects overrides', async () => {
    const out = await runWizardWith(defaults, scripted([
      '/srv/host',
      '9000',
      '5000',
      'n',
      'y',
    ]));
    expect(out).toEqual({
      dataDir: '/srv/host',
      uiPort: 9000,
      libp2pPort: 5000,
      upnpEnabled: false,
      configureDdns: true,
    });
  });

  it('rejects invalid port input', async () => {
    await expect(
      runWizardWith(defaults, scripted(['', 'banana', '', '', ''])),
    ).rejects.toThrow(/Invalid port/);
  });

  it('rejects unrecognized yes/no answers', async () => {
    await expect(
      runWizardWith(defaults, scripted(['', '', '', 'maybe', ''])),
    ).rejects.toThrow(/Invalid yes\/no/);
  });
});
