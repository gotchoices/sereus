import { describe, expect, it } from 'vitest';

import { applyUpdate, buildNpmSpawnSpec, quoteWindowsArg, type NpmExecutor, type NpmResult } from '../apply.js';
import { UpdateErrorException } from '../types.js';

function recordingExecutor(responses: NpmResult[]): { exec: NpmExecutor; calls: string[][] } {
  const calls: string[][] = [];
  let i = 0;
  return {
    calls,
    async exec(args) {
      calls.push(args);
      const res = responses[i++] ?? { exitCode: 0, stdout: '', stderr: '' };
      return res;
    },
  };
}

describe('applyUpdate', () => {
  it('happy path: install succeeds, restart called', async () => {
    const { exec, calls } = recordingExecutor([{ exitCode: 0, stdout: 'ok', stderr: '' }]);
    let restartCount = 0;
    const result = await applyUpdate({
      npmPackage: '@serfab/cadre-host',
      fromVersion: '0.6.0',
      toVersion: '0.7.0',
      npmExecutor: exec,
      restart: async () => { restartCount++; return undefined; },
    });
    expect(calls).toEqual([['install', '-g', '@serfab/cadre-host@0.7.0']]);
    expect(restartCount).toBe(1);
    expect(result).toMatchObject({ fromVersion: '0.6.0', toVersion: '0.7.0', restarted: true });
  });

  it('install succeeds but restart fails: result reports restartError, no throw', async () => {
    const { exec } = recordingExecutor([{ exitCode: 0, stdout: 'ok', stderr: '' }]);
    const result = await applyUpdate({
      npmPackage: '@serfab/cadre-host',
      fromVersion: '0.6.0',
      toVersion: '0.7.0',
      npmExecutor: exec,
      restart: async () => 'systemctl returned 1',
    });
    expect(result.restarted).toBe(false);
    expect(result.restartError).toBe('systemctl returned 1');
  });

  it('install fails: rollback invoked, restart NOT called, throws apply_failed', async () => {
    const { exec, calls } = recordingExecutor([
      { exitCode: 1, stdout: '', stderr: 'EACCES' },
      { exitCode: 0, stdout: 'rolled back', stderr: '' },
    ]);
    let restartCount = 0;
    await expect(applyUpdate({
      npmPackage: '@serfab/cadre-host',
      fromVersion: '0.6.0',
      toVersion: '0.7.0',
      npmExecutor: exec,
      restart: async () => { restartCount++; return undefined; },
    })).rejects.toBeInstanceOf(UpdateErrorException);
    expect(calls).toEqual([
      ['install', '-g', '@serfab/cadre-host@0.7.0'],
      ['install', '-g', '@serfab/cadre-host@0.6.0'],
    ]);
    expect(restartCount).toBe(0);
  });

  it('install fails and rollback also fails: throws rollback_failed', async () => {
    const { exec } = recordingExecutor([
      { exitCode: 1, stdout: '', stderr: 'EACCES' },
      { exitCode: 1, stdout: '', stderr: 'EACCES on rollback' },
    ]);
    await expect(applyUpdate({
      npmPackage: '@serfab/cadre-host',
      fromVersion: '0.6.0',
      toVersion: '0.7.0',
      npmExecutor: exec,
    })).rejects.toMatchObject({ code: 'rollback_failed' });
  });

  it('install throws (spawn error): rollback still attempted', async () => {
    let i = 0;
    const calls: string[][] = [];
    const exec: NpmExecutor = async (args) => {
      calls.push(args);
      i++;
      if (i === 1) throw new Error('ENOENT npm');
      return { exitCode: 0, stdout: '', stderr: '' };
    };
    await expect(applyUpdate({
      npmPackage: '@serfab/cadre-host',
      fromVersion: '0.6.0',
      toVersion: '0.7.0',
      npmExecutor: exec,
    })).rejects.toMatchObject({ code: 'apply_failed' });
    expect(calls).toEqual([
      ['install', '-g', '@serfab/cadre-host@0.7.0'],
      ['install', '-g', '@serfab/cadre-host@0.6.0'],
    ]);
  });
});

describe('quoteWindowsArg', () => {
  it('leaves safe args untouched', () => {
    expect(quoteWindowsArg('install')).toBe('install');
    expect(quoteWindowsArg('-g')).toBe('-g');
    expect(quoteWindowsArg('@serfab/cadre-host@0.7.0')).toBe('@serfab/cadre-host@0.7.0');
  });

  it('quotes args containing whitespace or shell metachars', () => {
    expect(quoteWindowsArg('has space')).toBe('"has space"');
    expect(quoteWindowsArg('with&amp')).toBe('"with&amp"');
    expect(quoteWindowsArg('pipe|me')).toBe('"pipe|me"');
  });

  it('escapes embedded quotes and trailing backslashes', () => {
    expect(quoteWindowsArg('with"quote')).toBe('"with\\"quote"');
    expect(quoteWindowsArg('trailing\\')).toBe('trailing\\');
    expect(quoteWindowsArg('trail ing\\')).toBe('"trail ing\\\\"');
  });

  it('rejects control characters', () => {
    expect(() => quoteWindowsArg('bad\nnewline')).toThrow(/control character/);
    expect(() => quoteWindowsArg('bad\x00null')).toThrow(/control character/);
  });
});

describe('buildNpmSpawnSpec', () => {
  it('builds a single-string command with empty args on Windows', () => {
    const original = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    try {
      const spec = buildNpmSpawnSpec(['install', '-g', '@serfab/cadre-host@0.7.0']);
      expect(spec).toEqual({
        command: 'npm install -g @serfab/cadre-host@0.7.0',
        args: [],
        shell: true,
      });
    } finally {
      Object.defineProperty(process, 'platform', { value: original, configurable: true });
    }
  });

  it('passes args through verbatim on posix (no shell)', () => {
    const original = process.platform;
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    try {
      const spec = buildNpmSpawnSpec(['install', '-g', '@serfab/cadre-host@0.7.0']);
      expect(spec).toEqual({
        command: 'npm',
        args: ['install', '-g', '@serfab/cadre-host@0.7.0'],
        shell: false,
      });
    } finally {
      Object.defineProperty(process, 'platform', { value: original, configurable: true });
    }
  });
});
