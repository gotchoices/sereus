import { describe, expect, it } from 'vitest';

import { evaluateReachability } from '../reachability.js';

describe('evaluateReachability', () => {
  it('returns cgnat when cgnatDetected is true (overrides portMode)', () => {
    expect(evaluateReachability({ portMode: 'auto-upnp', cgnatDetected: true })).toBe('cgnat');
    expect(evaluateReachability({ portMode: 'failed', cgnatDetected: true })).toBe('cgnat');
  });

  it('returns reachable for auto-upnp / auto-natpmp', () => {
    expect(evaluateReachability({ portMode: 'auto-upnp', cgnatDetected: false })).toBe('reachable');
    expect(evaluateReachability({ portMode: 'auto-natpmp', cgnatDetected: false })).toBe('reachable');
  });

  it('returns unreachable when port mapping failed', () => {
    expect(evaluateReachability({ portMode: 'failed', cgnatDetected: false })).toBe('unreachable');
  });

  it('returns unknown for manual / disabled', () => {
    expect(evaluateReachability({ portMode: 'manual', cgnatDetected: false })).toBe('unknown');
    expect(evaluateReachability({ portMode: 'disabled', cgnatDetected: false })).toBe('unknown');
  });
});
