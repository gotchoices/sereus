import { describe, it, expect, vi } from 'vitest';
import { CadreNode } from '../src/cadre-node.js';
import type { CadreNodeConfig, NetworkConfig } from '../src/types.js';

/**
 * `network.announceAddrs` is accepted but not yet applied (no upstream `db-p2p`
 * option to carry it — see `NetworkConfig.announceAddrs` doc comment). This pins
 * `CadreNode.start()`'s honesty check: warn once when the field is set, stay
 * silent when it is not. Not a test that the setting DOES anything.
 */
describe('CadreNode announceAddrs warning', () => {
  function createConfig(network?: NetworkConfig): CadreNodeConfig {
    return {
      controlNetwork: {
        partyId: 'announce-addrs-warning-' + Math.random().toString(36).slice(2),
        bootstrapNodes: []
      },
      profile: 'transaction',
      ...(network ? { network } : {})
    };
  }

  /**
   * Warnings mentioning `network.announceAddrs` emitted over one real
   * `start()`/`stop()` cycle. Filtered by message rather than asserting against
   * `console.warn` as a whole, so an unrelated warning from a dependency cannot
   * turn this into a false failure.
   */
  async function announceWarningsDuringStart(network?: NetworkConfig): Promise<string[]> {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const node = new CadreNode(createConfig(network));

    try {
      await node.start();
      return warn.mock.calls
        .map((call) => String(call[0]))
        .filter((message) => message.includes('network.announceAddrs'));
    } finally {
      await node.stop();
      warn.mockRestore();
    }
  }

  it('warns once at start when network.announceAddrs is set', async () => {
    const warnings = await announceWarningsDuringStart({ announceAddrs: ['/dns4/mynode.example.com/tcp/4001'] });

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('not yet supported');
  }, 30000);

  it('stays silent when network.announceAddrs is unset', async () => {
    expect(await announceWarningsDuringStart()).toEqual([]);
  }, 30000);

  it('stays silent when network.announceAddrs is an empty array', async () => {
    expect(await announceWarningsDuringStart({ announceAddrs: [] })).toEqual([]);
  }, 30000);
});
