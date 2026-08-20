import { describe, it, expect } from 'vitest';
import { replacesAdvertisedAddrs, resolveAnnounceAddrs } from '../src/announce-addrs.js';

/**
 * The module's own contract, asserted directly rather than only through its two callers
 * (`cadre-node-control-node-options.spec.ts`, `strand-instance-manager-announce-addrs.spec.ts`)
 * — same split `relay-addrs.spec.ts` keeps for the sibling module. Those two pin that a
 * node's options carry what the operator configured; these pin the rules that decide
 * WHAT gets carried, which is where the sharp edges are: empty means unset, and an entry
 * that names no address must never reach libp2p.
 */

const PUBLIC_ADDR = '/dns4/mynode.example.com/tcp/4001';

describe('resolveAnnounceAddrs', () => {
  it('returns no keys at all when network is undefined', () => {
    expect(resolveAnnounceAddrs(undefined)).toEqual({});
  });

  it('returns no keys when network carries neither field', () => {
    expect(resolveAnnounceAddrs({ listenAddrs: ['/ip4/0.0.0.0/tcp/4001'] })).toEqual({});
  });

  it('carries each field independently', () => {
    expect(resolveAnnounceAddrs({ announceAddrs: [PUBLIC_ADDR] }))
      .toEqual({ announceAddrs: [PUBLIC_ADDR] });
    expect(resolveAnnounceAddrs({ appendAnnounceAddrs: [PUBLIC_ADDR] }))
      .toEqual({ appendAnnounceAddrs: [PUBLIC_ADDR] });
  });

  it('preserves entry order and duplicates, leaving both to libp2p', () => {
    const addrs = ['/ip4/1.2.3.4/tcp/4001', PUBLIC_ADDR, '/ip4/1.2.3.4/tcp/4001'];

    expect(resolveAnnounceAddrs({ announceAddrs: addrs }).announceAddrs).toEqual(addrs);
  });

  it('forwards entries verbatim rather than normalized, so config and options read alike', () => {
    // `multiaddr()` would render this without its trailing slash; the operator's text is
    // what the node options carry, and libp2p re-parses it anyway.
    expect(resolveAnnounceAddrs({ announceAddrs: ['/dns4/mynode.example.com/tcp/4001/'] }).announceAddrs)
      .toEqual(['/dns4/mynode.example.com/tcp/4001/']);
  });

  describe('empty means unset', () => {
    it('drops an empty array rather than forwarding an explicit empty announce set', () => {
      expect(resolveAnnounceAddrs({ announceAddrs: [], appendAnnounceAddrs: [] })).toEqual({});
    });

    it('drops only the empty field, keeping the configured one', () => {
      expect(resolveAnnounceAddrs({ announceAddrs: [], appendAnnounceAddrs: [PUBLIC_ADDR] }))
        .toEqual({ appendAnnounceAddrs: [PUBLIC_ADDR] });
    });
  });

  describe('rejects an entry that cannot advertise anything', () => {
    it('names the field and the value for an unparsable entry', () => {
      expect(() => resolveAnnounceAddrs({ announceAddrs: ['not-a-multiaddr'] }))
        .toThrow(/network\.announceAddrs entry is not a valid multiaddr: not-a-multiaddr/);
    });

    it('checks appendAnnounceAddrs on the same terms, under its own field name', () => {
      expect(() => resolveAnnounceAddrs({ appendAnnounceAddrs: ['tcp/4001'] }))
        .toThrow(/network\.appendAnnounceAddrs entry is not a valid multiaddr: tcp\/4001/);
    });

    it('rejects a bad entry anywhere in the list, not only the first', () => {
      expect(() => resolveAnnounceAddrs({ announceAddrs: [PUBLIC_ADDR, 'not-a-multiaddr'] }))
        .toThrow(/not a valid multiaddr: not-a-multiaddr/);
    });

    it('rejects leading whitespace rather than trimming it into something else', () => {
      expect(() => resolveAnnounceAddrs({ announceAddrs: [` ${PUBLIC_ADDR}`] }))
        .toThrow(/network\.announceAddrs entry is not a valid multiaddr/);
    });

    /**
     * The sharp one, and the reason parsing alone is not the whole check: `''` and `'/'`
     * PARSE — each yields a component-less multiaddr — so a set holding only those is
     * non-empty, replaces every advertised address, and names nothing. A templated
     * `cadre.yaml` whose address variable went unsubstituted produces exactly this.
     */
    it.each([['an empty string', ''], ['a bare slash', '/']])(
      'rejects %s, which parses but names no address',
      (_label, entry) => {
        expect(() => resolveAnnounceAddrs({ announceAddrs: [entry] }))
          .toThrow(/network\.announceAddrs entry names no address/);
        expect(() => resolveAnnounceAddrs({ appendAnnounceAddrs: [entry] }))
          .toThrow(/network\.appendAnnounceAddrs entry names no address/);
      }
    );

    it('rejects a component-less entry mixed in with valid ones', () => {
      expect(() => resolveAnnounceAddrs({ announceAddrs: [PUBLIC_ADDR, ''] }))
        .toThrow(/network\.announceAddrs entry names no address/);
    });
  });
});

/**
 * The predicate behind `CadreNode`'s operator warning. It reads the raw config rather
 * than the resolved result — deliberately, since the warning runs as a pre-flight check
 * — so it has to agree with {@link resolveAnnounceAddrs} on what "set" means.
 */
describe('replacesAdvertisedAddrs', () => {
  it.each([
    ['undefined network', undefined, false],
    ['no announce field', {}, false],
    ['an empty announce array', { announceAddrs: [] }, false],
    ['appendAnnounceAddrs alone — it adds rather than replaces', { appendAnnounceAddrs: [PUBLIC_ADDR] }, false],
    ['a non-empty announce array', { announceAddrs: [PUBLIC_ADDR] }, true]
  ])('is %s → %s', (_label, network, expected) => {
    expect(replacesAdvertisedAddrs(network)).toBe(expected);
  });

  it('agrees with resolveAnnounceAddrs on whether announceAddrs is in play', () => {
    for (const network of [undefined, {}, { announceAddrs: [] }, { announceAddrs: [PUBLIC_ADDR] }]) {
      expect(replacesAdvertisedAddrs(network))
        .toBe(resolveAnnounceAddrs(network).announceAddrs !== undefined);
    }
  });
});
