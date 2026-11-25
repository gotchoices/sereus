import { describe, it, expect } from 'vitest';
import { nodeTransportsOption } from '../src/node-transports.js';
import type { NetworkConfig } from '../src/types.js';

/**
 * Whether a node is built from an explicit transport list, and from WHOSE list.
 *
 * The two reasons cadre has to own the list are independent, and only the relay one was
 * checked: a node with supervised relay slots needs the list wrapped
 * (`relay-reservation.ts`), and a node whose listen entries name `/webrtc` needs the list
 * at all, because `@optimystic/db-p2p`'s own default list cannot carry that transport. A
 * `/webrtc` entry on a node with no relay satisfies only the second, and libp2p drops a
 * listen address no transport claims without a word — the failure
 * `resolveTransportOptions` refuses the entry to prevent.
 */

/** Opaque stand-ins: nothing here builds or calls a transport factory. */
const EMBEDDER_TRANSPORTS = [(() => ({ embedder: true })) as never];
const DEFAULT_LIST = [(() => ({ injected: true })) as never];

const defaultTransports: NetworkConfig['defaultTransports'] = () => DEFAULT_LIST;

describe('nodeTransportsOption', () => {
  it('builds the injected list for a /webrtc entry even with no relay slots to supervise', () => {
    expect(nodeTransportsOption({ defaultTransports }, { webrtcIceServers: [] }, false))
      .toEqual({ transports: DEFAULT_LIST });
  });

  /**
   * The narrowness matters: a node whose entries db-p2p can bind on its own keeps inheriting
   * db-p2p's list, so this stays one rule about one unsupported transport rather than cadre
   * quietly taking over transport policy everywhere.
   */
  it('leaves transports off for an unsupervised node whose entries db-p2p can bind itself', () => {
    expect(nodeTransportsOption({ defaultTransports }, { wsPort: 0 }, false)).toEqual({});
    expect(nodeTransportsOption({ defaultTransports }, {}, false)).toEqual({});
  });

  it('passes the embedder\'s own list through unwrapped when there are no slots to protect', () => {
    expect(nodeTransportsOption({ transports: EMBEDDER_TRANSPORTS }, {}, false))
      .toEqual({ transports: EMBEDDER_TRANSPORTS });
  });
});
