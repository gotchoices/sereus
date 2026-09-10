import { describe, it, expect, beforeAll } from 'vitest';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { strandNodeAddrs } from '../src/strand-network-config.js';
import { resolveListenAddrs } from '../src/relay-addrs.js';
import type { NetworkConfig } from '../src/types.js';

/**
 * One machine, one operator-written `NetworkConfig`, N+1 libp2p nodes built from it
 * (one control node plus one per strand). `strandNodeAddrs` is the per-strand view of
 * the two fields that describe a single endpoint on that host — see
 * `strand-network-config.ts`.
 *
 * Two rules, pinned here because everything downstream reads only the derived result:
 * a fixed DIRECT listen port becomes ephemeral, and the announce config is dropped
 * outright. Everything else is passed through byte-for-byte, including a
 * `/p2p-circuit` entry whose embedded port belongs to the relay rather than to this
 * host.
 */

let RELAY: string;

beforeAll(async () => {
  RELAY = peerIdFromPrivateKey(await generateKeyPair('Ed25519')).toString();
});

describe('strandNodeAddrs', () => {
  describe('unset config', () => {
    it('resolves to no options at all, so the caller inherits db-p2p\'s default listener', () => {
      expect(strandNodeAddrs(undefined)).toEqual({});
      expect(strandNodeAddrs({})).toEqual({});
      expect(strandNodeAddrs({ relayAddrs: [] })).toEqual({});
    });
  });

  describe('fixed direct ports', () => {
    it('rewrites the fixed port cadre-cli\'s example config ships to an ephemeral one', () => {
      expect(strandNodeAddrs({ listenAddrs: ['/ip4/0.0.0.0/tcp/4001'] }))
        .toEqual({ listenAddrs: ['/ip4/0.0.0.0/tcp/0'] });
    });

    it('keeps a /ws suffix while rewriting the port under it', () => {
      expect(strandNodeAddrs({ listenAddrs: ['/ip4/0.0.0.0/tcp/4001/ws'] }).listenAddrs)
        .toEqual(['/ip4/0.0.0.0/tcp/0/ws']);
    });

    it('keeps a specific-interface bind — only the port is contended, not the interface', () => {
      expect(strandNodeAddrs({ listenAddrs: ['/ip4/127.0.0.1/tcp/4001'] }).listenAddrs)
        .toEqual(['/ip4/127.0.0.1/tcp/0']);
      expect(strandNodeAddrs({ listenAddrs: ['/ip6/::1/tcp/4001'] }).listenAddrs)
        .toEqual(['/ip6/::1/tcp/0']);
      expect(strandNodeAddrs({ listenAddrs: ['/dns4/host.example.com/tcp/4001/ws'] }).listenAddrs)
        .toEqual(['/dns4/host.example.com/tcp/0/ws']);
    });

    it('rewrites a UDP port too — a QUIC listener contends for its port the same way', () => {
      expect(strandNodeAddrs({ listenAddrs: ['/ip4/0.0.0.0/udp/4001/quic-v1'] }).listenAddrs)
        .toEqual(['/ip4/0.0.0.0/udp/0/quic-v1']);
    });

    it('rewrites every entry, not only the first', () => {
      expect(strandNodeAddrs({
        listenAddrs: ['/ip4/0.0.0.0/tcp/4001', '/ip4/0.0.0.0/tcp/4002/ws']
      }).listenAddrs).toEqual(['/ip4/0.0.0.0/tcp/0', '/ip4/0.0.0.0/tcp/0/ws']);
    });
  });

  describe('entries with nothing to rewrite', () => {
    it('leaves a port that is already ephemeral exactly as written', () => {
      expect(strandNodeAddrs({ listenAddrs: ['/ip4/0.0.0.0/tcp/0'] }).listenAddrs)
        .toEqual(['/ip4/0.0.0.0/tcp/0']);
    });

    it('leaves an entry that names no port alone', () => {
      expect(strandNodeAddrs({ listenAddrs: ['/ip4/0.0.0.0'] }).listenAddrs)
        .toEqual(['/ip4/0.0.0.0']);
    });

    it('passes an unparsable entry through — libp2p reports a bad listen addr itself', () => {
      expect(strandNodeAddrs({ listenAddrs: ['not-a-multiaddr'] }).listenAddrs)
        .toEqual(['not-a-multiaddr']);
    });

    /**
     * The React Native case (`reference-app-rn`'s `cadre-phone.ts`): the host cannot
     * listen at all. Rewriting must never resurrect a direct listener that was
     * deliberately opted out of.
     */
    it('keeps an explicitly empty listenAddrs empty', () => {
      expect(strandNodeAddrs({ listenAddrs: [] })).toEqual({ listenAddrs: [] });
    });
  });

  describe('circuit entries', () => {
    /**
     * The port inside `<relay>/p2p-circuit` is the RELAY's — the address the strand
     * node dials out to, not a socket it binds — so zeroing it would point the node at
     * a relay port that does not exist.
     */
    it('passes a hand-written <relay>/p2p-circuit listen entry through unchanged', () => {
      const circuit = `/ip4/1.2.3.4/tcp/4001/p2p/${RELAY}/p2p-circuit`;

      expect(strandNodeAddrs({ listenAddrs: [circuit] }).listenAddrs).toEqual([circuit]);
    });

    it('leaves the circuit entries relayAddrs folds in untouched while rewriting the direct one', () => {
      const relay = `/dns4/relay.example.com/tcp/4001/p2p/${RELAY}`;

      expect(strandNodeAddrs({
        listenAddrs: ['/ip4/0.0.0.0/tcp/4001'],
        relayAddrs: [relay]
      }).listenAddrs).toEqual(['/ip4/0.0.0.0/tcp/0', `${relay}/p2p-circuit`]);
    });

    it('gives a relay-only config its circuit entry and an ephemeral direct listener', () => {
      const relay = `/dns4/relay.example.com/tcp/4001/p2p/${RELAY}`;

      expect(strandNodeAddrs({ relayAddrs: [relay] }).listenAddrs)
        .toEqual(['/ip4/0.0.0.0/tcp/0', `${relay}/p2p-circuit`]);
    });
  });

  describe('collapse and stability', () => {
    /**
     * Two entries that differed only by port are the SAME entry after the rewrite, and
     * libp2p would otherwise be asked to bind one ephemeral listener twice.
     */
    it('dedupes entries that collapse once their ports are zeroed, first occurrence wins', () => {
      expect(strandNodeAddrs({
        listenAddrs: ['/ip4/0.0.0.0/tcp/4001', '/ip4/0.0.0.0/tcp/4002', '/ip4/0.0.0.0/tcp/0']
      }).listenAddrs).toEqual(['/ip4/0.0.0.0/tcp/0']);
    });

    it('keeps configured order across entries that do not collapse', () => {
      expect(strandNodeAddrs({
        listenAddrs: ['/ip4/127.0.0.1/tcp/4001', '/ip4/0.0.0.0/tcp/4001/ws']
      }).listenAddrs).toEqual(['/ip4/127.0.0.1/tcp/0', '/ip4/0.0.0.0/tcp/0/ws']);
    });

    it('is idempotent — deriving from an already-derived list changes nothing', () => {
      const once = strandNodeAddrs({ listenAddrs: ['/ip4/0.0.0.0/tcp/4001/ws'] }).listenAddrs;

      expect(strandNodeAddrs({ listenAddrs: once }).listenAddrs).toEqual(once);
    });
  });

  describe('announce config', () => {
    /**
     * Any concrete announce entry names a port, and on a one-`NetworkConfig` machine
     * that port is the CONTROL node's. `announceAddrs` additionally REPLACES the
     * advertised set (`announce-addrs.ts`), so inheriting it would leave a strand node
     * publishing one address that reaches the wrong node and nothing else.
     */
    it('drops announceAddrs and appendAnnounceAddrs — a strand node advertises neither', () => {
      const derived = strandNodeAddrs({
        listenAddrs: ['/ip4/0.0.0.0/tcp/4001'],
        announceAddrs: ['/dns4/mynode.example.com/tcp/4001'],
        appendAnnounceAddrs: ['/dns4/mynode.example.com/tcp/4001']
      });

      expect(Object.keys(derived)).toEqual(['listenAddrs']);
    });

    it('does not fail on an announce entry it is going to ignore', () => {
      expect(() => strandNodeAddrs({ announceAddrs: ['not-a-multiaddr'] })).not.toThrow();
    });
  });

  describe('validation and isolation', () => {
    /**
     * Unchanged from the control node: `relayAddrs` is operator configuration, so a
     * typo must fail loudly at strand start rather than silently costing the node its
     * reachability.
     */
    it('still throws on a malformed relayAddrs entry', () => {
      expect(() => strandNodeAddrs({ relayAddrs: ['not-a-multiaddr'] }))
        .toThrow(/network\.relayAddrs entry is not a valid multiaddr/);
      expect(() => strandNodeAddrs({ relayAddrs: ['/ip4/1.2.3.4/tcp/4001'] }))
        .toThrow(/names no relay peerId/);
    });

    /**
     * The control node's own resolution runs from `cadre-node.ts` and must be provably
     * untouched by this derivation — including through the shared config object, which
     * both nodes read.
     */
    it('leaves the control node\'s resolution of the same config unchanged', () => {
      const listenAddrs = ['/ip4/0.0.0.0/tcp/4001', '/ip4/0.0.0.0/tcp/4001/ws'];
      const network: NetworkConfig = { listenAddrs };
      const before = resolveListenAddrs(network);

      strandNodeAddrs(network);

      expect(resolveListenAddrs(network)).toEqual(before);
      expect(resolveListenAddrs(network)).toEqual(['/ip4/0.0.0.0/tcp/4001', '/ip4/0.0.0.0/tcp/4001/ws']);
      expect(listenAddrs).toEqual(['/ip4/0.0.0.0/tcp/4001', '/ip4/0.0.0.0/tcp/4001/ws']);
    });

    it('gives every strand on the machine the same derivation — they differ by OS-assigned port, not by config', () => {
      const network: NetworkConfig = { listenAddrs: ['/ip4/0.0.0.0/tcp/4001'] };

      expect(strandNodeAddrs(network)).toEqual(strandNodeAddrs(network));
    });
  });
});
