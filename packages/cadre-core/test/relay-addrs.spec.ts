import { describe, it, expect, beforeAll } from 'vitest';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { RELAY_SEARCH_LISTEN_ADDR, relayCircuitAddrs, resolveListenAddrs } from '../src/relay-addrs.js';
import type { NetworkConfig } from '../src/types.js';

/**
 * `relayAddrs` resolves to a `/p2p-circuit` entry in `listenAddrs`, and WHICH entry
 * depends on the caller's route:
 *
 *  - `'configured'` (the default; strand nodes) — `<relay>/p2p-circuit` per relay,
 *    which libp2p dials and reserves on from inside `listen()`.
 *  - `'search'` (the control node) — one bare `/p2p-circuit`, which opens no
 *    connection; `CadreNode.start()` drives the reservation after the control
 *    database is up.
 *
 * These tests pin both translations, since every consumer reads the resolved list and
 * nothing else.
 */

let RELAY: string;
let RELAY_2: string;

beforeAll(async () => {
  RELAY = peerIdFromPrivateKey(await generateKeyPair('Ed25519')).toString();
  RELAY_2 = peerIdFromPrivateKey(await generateKeyPair('Ed25519')).toString();
});

describe('relayCircuitAddrs', () => {
  it('appends /p2p-circuit to a direct relay dial addr', () => {
    expect(relayCircuitAddrs([`/dns4/relay.example.com/tcp/4001/p2p/${RELAY}`]))
      .toEqual([`/dns4/relay.example.com/tcp/4001/p2p/${RELAY}/p2p-circuit`]);
  });

  it('passes an entry that already carries /p2p-circuit through unchanged', () => {
    const addr = `/ip4/1.2.3.4/tcp/4001/p2p/${RELAY}/p2p-circuit`;

    expect(relayCircuitAddrs([addr])).toEqual([addr]);
  });

  it('is idempotent — resolving an already-resolved list changes nothing', () => {
    const once = relayCircuitAddrs([`/ip4/1.2.3.4/tcp/4001/p2p/${RELAY}`]);

    expect(relayCircuitAddrs(once)).toEqual(once);
  });

  it('deduplicates duplicate relay entries, first occurrence wins', () => {
    const direct = `/ip4/1.2.3.4/tcp/4001/p2p/${RELAY}`;

    expect(relayCircuitAddrs([direct, `${direct}/p2p-circuit`, direct]))
      .toEqual([`${direct}/p2p-circuit`]);
  });

  it('keeps configured order across distinct relays', () => {
    const first = `/ip4/1.2.3.4/tcp/4001/p2p/${RELAY}`;
    const second = `/ip4/5.6.7.8/tcp/4001/p2p/${RELAY_2}`;

    expect(relayCircuitAddrs([first, second]))
      .toEqual([`${first}/p2p-circuit`, `${second}/p2p-circuit`]);
  });

  it('returns [] for an empty list', () => {
    expect(relayCircuitAddrs([])).toEqual([]);
  });

  /**
   * The deliberate asymmetry with `extractCircuitRelayTargets`, which logs-and-skips:
   * that one reads addrs discovered at runtime from peers, where one bad entry must
   * not be fatal. This one reads OPERATOR CONFIG, where a silently dropped entry costs
   * the node the reachability it was configured for — exactly the failure this module
   * exists to remove.
   */
  describe('malformed operator config throws rather than being dropped', () => {
    it('throws on an unparsable entry', () => {
      expect(() => relayCircuitAddrs(['not-a-multiaddr']))
        .toThrow(/not a valid multiaddr/);
    });

    it('throws on a well-formed addr that names no relay peerId', () => {
      expect(() => relayCircuitAddrs(['/ip4/1.2.3.4/tcp/4001']))
        .toThrow(/names no relay peerId/);
    });

    it('throws on a bare /p2p-circuit with no relay before it', () => {
      expect(() => relayCircuitAddrs(['/p2p-circuit']))
        .toThrow(/names no relay peerId/);
    });

    it('throws on a garbage peerId in an otherwise well-formed addr', () => {
      expect(() => relayCircuitAddrs(['/ip4/1.2.3.4/tcp/4001/p2p/notapeerid']))
        .toThrow();
    });

    it('names the offending entry, so an operator can find it in cadre.yaml', () => {
      expect(() => relayCircuitAddrs([`/ip4/1.2.3.4/tcp/4001/p2p/${RELAY}`, '/ip4/9.9.9.9/tcp/1']))
        .toThrow(/\/ip4\/9\.9\.9\.9\/tcp\/1/);
    });
  });
});

describe('resolveListenAddrs', () => {
  it('returns undefined when neither field is set, so callers omit listenAddrs entirely', () => {
    expect(resolveListenAddrs(undefined)).toBeUndefined();
    expect(resolveListenAddrs({})).toBeUndefined();
    expect(resolveListenAddrs({ relayAddrs: [] })).toBeUndefined();
  });

  it('passes listenAddrs through untouched when no relay is configured', () => {
    expect(resolveListenAddrs({ listenAddrs: ['/ip4/0.0.0.0/tcp/4001'] }))
      .toEqual(['/ip4/0.0.0.0/tcp/4001']);
  });

  it('preserves an explicitly empty listenAddrs (the React Native "cannot listen" case)', () => {
    expect(resolveListenAddrs({ listenAddrs: [] })).toEqual([]);
  });

  it('appends the relay circuit after the configured listen addrs', () => {
    const resolved = resolveListenAddrs({
      listenAddrs: ['/ip4/0.0.0.0/tcp/4001'],
      relayAddrs: [`/dns4/relay.example.com/tcp/4001/p2p/${RELAY}`]
    });

    expect(resolved).toEqual([
      '/ip4/0.0.0.0/tcp/4001',
      `/dns4/relay.example.com/tcp/4001/p2p/${RELAY}/p2p-circuit`
    ]);
  });

  /**
   * Without the fallback, naming a relay would silently REPLACE the node's direct TCP
   * listener (db-p2p only defaults `listenAddrs` when the key is absent) — a config
   * that adds reachability would cost it instead.
   */
  it('keeps a direct listener when relayAddrs is set but listenAddrs is not', () => {
    const resolved = resolveListenAddrs({ relayAddrs: [`/ip4/1.2.3.4/tcp/4001/p2p/${RELAY}`] });

    expect(resolved).toEqual([
      '/ip4/0.0.0.0/tcp/0',
      `/ip4/1.2.3.4/tcp/4001/p2p/${RELAY}/p2p-circuit`
    ]);
  });

  it('gives a listenAddrs: [] node its circuit listener — the point of naming a relay', () => {
    const resolved = resolveListenAddrs({
      listenAddrs: [],
      relayAddrs: [`/ip4/1.2.3.4/tcp/4001/p2p/${RELAY}`]
    });

    expect(resolved).toEqual([`/ip4/1.2.3.4/tcp/4001/p2p/${RELAY}/p2p-circuit`]);
  });

  it('dedupes a relay whose circuit addr is already hand-written into listenAddrs', () => {
    const circuit = `/ip4/1.2.3.4/tcp/4001/p2p/${RELAY}/p2p-circuit`;
    const resolved = resolveListenAddrs({
      listenAddrs: ['/ip4/0.0.0.0/tcp/4001', circuit],
      relayAddrs: [`/ip4/1.2.3.4/tcp/4001/p2p/${RELAY}`]
    });

    expect(resolved).toEqual(['/ip4/0.0.0.0/tcp/4001', circuit]);
  });

  it('is stable across repeated calls — restarts bind the same list', () => {
    const network: NetworkConfig = {
      listenAddrs: ['/ip4/0.0.0.0/tcp/4001'],
      relayAddrs: [`/ip4/1.2.3.4/tcp/4001/p2p/${RELAY}`, `/ip4/5.6.7.8/tcp/4001/p2p/${RELAY_2}`]
    };

    expect(resolveListenAddrs(network)).toEqual(resolveListenAddrs(network));
  });

  /**
   * The route the CONTROL node takes. A configured circuit listener dials its relay
   * from inside `libp2p.start()`, which put a sibling in the node's Optimystic cohort
   * before `ControlDatabase.initialize()` ran — and a sibling that has not yet
   * replicated the booting node's membership row refuses every control-DB stream, so
   * bring-up died. The search entry opens no connection, so bring-up runs solo.
   */
  describe("route: 'search'", () => {
    it('replaces the per-relay circuit listeners with ONE bare search entry', () => {
      const resolved = resolveListenAddrs({
        listenAddrs: ['/ip4/0.0.0.0/tcp/4001'],
        relayAddrs: [`/ip4/1.2.3.4/tcp/4001/p2p/${RELAY}`, `/ip4/5.6.7.8/tcp/4001/p2p/${RELAY_2}`]
      }, 'search');

      expect(resolved).toEqual(['/ip4/0.0.0.0/tcp/4001', RELAY_SEARCH_LISTEN_ADDR]);
    });

    it('keeps the direct-listener default when listenAddrs is unset', () => {
      const resolved = resolveListenAddrs({ relayAddrs: [`/ip4/1.2.3.4/tcp/4001/p2p/${RELAY}`] }, 'search');

      expect(resolved).toEqual(['/ip4/0.0.0.0/tcp/0', RELAY_SEARCH_LISTEN_ADDR]);
    });

    it('leaves a listenAddrs: [] node with the search entry alone — its only address', () => {
      const resolved = resolveListenAddrs({
        listenAddrs: [],
        relayAddrs: [`/ip4/1.2.3.4/tcp/4001/p2p/${RELAY}`]
      }, 'search');

      expect(resolved).toEqual([RELAY_SEARCH_LISTEN_ADDR]);
    });

    it('dedupes against a hand-written bare /p2p-circuit entry', () => {
      const resolved = resolveListenAddrs({
        listenAddrs: [RELAY_SEARCH_LISTEN_ADDR],
        relayAddrs: [`/ip4/1.2.3.4/tcp/4001/p2p/${RELAY}`]
      }, 'search');

      expect(resolved).toEqual([RELAY_SEARCH_LISTEN_ADDR]);
    });

    it('adds nothing when no relay is named', () => {
      expect(resolveListenAddrs({ listenAddrs: ['/ip4/0.0.0.0/tcp/4001'] }, 'search'))
        .toEqual(['/ip4/0.0.0.0/tcp/4001']);
      expect(resolveListenAddrs({}, 'search')).toBeUndefined();
    });

    /**
     * The search entry discards the resolved circuit addrs, but an operator typo must
     * still fail at config resolution — that is the half of `relayAddrs`' fail-fast
     * contract libp2p's listener never owned.
     */
    it('still throws on a malformed relayAddrs entry', () => {
      expect(() => resolveListenAddrs({ relayAddrs: ['/ip4/1.2.3.4/tcp/4001'] }, 'search'))
        .toThrow(/network\.relayAddrs entry names no relay peerId/);
      expect(() => resolveListenAddrs({ relayAddrs: ['not-a-multiaddr'] }, 'search'))
        .toThrow(/network\.relayAddrs entry is not a valid multiaddr/);
    });
  });
});
