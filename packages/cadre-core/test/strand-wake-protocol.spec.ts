import { describe, it, expect } from 'vitest';
import { multiaddr } from '@multiformats/multiaddr';
import type { Libp2p } from '@libp2p/interface';
import {
  StrandWakeService,
  dialWake,
  WAKE_PROTOCOL,
  type StrandWakeServiceOptions
} from '../src/strand-wake-protocol.js';
import type { StrandInstance, StrandStatus, WakeAck, WakeRequest } from '../src/types.js';
import { frameMessage, decodeFrames, duplexPair, CapturingStream } from './wake-stream-helpers.js';

/** Build a strand instance in a given status (defaults to hibernating). */
function makeInstance(strandId = 'strand-1', status: StrandStatus = 'hibernating'): StrandInstance {
  return {
    strandId,
    status,
    connectedPeers: 0,
    lastActivity: new Date(0),
    latencyHint: 'interactive'
  };
}

/** Construct a service with the given option overrides (member + present strand by default). */
function makeService(
  instance: StrandInstance | undefined,
  overrides: Partial<StrandWakeServiceOptions> = {}
): StrandWakeService {
  return new StrandWakeService({
    isMember: overrides.isMember ?? (async () => true),
    getStrand: overrides.getStrand ?? ((id) => (instance && id === instance.strandId ? instance : undefined)),
    wake: overrides.wake ?? (async () => {})
  });
}

/** Invoke the private read→decide→ack stream handler. */
function runHandleStream(service: StrandWakeService, stream: unknown, remotePeerId: string): Promise<void> {
  return (service as unknown as { handleStream(s: unknown, p: string): Promise<void> }).handleStream(stream, remotePeerId);
}

describe('WAKE_PROTOCOL', () => {
  it('exports the expected protocol id', () => {
    expect(WAKE_PROTOCOL).toBe('/sereus/strand-wake/1.0.0');
  });
});

describe('StrandWakeService.processWakeRequest — decision matrix', () => {
  it('wakes a hibernating strand and returns accepted + post-wake status', async () => {
    const instance = makeInstance('hib');
    const wakeCalls: string[] = [];
    const service = makeService(instance, {
      wake: async (id) => { wakeCalls.push(id); instance.status = 'active'; }
    });

    const ack = await service.processWakeRequest({ strandId: 'hib', reason: 'activity' }, 'member-peer');

    expect(wakeCalls).toEqual(['hib']);
    expect(ack).toEqual({ accepted: true, status: 'active' });
  });

  it('also wakes an idle strand', async () => {
    const instance = makeInstance('idle-strand', 'idle');
    const wakeCalls: string[] = [];
    const service = makeService(instance, {
      wake: async (id) => { wakeCalls.push(id); instance.status = 'active'; }
    });

    const ack = await service.processWakeRequest({ strandId: 'idle-strand' }, 'member-peer');

    expect(wakeCalls).toEqual(['idle-strand']);
    expect(ack.accepted).toBe(true);
    expect(ack.status).toBe('active');
  });

  it('does not re-wake an already-active strand but still accepts', async () => {
    const instance = makeInstance('live', 'active');
    let waked = false;
    const service = makeService(instance, { wake: async () => { waked = true; } });

    const ack = await service.processWakeRequest({ strandId: 'live' }, 'member-peer');

    expect(waked).toBe(false);
    expect(ack).toEqual({ accepted: true, status: 'active' });
  });

  it('rejects a wake for an unknown / unparticipated strand', async () => {
    const service = makeService(undefined, {
      getStrand: () => undefined,
      wake: async () => { throw new Error('should not wake an unknown strand'); }
    });

    const ack = await service.processWakeRequest({ strandId: 'nope' }, 'member-peer');

    expect(ack.accepted).toBe(false);
    expect(ack.reason).toMatch(/not found|not participated/i);
  });

  it('rejects a wake from a non-member peer before touching any strand', async () => {
    let waked = false;
    const service = makeService(undefined, {
      isMember: async () => false,
      getStrand: () => { throw new Error('non-member must be rejected before strand lookup'); },
      wake: async () => { waked = true; }
    });

    const ack = await service.processWakeRequest({ strandId: 'strand-1' }, 'stranger-peer');

    expect(ack.accepted).toBe(false);
    expect(ack.reason).toMatch(/not a cadre member/i);
    expect(waked).toBe(false);
  });
});

describe('StrandWakeService.handleStream — framing round-trip', () => {
  it('reads a length-prefixed request frame and replies with a framed ack', async () => {
    const instance = makeInstance('framed');
    const service = makeService(instance, { wake: async () => { instance.status = 'active'; } });

    const request: WakeRequest = { strandId: 'framed', reason: 'activity' };
    const stream = new CapturingStream([frameMessage(request)]);

    await runHandleStream(service, stream, 'member-peer');

    expect(stream.closed).toBe(true);
    expect(decodeFrames<WakeAck>(stream.sent)).toEqual({ accepted: true, status: 'active' });
  });

  it('replies accepted:false to an oversized/malformed frame (decodeLengthPrefixedFrame guard)', async () => {
    const service = makeService(makeInstance(), { wake: async () => { throw new Error('should not wake'); } });

    // A frame declaring a 2,000,000-byte body (far past the 64KB wake cap) but
    // carrying only a few bytes: the shared length guard throws, and the handler
    // converts that into a non-accepting ack rather than dropping the stream.
    const malformed = new Uint8Array(8);
    new DataView(malformed.buffer).setUint32(0, 2_000_000, false);
    const stream = new CapturingStream([malformed]);

    await runHandleStream(service, stream, 'member-peer');

    const ack = decodeFrames<WakeAck>(stream.sent);
    expect(ack.accepted).toBe(false);
    expect(ack.reason).toBeTruthy();
  });
});

describe('dialWake — sender round-trip against a live receiver', () => {
  /** A mock control node whose dialProtocol loops straight into a receiver service. */
  function loopbackNode(receiver: StrandWakeService, remotePeerId = 'member-peer'): Libp2p {
    return {
      dialProtocol: async () => {
        const { clientStream, serverStream } = duplexPair();
        void runHandleStream(receiver, serverStream, remotePeerId);
        return clientStream;
      }
    } as unknown as Libp2p;
  }

  it('sends a request and returns the receiver ack, waking the strand', async () => {
    const instance = makeInstance('push');
    const wakeCalls: string[] = [];
    const receiver = makeService(instance, {
      wake: async (id) => { wakeCalls.push(id); instance.status = 'active'; }
    });

    const ack = await dialWake(
      loopbackNode(receiver),
      [multiaddr('/ip4/1.2.3.4/tcp/4001')],
      { strandId: 'push', reason: 'activity' }
    );

    expect(ack).toEqual({ accepted: true, status: 'active' });
    expect(wakeCalls).toEqual(['push']);
  });

  it('rejects (without waking) when the receiver sees a non-member sender', async () => {
    const instance = makeInstance('push');
    let waked = false;
    const receiver = makeService(instance, {
      isMember: async () => false,
      wake: async () => { waked = true; }
    });

    const ack = await dialWake(
      loopbackNode(receiver),
      [multiaddr('/ip4/1.2.3.4/tcp/4001')],
      { strandId: 'push' }
    );

    expect(ack.accepted).toBe(false);
    expect(waked).toBe(false);
  });

  it('falls through to the next address when the first dial fails', async () => {
    const instance = makeInstance('push');
    const receiver = makeService(instance, { wake: async () => { instance.status = 'active'; } });

    let attempts = 0;
    const node = {
      dialProtocol: async () => {
        attempts++;
        if (attempts === 1) throw new Error('first address unreachable');
        const { clientStream, serverStream } = duplexPair();
        void runHandleStream(receiver, serverStream, 'member-peer');
        return clientStream;
      }
    } as unknown as Libp2p;

    const ack = await dialWake(
      node,
      [multiaddr('/ip4/1.1.1.1/tcp/1'), multiaddr('/ip4/2.2.2.2/tcp/2')],
      { strandId: 'push' }
    );

    expect(attempts).toBe(2);
    expect(ack.accepted).toBe(true);
  });

  it('throws when given no dialable addresses', async () => {
    const node = { dialProtocol: async () => { throw new Error('should not dial'); } } as unknown as Libp2p;
    await expect(dialWake(node, [], { strandId: 's' })).rejects.toThrow(/no dialable/i);
  });
});
