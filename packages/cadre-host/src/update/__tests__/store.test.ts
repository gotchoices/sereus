import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { UpdateStateStore } from '../store.js';
import type { UpdateState } from '../types.js';

describe('UpdateStateStore', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'cadre-update-store-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('returns an empty state when the file is missing', () => {
    const store = new UpdateStateStore(tmp);
    expect(store.load()).toEqual({ version: 1 });
  });

  it('round-trips a populated state', () => {
    const store = new UpdateStateStore(tmp);
    const state: UpdateState = {
      version: 1,
      lastChecked: '2026-05-15T18:00:00.000Z',
      available: {
        version: '0.7.0',
        publishedAt: '2026-05-15T18:00:00.000Z',
        releaseNotesUrl: 'https://example.com/notes',
      },
      applyInProgress: {
        fromVersion: '0.6.0',
        toVersion: '0.7.0',
        startedAt: '2026-05-15T18:01:00.000Z',
      },
      lastError: {
        code: 'apply_failed',
        message: 'npm fell over',
        at: '2026-05-15T18:02:00.000Z',
      },
    };
    store.save(state);

    // Re-open to bypass the in-memory cache.
    const reopened = new UpdateStateStore(tmp);
    expect(reopened.load()).toEqual(state);
  });

  it('rejects unsupported state versions', () => {
    writeFileSync(join(tmp, 'update-state.json'), JSON.stringify({ version: 99 }));
    const store = new UpdateStateStore(tmp);
    expect(() => store.load()).toThrow(/unsupported version/);
  });

  it('rejects malformed JSON', () => {
    writeFileSync(join(tmp, 'update-state.json'), 'definitely not json');
    const store = new UpdateStateStore(tmp);
    expect(() => store.load()).toThrow(/not valid JSON/);
  });

  it('update() merges patches into the persisted state', () => {
    const store = new UpdateStateStore(tmp);
    store.update({ lastChecked: '2026-05-15T18:00:00.000Z' });
    store.update({ available: { version: '0.7.0', publishedAt: '2026-05-15T18:00:00.000Z' } });
    const state = store.load();
    expect(state.lastChecked).toBe('2026-05-15T18:00:00.000Z');
    expect(state.available).toEqual({ version: '0.7.0', publishedAt: '2026-05-15T18:00:00.000Z' });
  });

  it('clearField() drops a key from the persisted state', () => {
    const store = new UpdateStateStore(tmp);
    store.update({ available: { version: '0.7.0', publishedAt: '2026-05-15T18:00:00.000Z' } });
    store.clearField('available');
    const reopened = new UpdateStateStore(tmp);
    expect(reopened.load().available).toBeUndefined();
  });
});
