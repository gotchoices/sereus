import { describe, expect, it } from 'vitest';

import { defaultDataDir, serviceInstallPath } from '../paths.js';

describe('defaultDataDir', () => {
  it('honors XDG_DATA_HOME on linux', () => {
    expect(defaultDataDir('linux', { XDG_DATA_HOME: '/tmp/xdg', HOME: '/home/me' }, '/home/me'))
      .toBe('/tmp/xdg/cadre-host');
  });

  it('falls back to ~/.local/share on linux', () => {
    expect(defaultDataDir('linux', { HOME: '/home/me' }, '/home/me'))
      .toBe('/home/me/.local/share/cadre-host');
  });

  it('uses Application Support on darwin', () => {
    expect(defaultDataDir('darwin', { HOME: '/Users/me' }, '/Users/me'))
      .toBe('/Users/me/Library/Application Support/CadreHost');
  });

  it('uses LocalAppData on win32', () => {
    expect(defaultDataDir('win32', { LocalAppData: 'C:\\Users\\me\\AppData\\Local' }, 'C:\\Users\\me'))
      .toBe('C:\\Users\\me\\AppData\\Local\\CadreHost');
  });

  it('falls back to ~/AppData/Local on win32 without LocalAppData', () => {
    expect(defaultDataDir('win32', {}, 'C:\\Users\\me'))
      .toBe('C:\\Users\\me\\AppData\\Local\\CadreHost');
  });
});

describe('serviceInstallPath', () => {
  it('honors XDG_CONFIG_HOME on linux', () => {
    expect(serviceInstallPath('linux', { XDG_CONFIG_HOME: '/tmp/cfg', HOME: '/home/me' }, '/home/me'))
      .toBe('/tmp/cfg/systemd/user/cadre-host.service');
  });

  it('uses LaunchAgents on darwin', () => {
    expect(serviceInstallPath('darwin', { HOME: '/Users/me' }, '/Users/me'))
      .toBe('/Users/me/Library/LaunchAgents/com.serfab.cadre-host.plist');
  });

  it('returns a registry-style path on win32 (for logging only)', () => {
    expect(serviceInstallPath('win32', {}, 'C:\\Users\\me'))
      .toMatch(/CadreHost/);
  });
});
