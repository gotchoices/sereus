import { describe, it, expect, vi, beforeAll } from 'vitest';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { CadreNode } from '../src/cadre-node.js';
import type { CadreNodeConfig, NetworkConfig } from '../src/types.js';

/**
 * `network.announceAddrs` IS applied now (see `announce-addrs.ts`), so the boot warning
 * no longer means "unsupported". It has one narrow job left: a non-empty announce set
 * REPLACES everything libp2p advertises, so a node that also holds a circuit-relay
 * reservation silently stops advertising the `/p2p-circuit` address that reservation
 * earned it, and peers stop reaching it through that relay. This file pins the trigger —
 * that combination and nothing else. The forwarding itself is asserted in
 * `cadre-node-control-node-options.spec.ts`.
 *
 * `warnIfAnnounceAddrsDiscardRelay` reads only `this.config.network`, so the matrix below
 * runs it on a bare `new CadreNode(config)` through the same private cast
 * `cadre-node-control-node-options.spec.ts` uses — no libp2p node, no relay dialled. One
 * test at the bottom pays for a real `start()` to prove the call site still exists.
 */
describe('CadreNode announceAddrs warning', () => {
  /** A real peerId, since relay-addr resolution validates the one it is given. */
  let RELAY_ADDR: string;

  beforeAll(async () => {
    RELAY_ADDR = `/dns4/relay.example.com/tcp/4001/p2p/${peerIdFromPrivateKey(await generateKeyPair('Ed25519'))}`;
  });

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
   * Warnings the check emits for `network`, filtered to the ones it owns rather than
   * asserted against `console.warn` as a whole — an unrelated warning from a dependency
   * must not turn this into a false failure.
   */
  function announceWarnings(network?: NetworkConfig): string[] {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      (new CadreNode(createConfig(network)) as unknown as {
        warnIfAnnounceAddrsDiscardRelay(): void
      }).warnIfAnnounceAddrsDiscardRelay();
      return warn.mock.calls
        .map((call) => String(call[0]))
        .filter((message) => message.includes('network.announceAddrs'));
    } finally {
      warn.mockRestore();
    }
  }

  describe('stays silent when nothing is at risk', () => {
    it('announceAddrs alone — the address is applied, and there is no circuit address to lose', () => {
      expect(announceWarnings({ announceAddrs: ['/dns4/mynode.example.com/tcp/4001'] })).toEqual([]);
    });

    it('appendAnnounceAddrs alone — an added address discards nothing, even alongside a relay', () => {
      expect(announceWarnings({
        appendAnnounceAddrs: ['/dns4/mynode.example.com/tcp/4001'],
        relayAddrs: [RELAY_ADDR]
      })).toEqual([]);
    });

    it('relayAddrs alone', () => {
      expect(announceWarnings({ relayAddrs: [RELAY_ADDR] })).toEqual([]);
    });

    it('neither field set', () => {
      expect(announceWarnings()).toEqual([]);
    });

    it('an empty announceAddrs array alongside a relay — empty means unset, so nothing is replaced', () => {
      expect(announceWarnings({ announceAddrs: [], relayAddrs: [RELAY_ADDR] })).toEqual([]);
    });
  });

  describe('warns when a non-empty announce set will discard a circuit address', () => {
    it('announceAddrs + relayAddrs warns exactly once, naming both fields and the way out', () => {
      const warnings = announceWarnings({
        announceAddrs: ['/dns4/mynode.example.com/tcp/4001'],
        relayAddrs: [RELAY_ADDR]
      });

      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('network.relayAddrs');
      expect(warnings[0]).toContain('/p2p-circuit');
      // The operator needs to be told what to do instead, not only what is wrong.
      expect(warnings[0]).toContain('network.appendAnnounceAddrs');
      // The stale "unsupported" claim must not come back — the field is applied now.
      expect(warnings[0]).not.toContain('not yet supported');
    });

    it('catches a hand-written /p2p-circuit listen addr too — same reservation, longer route', () => {
      const warnings = announceWarnings({
        announceAddrs: ['/dns4/mynode.example.com/tcp/4001'],
        listenAddrs: ['/ip4/0.0.0.0/tcp/0', `${RELAY_ADDR}/p2p-circuit`]
      });

      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('network.listenAddrs');
    });
  });

  /**
   * The matrix above would keep passing if `start()` stopped calling the check at all, so
   * one arm pays for a real bring-up. It asserts the failure too: the only configuration
   * that both warns AND reaches libp2p names a relay, and a relay that yields no
   * `/p2p-circuit` address aborts start with `RelayReservationFailedError`
   * (see `relay-addrs.ts`). `relay.example.com` is reserved for documentation and does not
   * resolve, so the rejection is the expected outcome — what matters is that the warning is
   * emitted BEFORE it, as a pre-flight config check.
   */
  it('is emitted by start(), ahead of libp2p bring-up', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const node = new CadreNode(createConfig({
      announceAddrs: ['/dns4/mynode.example.com/tcp/4001'],
      relayAddrs: [RELAY_ADDR]
    }));

    try {
      await expect(node.start()).rejects.toThrow(/network\.relayAddrs reservation failed/);

      expect(warn.mock.calls
        .map((call) => String(call[0]))
        .filter((message) => message.includes('network.announceAddrs'))
      ).toHaveLength(1);
    } finally {
      await node.stop();
      warn.mockRestore();
    }
  }, 30000);
});
