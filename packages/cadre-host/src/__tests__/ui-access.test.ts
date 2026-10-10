import { describe, expect, it } from 'vitest';

import { isHeadless, uiAccessLines } from '../bin/ui-access.js';

describe('isHeadless', () => {
  it('is true over SSH on any platform, and on Linux without a display', () => {
    expect(isHeadless('darwin', { SSH_CONNECTION: '1.2.3.4 5 6.7.8.9 22' })).toBe(true);
    expect(isHeadless('linux', {})).toBe(true);
    expect(isHeadless('linux', { DISPLAY: ':0' })).toBe(false);
    expect(isHeadless('linux', { WAYLAND_DISPLAY: 'wayland-0' })).toBe(false);
    expect(isHeadless('darwin', {})).toBe(false);
  });
});

describe('uiAccessLines', () => {
  it('gives the URL on a desktop, and the SSH forward (same port both sides) when headless', () => {
    expect(uiAccessLines(8765, false)).toEqual(['Open the UI: http://127.0.0.1:8765']);
    const lines = uiAccessLines(8765, true, { user: 'kyle', host: 'kjeib' });
    expect(lines).toContain('  ssh -L 8765:127.0.0.1:8765 kyle@kjeib');
    expect(lines.join('\n')).toContain('http://127.0.0.1:8765');
  });
});
