import { describe, it, expect } from 'vitest';
import { multiaddr } from '@multiformats/multiaddr';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import type { Libp2p } from '@libp2p/interface';
import {
  StrandAddrService,
  collectStrandAddrs,
  STRAND_ADDR_PROTOCOL,
  type StrandAddrServiceOptions
} from '../src/strand-addr-protocol.js';
import type { StrandAddrRequest, StrandAddrResponse } from '../src/types.js';
import {
  frameMessage,
  decodeFrames,
  duplexPair,
  CapturingStream,
  NeverEndingStream,
  PausableStream
} from './wake-stream-helpers.js';

/** A valid Ed25519 libp2p peer id string (so `peerIdFromString` round-trips). */
async function freshPeerId(): Promise<string> {
  return peerIdFromPrivateKey(await generateKeyPair('Ed25519')).toString();
}

/** Construct a service: members allowed by default, addrs from a fixed list or per-strand fn. */
function makeService(
  addrs: string[] | ((strandId: string) => string[]),
  overrides: Partial<StrandAddrServiceOptions> = {}
): StrandAddrService {
  return new StrandAddrService({
    isMember: overrides.isMember ?? (async () => true),
    getStrandMultiaddrs:
      overrides.getStrandMultiaddrs ?? (typeof addrs === 'function' ? addrs : () => addrs),
    readTimeoutMs: overrides.readTimeoutMs,
    maxConcurrent: overrides.maxConcurrent
  });
}

/** Invoke the private read→decide→respond stream handler. */
function runHandleStream(service: StrandAddrService, stream: unknown, remotePeerId: string): Promise<void> {
  return (service as unknown as { handleStream(s: unknown, p: string): Promise<void> }).handleStream(stream, remotePeerId);
}

describe('STRAND_ADDR_PROTOCOL', () => {
  it('exports the expected protocol id', () => {
    expect(STRAND_ADDR_PROTOCOL).toBe('/sereus/strand-addr/1.0.0');
  });
});

describe('StrandAddrService.processAddrRequest — decision matrix', () => {
  it('returns the local strand addrs for a member + running strand', async () => {
    const lookups: string[] = [];
    const service = makeService((id) => {
      lookups.push(id);
      return ['/ip4/10.0.0.1/tcp/5001/p2p/strand-node'];
    });

    const response = await service.processAddrRequest({ strandId: 'running' }, 'member-peer');

    expect(lookups).toEqual(['running']);
    expect(response).toEqual({
      strandId: 'running',
      multiaddrs: ['/ip4/10.0.0.1/tcp/5001/p2p/strand-node']
    });
  });

  it('refuses a non-member sender with empty multiaddrs, before any strand lookup', async () => {
    const service = makeService(
      () => { throw new Error('non-member must be refused before strand lookup'); },
      { isMember: async () => false }
    );

    const response = await service.processAddrRequest({ strandId: 'strand-1' }, 'stranger-peer');

    expect(response).toEqual({ strandId: 'strand-1', multiaddrs: [] });
  });

  it('returns empty multiaddrs when the strand is not running locally', async () => {
    // getStrandMultiaddrs returns [] when there is no live strand node.
    const service = makeService(() => []);

    const response = await service.processAddrRequest({ strandId: 'hibernating' }, 'member-peer');

    expect(response).toEqual({ strandId: 'hibernating', multiaddrs: [] });
  });
});

describe('StrandAddrService.handleStream — framing round-trip', () => {
  it('reads a length-prefixed request and replies with a framed response carrying the addrs', async () => {
    const addrs = ['/ip4/10.0.0.1/tcp/5001/p2p/strand-a', '/ip4/10.0.0.1/tcp/5001/p2p-circuit'];
    const service = makeService(addrs);

    const request: StrandAddrRequest = { strandId: 'framed' };
    const stream = new CapturingStream([frameMessage(request)]);

    await runHandleStream(service, stream, 'member-peer');

    expect(stream.closed).toBe(true);
    expect(decodeFrames<StrandAddrResponse>(stream.sent)).toEqual({ strandId: 'framed', multiaddrs: addrs });
  });

  it('replies with empty multiaddrs for a non-member sender', async () => {
    const service = makeService(['/ip4/10.0.0.1/tcp/5001/p2p/strand-a'], { isMember: async () => false });

    const request: StrandAddrRequest = { strandId: 'framed' };
    const stream = new CapturingStream([frameMessage(request)]);

    await runHandleStream(service, stream, 'stranger-peer');

    expect(decodeFrames<StrandAddrResponse>(stream.sent)).toEqual({ strandId: 'framed', multiaddrs: [] });
  });

  it('replies with empty multiaddrs to an oversized/malformed frame (length-prefix guard)', async () => {
    const service = makeService(['/ip4/10.0.0.1/tcp/5001/p2p/strand-a']);

    // A frame declaring a 2,000,000-byte body (far past the 64KB cap) but carrying
    // only a few bytes: the shared length guard throws, and the handler converts
    // that into an empty response rather than dropping the stream.
    const malformed = new Uint8Array(8);
    new DataView(malformed.buffer).setUint32(0, 2_000_000, false);
    const stream = new CapturingStream([malformed]);

    await runHandleStream(service, stream, 'member-peer');

    const response = decodeFrames<StrandAddrResponse>(stream.sent);
    expect(response.multiaddrs).toEqual([]);
  });

  it('replies with empty multiaddrs when streamed bytes exceed the 64KB cap (accumulation guard)', async () => {
    const service = makeService(['/ip4/10.0.0.1/tcp/5001/p2p/strand-a']);

    // Stream many chunks whose running total passes the 64KB cap before EOF — this
    // trips readFrame's per-chunk accumulation cap, distinct from the length-prefix
    // guard above (which rejects a *declared* length).
    const chunks = Array.from({ length: 9 }, () => new Uint8Array(8 * 1024));
    const stream = new CapturingStream(chunks);

    await runHandleStream(service, stream, 'member-peer');

    const response = decodeFrames<StrandAddrResponse>(stream.sent);
    expect(response.multiaddrs).toEqual([]);
  });
});

describe('StrandAddrService.handleStream — read-timeout + concurrency cap', () => {
  it('settles within the read timeout (does not hang) on a never-half-closing stream', async () => {
    // A peer that opens a stream and never half-closes its write end: the read
    // timeout aborts + rejects so the handler emits an empty response instead of
    // hanging. The vitest test timeout is the backstop — a hang fails, not passes.
    const service = makeService(['/ip4/10.0.0.1/tcp/5001/p2p/strand-a'], { readTimeoutMs: 50 });
    const stream = new NeverEndingStream();

    await runHandleStream(service, stream, 'member-peer');

    const response = decodeFrames<StrandAddrResponse>(stream.sent);
    expect(response.multiaddrs).toEqual([]);
    expect(stream.aborted).toBeTruthy();
    expect(stream.closed).toBe(true);
    expect(service.activeCount).toBe(0);
  });

  it('rejects over the concurrency cap with an empty response, without looking up any address', async () => {
    let lookups = 0;
    const service = makeService(
      () => { lookups++; return ['/ip4/10.0.0.1/tcp/5001/p2p/strand-a']; },
      { maxConcurrent: 2 }
    );

    // Hold the cap full with two in-flight reads (parked until released). The
    // synchronous activeStreams++ runs before the first await, so two calls
    // saturate the cap before the overflow attempt is made.
    const held = [new PausableStream(), new PausableStream()];
    for (const s of held) void runHandleStream(service, s, 'member-peer');
    expect(service.activeCount).toBe(2);

    const overflow = new PausableStream();
    await runHandleStream(service, overflow, 'member-peer');

    const response = decodeFrames<StrandAddrResponse>(overflow.sent);
    expect(response.multiaddrs).toEqual([]);
    expect(overflow.closed).toBe(true);
    expect(lookups).toBe(0);
    expect(service.activeCount).toBe(2);

    // Release the held reads so their read-timeout timers clear before teardown.
    for (const s of held) s.release();
  });
});

describe('collectStrandAddrs — client union/dedup', () => {
  /**
   * A mock control node that routes each `dialProtocol(target)` to a per-target
   * loopback receiver. `replies` maps a target's `toString()` (the sibling peerId,
   * since we dial by peerId) to the addrs that sibling reports; `throwing` ids fail
   * the dial. `dialed` records every target dialed (to assert self-exclusion).
   */
  function collectNode(
    selfId: string,
    replies: Map<string, string[]>,
    opts: { throwing?: Set<string>; dialed?: string[] } = {}
  ): Libp2p {
    return {
      peerId: { toString: () => selfId },
      dialProtocol: async (target: unknown) => {
        const id = (target as { toString(): string }).toString();
        opts.dialed?.push(id);
        if (opts.throwing?.has(id)) {
          throw new Error(`dial to ${id} failed`);
        }
        const reply = replies.get(id);
        if (reply === undefined) {
          throw new Error(`no route for ${id}`);
        }
        const receiver = makeService(reply);
        const { clientStream, serverStream } = duplexPair();
        void runHandleStream(receiver, serverStream, selfId);
        return clientStream;
      }
    } as unknown as Libp2p;
  }

  it('unions and dedupes addrs across siblings (signaling-first)', async () => {
    const [self, sib1, sib2] = await Promise.all([freshPeerId(), freshPeerId(), freshPeerId()]);
    const replies = new Map<string, string[]>([
      [sib1, ['/ip4/1.1.1.1/tcp/1', '/ip4/9.9.9.9/tcp/9/p2p-circuit']],
      [sib2, ['/ip4/9.9.9.9/tcp/9/p2p-circuit', '/ip4/2.2.2.2/tcp/2']]
    ]);
    const node = collectNode(self, replies);

    const result = await collectStrandAddrs(node, [{ peerId: sib1 }, { peerId: sib2 }], 'strand-x');

    // Deduped union, with the /p2p-circuit signaling addr ordered first.
    expect(result).toEqual([
      '/ip4/9.9.9.9/tcp/9/p2p-circuit',
      '/ip4/1.1.1.1/tcp/1',
      '/ip4/2.2.2.2/tcp/2'
    ]);
  });

  it('skips a throwing sibling and still returns the others', async () => {
    const [self, sib1, sib2] = await Promise.all([freshPeerId(), freshPeerId(), freshPeerId()]);
    const replies = new Map<string, string[]>([[sib2, ['/ip4/2.2.2.2/tcp/2']]]);
    const node = collectNode(self, replies, { throwing: new Set([sib1]) });

    const result = await collectStrandAddrs(node, [{ peerId: sib1 }, { peerId: sib2 }], 'strand-x');

    expect(result).toEqual(['/ip4/2.2.2.2/tcp/2']);
  });

  it('excludes self — never dials its own peer id, returns only the sibling addrs', async () => {
    const [self, sib] = await Promise.all([freshPeerId(), freshPeerId()]);
    const dialed: string[] = [];
    const replies = new Map<string, string[]>([[sib, ['/ip4/2.2.2.2/tcp/2']]]);
    const node = collectNode(self, replies, { dialed });

    const result = await collectStrandAddrs(node, [{ peerId: self }, { peerId: sib }], 'strand-x');

    expect(result).toEqual(['/ip4/2.2.2.2/tcp/2']);
    expect(dialed).toEqual([sib]);
    expect(dialed).not.toContain(self);
  });

  it('returns [] when no sibling answers', async () => {
    const [self, sib1, sib2] = await Promise.all([freshPeerId(), freshPeerId(), freshPeerId()]);
    const node = collectNode(self, new Map(), { throwing: new Set([sib1, sib2]) });

    const result = await collectStrandAddrs(node, [{ peerId: sib1 }, { peerId: sib2 }], 'strand-x');

    expect(result).toEqual([]);
  });

  it('returns [] when given no candidate peers', async () => {
    const self = await freshPeerId();
    const node = collectNode(self, new Map());

    const result = await collectStrandAddrs(node, [], 'strand-x');

    expect(result).toEqual([]);
  });

  it('falls back to explicit addrs when the peer id is unparsable', async () => {
    const self = await freshPeerId();
    const addr = multiaddr('/ip4/3.3.3.3/tcp/3');
    // 'not-a-peer-id' fails peerIdFromString, so dialTargets falls back to the addr;
    // route the loopback by the addr's toString().
    const replies = new Map<string, string[]>([[addr.toString(), ['/ip4/3.3.3.3/tcp/3/p2p/strand']]]);
    const node = collectNode(self, replies);

    const result = await collectStrandAddrs(
      node,
      [{ peerId: 'not-a-peer-id', addrs: [addr] }],
      'strand-x'
    );

    expect(result).toEqual(['/ip4/3.3.3.3/tcp/3/p2p/strand']);
  });
});
