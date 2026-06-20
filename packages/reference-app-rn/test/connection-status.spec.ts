/**
 * connection-status.spec.ts — unit coverage for the pure banner derivation
 * extracted out of `app/index.tsx`. The hook test (test/react) only exercises
 * the `resuming` / `degraded` branches; this pins every status branch, the
 * connected-state count interpolation, and the precedence ordering so the
 * "behavior-preserving" refactor stays that way.
 */

import { describe, it, expect } from 'vitest';
import { connectionBanner, type ConnectionBannerInput } from '../src/connection-status';

/** Baseline: connected, nothing settling. Tests override only what they vary. */
function input(overrides: Partial<ConnectionBannerInput> = {}): ConnectionBannerInput {
  return {
    resuming: false,
    degraded: false,
    status: 'connected',
    error: null,
    strandCount: 0,
    memberCount: 0,
    ...overrides,
  };
}

describe('connectionBanner', () => {
  it('renders a connected banner with strand + member counts', () => {
    expect(connectionBanner(input({ strandCount: 2, memberCount: 3 }))).toEqual({
      color: '#4caf50',
      text: 'Connected · 2 strand(s) · 3 member(s)',
    });
  });

  it('renders connecting', () => {
    expect(connectionBanner(input({ status: 'connecting' }))).toEqual({
      color: '#ff9800',
      text: 'Connecting…',
    });
  });

  it('renders the error message when status is error', () => {
    expect(connectionBanner(input({ status: 'error', error: 'boom' }))).toEqual({
      color: '#f44336',
      text: 'boom',
    });
  });

  it('falls back to the go-to-Settings hint when error status carries no message', () => {
    expect(connectionBanner(input({ status: 'error', error: null }))).toEqual({
      color: '#f44336',
      text: 'Not connected — go to Settings',
    });
  });

  it('renders the idle (not-connected) hint', () => {
    expect(connectionBanner(input({ status: 'idle' }))).toEqual({
      color: '#666',
      text: 'Not connected — go to Settings',
    });
  });

  it('surfaces a pending error even while idle', () => {
    expect(connectionBanner(input({ status: 'idle', error: 'last failure' }))).toEqual({
      color: '#666',
      text: 'last failure',
    });
  });

  it('resuming takes precedence over the coarse status', () => {
    // status still reads connected, but a settling resume must show through.
    expect(connectionBanner(input({ resuming: true, status: 'connected' }))).toEqual({
      color: '#ff9800',
      text: 'Resuming — syncing…',
    });
  });

  it('degraded takes precedence over the coarse status', () => {
    expect(connectionBanner(input({ degraded: true, status: 'connected' }))).toEqual({
      color: '#f44336',
      text: 'Offline — reconnecting…',
    });
  });

  it('resuming outranks degraded when both are set', () => {
    expect(connectionBanner(input({ resuming: true, degraded: true }))).toEqual({
      color: '#ff9800',
      text: 'Resuming — syncing…',
    });
  });
});
