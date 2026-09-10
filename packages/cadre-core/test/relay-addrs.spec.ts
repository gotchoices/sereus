import { describe, it, expect, beforeAll } from 'vitest';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import {
  RELAY_SEARCH_LISTEN_ADDR,
  relayCircuitAddrs,
  resolveListenAddrs,
  resolveTransportOptions,
  UnbindableListenAddressError
} from '../src/relay-addrs.js';
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

    /**
     * A hand-written `<relay>/p2p-circuit` listen entry is the CONFIGURED shape, and
     * it cannot work on this route: libp2p dials the relay from inside `listen()`,
     * the bring-up quiet period denies that dial, and the transport manager's
     * `FATAL_ALL` turns the refusal into `UnsupportedListenAddressesError` out of
     * `libp2p.start()` — a failure naming nothing an operator could act on. So the
     * surface is closed here, loudly, pointing at the field that does work.
     */
    it('rejects a hand-written configured circuit entry in listenAddrs', () => {
      expect(() => resolveListenAddrs({
        listenAddrs: ['/ip4/0.0.0.0/tcp/4001', `/ip4/1.2.3.4/tcp/4001/p2p/${RELAY}/p2p-circuit`]
      }, 'search')).toThrow(/Move the relay to network\.relayAddrs/);
    });

    it('leaves the bare search entry and every non-circuit entry alone', () => {
      expect(resolveListenAddrs({
        listenAddrs: [RELAY_SEARCH_LISTEN_ADDR, '/webrtc', '/ip4/0.0.0.0/tcp/4001']
      }, 'search')).toEqual([RELAY_SEARCH_LISTEN_ADDR, '/webrtc', '/ip4/0.0.0.0/tcp/4001']);
    });

    /** Strand nodes take the configured route, which is where that entry belongs. */
    it('accepts the same entry on the configured route', () => {
      const listenAddrs = [`/ip4/1.2.3.4/tcp/4001/p2p/${RELAY}/p2p-circuit`];

      expect(resolveListenAddrs({ listenAddrs })).toEqual(listenAddrs);
    });
  });
});

/**
 * The other half of the listen config: `listenAddrs` says WHERE to bind, and the
 * transports the node will have say what it CAN bind. libp2p checks the two against
 * each other only in the all-or-nothing sense — it drops every address no transport
 * claims and raises only if that leaves none — so a `/ws` address paired with a TCP
 * one used to disappear in silence. `resolveTransportOptions` is where the two halves
 * meet, and it sits on the resolved list both node kinds pass through.
 */
describe('resolveTransportOptions', () => {
  describe('WebSocket is derived', () => {
    it('returns the wsPort switch when a listen entry names /ws', () => {
      expect(resolveTransportOptions(undefined, ['/ip4/0.0.0.0/tcp/4002/ws'])).toEqual({ wsPort: 0 });
    });

    /**
     * `wsPort` is a SWITCH, not a port — it exists to make `@optimystic/db-p2p` add
     * `webSockets()`, and the address it synthesizes from the value is discarded
     * because `cadre-core` always supplies explicit `listenAddrs`. Scraping a real
     * port would be a lie the moment a config names two WebSocket addresses, and the
     * strand path zeroes fixed ports anyway.
     */
    it('is 0 regardless of the port the address names, and regardless of how many name one', () => {
      expect(resolveTransportOptions(undefined, ['/ip4/0.0.0.0/tcp/4402/ws'])).toEqual({ wsPort: 0 });
      expect(resolveTransportOptions(undefined, [
        '/ip4/0.0.0.0/tcp/4402/ws',
        '/ip4/0.0.0.0/tcp/4403/ws'
      ])).toEqual({ wsPort: 0 });
    });

    it('recognises every spelling of a WebSocket listener libp2p accepts', () => {
      for (const addr of [
        '/ip4/0.0.0.0/tcp/4002/ws',
        '/ip4/0.0.0.0/tcp/443/wss',
        '/ip6/::1/tcp/4002/ws',
        '/dns4/host.example.com/tcp/443/tls/ws',
        '/dns4/host.example.com/tcp/443/tls/sni/host.example.com/ws'
      ]) {
        expect(resolveTransportOptions(undefined, [addr])).toEqual({ wsPort: 0 });
      }
    });

    /** The shipped React Native drone config: TCP for the LAN, WebSocket for the phone. */
    it('derives the switch from a mixed set, which is the pairing that hid the bug', () => {
      expect(resolveTransportOptions(undefined, [
        '/ip4/0.0.0.0/tcp/4001',
        '/ip4/0.0.0.0/tcp/4002/ws'
      ])).toEqual({ wsPort: 0 });
    });
  });

  describe('the default transports are enough', () => {
    it('adds nothing for TCP, circuit-relay, or no listen entries at all', () => {
      expect(resolveTransportOptions(undefined, ['/ip4/0.0.0.0/tcp/4001'])).toEqual({});
      expect(resolveTransportOptions(undefined, ['/ip6/::1/tcp/0'])).toEqual({});
      expect(resolveTransportOptions(undefined, [RELAY_SEARCH_LISTEN_ADDR])).toEqual({});
      expect(resolveTransportOptions(undefined, [`/ip4/1.2.3.4/tcp/4001/p2p/${RELAY}/p2p-circuit`])).toEqual({});
      expect(resolveTransportOptions(undefined, [])).toEqual({});
      expect(resolveTransportOptions(undefined, undefined)).toEqual({});
    });
  });

  describe('an unbindable address is refused', () => {
    /**
     * Deriving these would mean `cadre-core` importing transport packages into every
     * consumer including the React Native and browser bundles, and duplicating policy
     * `@optimystic/db-p2p`'s `libp2p-node.ts` owns. So they are named and refused —
     * the same fail-fast posture `network.relayAddrs` already has for a typo.
     */
    it('throws on a transport the default set does not bind, naming the address and the package', () => {
      expect(() => resolveTransportOptions(undefined, ['/ip4/0.0.0.0/udp/4001/quic-v1']))
        .toThrow(/\/ip4\/0\.0\.0\.0\/udp\/4001\/quic-v1 — needs @libp2p\/quic/);
      expect(() => resolveTransportOptions(undefined, ['/ip4/0.0.0.0/udp/4001/webrtc-direct']))
        .toThrow(/needs @libp2p\/webrtc/);
      expect(() => resolveTransportOptions(undefined, ['/webrtc']))
        .toThrow(/needs @libp2p\/webrtc/);
    });

    /** Outermost-first, so a layered address names the transport that actually terminates it. */
    it('names the outermost transport, not the one it rides on', () => {
      expect(() => resolveTransportOptions(undefined, ['/ip4/0.0.0.0/udp/4001/quic-v1/webtransport']))
        .toThrow(/needs @libp2p\/webtransport/);
    });

    /**
     * A `tcp` component in the stack must not wave an address through: `@libp2p/tcp`
     * binds a bare TCP address and nothing layered on top of one.
     */
    it('refuses an unknown transport layered over tcp rather than reading it as TCP', () => {
      expect(() => resolveTransportOptions(undefined, ['/ip4/0.0.0.0/tcp/4001/http']))
        .toThrow(/no transport for/);
    });

    it('refuses an address that names a host and no transport', () => {
      expect(() => resolveTransportOptions(undefined, ['/ip4/1.2.3.4']))
        .toThrow(/it names no transport component/);
    });

    it('reports every offending entry, not only the first', () => {
      expect(() => resolveTransportOptions(undefined, [
        '/ip4/0.0.0.0/tcp/4001',
        '/ip4/0.0.0.0/udp/4001/quic-v1',
        '/webrtc'
      ])).toThrow(/quic-v1[\s\S]*webrtc/);
    });

    /**
     * Same precedent as `isConfiguredCircuitListenAddr` and `ephemeralPortListenAddr`:
     * libp2p reports a bad listen addr itself, so this check only ever ADDS a denial
     * rather than re-reporting a parse failure in its own words.
     */
    it('passes an unparsable entry through untouched', () => {
      expect(resolveTransportOptions(undefined, ['not-a-multiaddr'])).toEqual({});
      expect(resolveTransportOptions(undefined, ['/ip4/0.0.0.0/tcp/4002/ws', 'not-a-multiaddr']))
        .toEqual({ wsPort: 0 });
    });

    it('is an UnbindableListenAddressError carrying the offending addresses', () => {
      const listenAddrs = ['/ip4/0.0.0.0/udp/4001/quic-v1'];
      try {
        resolveTransportOptions(undefined, listenAddrs);
        expect.unreachable('expected an UnbindableListenAddressError');
      } catch (err) {
        expect(err).toBeInstanceOf(UnbindableListenAddressError);
        expect((err as UnbindableListenAddressError).listenAddrs).toEqual(listenAddrs);
      }
    });
  });

  /**
   * A programmatic embedder that supplies transport factories owns transport policy,
   * and the factories are opaque — nothing can be inferred from them. This is what
   * keeps the React Native phone, the web app, and the integration-test harness
   * unaffected by either arm.
   */
  describe('network.transports set — the embedder owns the policy', () => {
    // The value is never called; only its presence is read.
    const transports = [(() => ({})) as never];

    it('derives nothing and refuses nothing', () => {
      expect(resolveTransportOptions({ transports }, ['/ip4/0.0.0.0/tcp/4002/ws'])).toEqual({});
      expect(resolveTransportOptions({ transports }, ['/ip4/0.0.0.0/udp/4001/quic-v1'])).toEqual({});
      expect(resolveTransportOptions({ transports, listenAddrs: [] }, [])).toEqual({});
    });
  });
});
