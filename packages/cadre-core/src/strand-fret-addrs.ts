/**
 * Reading the signed address records a running strand node's FRET routing table holds,
 * as per-peer addresses ready for that node's own address book (`peer-addr-book.ts`).
 *
 * Why a strand node needs this. libp2p's peerStore hides every address one hour after
 * it was first observed (the `NOTE:` on `mergePeerAddrs`), and FRET does not re-apply
 * the records it holds: it hands a record to the peerStore when a neighbour's snapshot
 * delivers it or a saved table is imported, and the peerStore refuses a record whose
 * sequence number it already has. So a strand node that has been up for more than an
 * hour would have no address for a peer whose connection then drops, although FRET
 * still holds that peer's record. `CadreNode.refreshStrandPeerAddrs` re-merges the
 * records on every pass, which is what keeps another party's strand nodes dialable;
 * own-party siblings are re-resolved separately, over the strand-addr RPC.
 *
 * How long a record is available here is FRET's rule, not this module's: while FRET
 * holds the entry, and at most 14 days after the record was last confirmed (a peer
 * connected at export time counts as confirmed then).
 *
 * Every record is opened and verified here rather than taken on FRET's word. A record
 * is self-certifying, the table is reached through a structural type rather than an
 * interface this package depends on, and the address book write is attributed from what
 * the record proves, not from the id the table filed it under.
 */

import debug from 'debug';
import { PeerRecord, RecordEnvelope } from '@libp2p/peer-record';
import { peerIdFromPublicKey } from '@libp2p/peer-id';
import { multiaddr, type Multiaddr } from '@multiformats/multiaddr';
import { fromString as uint8ArrayFromString } from 'uint8arrays';
import { withTrailingPeerId } from './peer-record.js';

const log = debug('sereus:cadre:strand-fret-addrs');

/** The slice of FRET's exported routing table read here (`SerializedTable` in `p2p-fret`). */
interface FretTableSlice {
  entries: ReadonlyArray<{
    id: string;
    /** `envelope` is the base64url of a marshaled libp2p record envelope. */
    addressRecord?: { envelope: string };
  }>;
}

/** The slice of FRET's libp2p service called here. */
interface FretTableSource {
  exportTable(): FretTableSlice;
}

/**
 * The slice of a strand's libp2p node this module touches. Structurally satisfied by
 * `Libp2p`; db-p2p registers FRET as `services.fret`.
 */
export interface FretAddrHost {
  peerId: { toString(): string };
  services?: Record<string, unknown>;
}

/** What one read of a strand node's FRET table yields. */
export interface FretPeerAddrs {
  /** Peer id → the addresses its record lists, each bound to that peer. Table order. */
  peers: Map<string, Multiaddr[]>;
  /**
   * Records left out because they did not decode, did not verify, or were not signed
   * by and about the peer the table filed them under.
   */
  rejected: number;
}

/**
 * The addresses of every peer `host`'s FRET table holds a usable signed record for,
 * `host` itself excluded. A node with no FRET service (a db-p2p build without it, a
 * test double) reads as an empty table. One bad record never costs the others: it is
 * counted in `rejected` and skipped.
 *
 * Throws only what `exportTable()` throws, which a caller treats like any other
 * failure of a pass over a node that may be mid-teardown.
 */
export async function strandFretPeerAddrs(host: FretAddrHost): Promise<FretPeerAddrs> {
  const result: FretPeerAddrs = { peers: new Map(), rejected: 0 };
  const fret = host.services?.fret;
  if (!isFretTableSource(fret)) {
    return result;
  }
  const selfId = host.peerId.toString();
  for (const entry of fret.exportTable().entries) {
    if (entry.id === selfId || entry.addressRecord === undefined) {
      continue;
    }
    const addrs = await verifiedRecordAddrs(entry.id, entry.addressRecord.envelope);
    if (addrs === null) {
      result.rejected++;
    } else if (addrs.length > 0) {
      result.peers.set(entry.id, addrs);
    }
  }
  return result;
}

function isFretTableSource(service: unknown): service is FretTableSource {
  return typeof service === 'object' && service !== null
    && typeof (service as { exportTable?: unknown }).exportTable === 'function';
}

/**
 * The addresses one record lists, bound to `peerId`; null when the record must not be
 * used. `openAndCertify` proves only that the envelope's own key signed it, so the
 * signer and the peer the payload describes are each held against `peerId` here:
 * without that, any peer could sign a record rewriting another peer's addresses.
 */
async function verifiedRecordAddrs(peerId: string, envelope: string): Promise<Multiaddr[] | null> {
  try {
    const opened = await RecordEnvelope.openAndCertify(uint8ArrayFromString(envelope, 'base64url'), PeerRecord.DOMAIN);
    const record = PeerRecord.createFromProtobuf(opened.payload);
    const signer = peerIdFromPublicKey(opened.publicKey).toString();
    const subject = record.peerId.toString();
    if (signer !== peerId || subject !== peerId) {
      log('skipping the address record filed under %s: signed by %s about %s', peerId, signer, subject);
      return null;
    }
    return bindToPeer(record.multiaddrs.map((addr) => addr.toString()), peerId);
  } catch (error) {
    log('skipping the address record filed under %s: %o', peerId, error);
    return null;
  }
}

/**
 * A record names its peer once, in `peerId`, so its addresses carry no trailing
 * `/p2p/<peerId>` and a relay-only peer's circuit address ends at the relay hop
 * (`…/p2p/<relay>/p2p-circuit`). Each is given the suffix that makes it a complete
 * dial target; one already terminating in a different peer id does not reach this peer
 * and is dropped.
 *
 * Takes strings because `@libp2p/peer-record` carries its own `@multiformats/multiaddr`
 * copy, a structurally different type from the one `withTrailingPeerId` takes.
 */
function bindToPeer(addrs: string[], peerId: string): Multiaddr[] {
  const bound: Multiaddr[] = [];
  for (const addr of addrs) {
    const withPeer = withTrailingPeerId(multiaddr(addr), peerId);
    if (withPeer !== null) {
      bound.push(withPeer);
    }
  }
  return bound;
}
