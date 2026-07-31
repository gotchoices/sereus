import { describe, it, expect, vi } from 'vitest';
import { CadreNode } from '../src/cadre-node.js';
import type { CadreNodeConfig } from '../src/types.js';

/**
 * `network.announceAddrs` is accepted but not yet applied (no upstream `db-p2p`
 * option to carry it — see `NetworkConfig.announceAddrs` doc comment). This pins
 * `CadreNode.start()`'s honesty check: warn once when the field is set, stay
 * silent when it is not. Not a test that the setting DOES anything.
 */
describe('CadreNode announceAddrs warning', () => {
  function createConfig(overrides?: Partial<CadreNodeConfig>): CadreNodeConfig {
    return {
      controlNetwork: {
        partyId: 'announce-addrs-warning-' + Math.random().toString(36).slice(2),
        bootstrapNodes: []
      },
      profile: 'transaction',
      ...overrides
    };
  }

  it('warns at start when network.announceAddrs is set', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const node = new CadreNode(createConfig({ network: { announceAddrs: ['/dns4/mynode.example.com/tcp/4001'] } }));

    try {
      await node.start();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]?.[0]).toContain('network.announceAddrs');
    } finally {
      await node.stop();
      warn.mockRestore();
    }
  }, 30000);

  it('stays silent when network.announceAddrs is unset', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const node = new CadreNode(createConfig());

    try {
      await node.start();
      expect(warn).not.toHaveBeenCalled();
    } finally {
      await node.stop();
      warn.mockRestore();
    }
  }, 30000);

  it('stays silent when network.announceAddrs is an empty array', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const node = new CadreNode(createConfig({ network: { announceAddrs: [] } }));

    try {
      await node.start();
      expect(warn).not.toHaveBeenCalled();
    } finally {
      await node.stop();
      warn.mockRestore();
    }
  }, 30000);
});
