/**
 * Stream + libp2p-node doubles shared by the three formation specs
 * (`strand-formation-protocol.spec.ts`, `strand-formation-consent.spec.ts`,
 * `strand-formation-manager.spec.ts`).
 *
 * Two flavours of stream, deliberately: {@link MockStream} replays a CANNED inbound frame
 * list (enough to drive a responder whose reply nobody reads back), while
 * {@link QueueStream} is a live in-memory duplex end whose `send()` pushes straight into
 * its peer's reader — needed when both roles run in-process and each must actually see the
 * other's frames.
 */
import type { Libp2p } from '@libp2p/interface';
import type { ControlStream } from '../src/control-stream.js';

/** A `ControlStream` that yields a fixed inbound frame list and records what was written. */
export class MockStream implements ControlStream {
  readonly sent: Uint8Array[] = [];
  closed = false;
  constructor(private readonly inbound: Uint8Array[]) {}
  async *[Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
    for (const chunk of this.inbound) yield chunk;
  }
  send(data: Uint8Array): boolean { this.sent.push(data); return true; }
  async close(): Promise<void> { this.closed = true; }
  abort(): void {}
}

/**
 * One end of an in-memory duplex pipe. `send()` delivers straight into the PEER's inbox (a
 * live push, not a canned reply list), so a real caller on one end can write and a real
 * handler on the other end can read.
 */
export class QueueStream implements ControlStream {
  readonly sent: Uint8Array[] = [];
  closed = false;
  peer!: QueueStream;
  private readonly inbox: Uint8Array[] = [];
  private pendingResolve?: (result: IteratorResult<Uint8Array>) => void;
  private ended = false;

  private deliver(data: Uint8Array): void {
    if (this.pendingResolve) {
      const resolve = this.pendingResolve;
      this.pendingResolve = undefined;
      resolve({ value: data, done: false });
      return;
    }
    this.inbox.push(data);
  }

  private endInbox(): void {
    this.ended = true;
    if (this.pendingResolve) {
      const resolve = this.pendingResolve;
      this.pendingResolve = undefined;
      resolve({ value: undefined as unknown as Uint8Array, done: true });
    }
  }

  send(data: Uint8Array): boolean {
    this.sent.push(data);
    this.peer.deliver(data);
    return true;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.peer.endInbox();
  }

  abort(_err: Error): void {
    this.closed = true;
    this.peer.endInbox();
  }

  [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
    return {
      next: (): Promise<IteratorResult<Uint8Array>> => {
        if (this.inbox.length > 0) {
          return Promise.resolve({ value: this.inbox.shift()!, done: false });
        }
        if (this.ended) {
          return Promise.resolve({ value: undefined as unknown as Uint8Array, done: true });
        }
        return new Promise((resolve) => { this.pendingResolve = resolve; });
      }
    };
  }
}

/** Two cross-wired `QueueStream`s: `a.send()` reaches `b`'s reader and vice versa. */
export function makeStreamPair(): [QueueStream, QueueStream] {
  const a = new QueueStream();
  const b = new QueueStream();
  a.peer = b;
  b.peer = a;
  return [a, b];
}

/** A mock node that captures the registered protocol handler so it can be driven directly. */
export function captureHandler(): { node: Libp2p; invoke: (stream: ControlStream) => Promise<void> } {
  let handler: ((stream: unknown, conn: unknown) => Promise<void>) | undefined;
  const node = {
    handle: (_id: string, fn: (stream: unknown, conn: unknown) => Promise<void>) => { handler = fn; },
    unhandle: () => {}
  } as unknown as Libp2p;
  return {
    node,
    invoke: async (stream: ControlStream) => {
      if (!handler) throw new Error('handler not registered');
      await handler(stream, {});
    }
  };
}

/** A `Libp2p` double whose `dialProtocol` bridges straight into a responder's own handler. */
export function bridgingDialer(invoke: (stream: ControlStream) => Promise<void>): Libp2p {
  return {
    dialProtocol: async () => {
      const [respEnd, initEnd] = makeStreamPair();
      // The responder handler owns its own error reporting; anything escaping it would
      // otherwise surface as an unhandled rejection with no attribution.
      void invoke(respEnd).catch((err: unknown) => console.error('responder handler threw', err));
      return initEnd;
    }
  } as unknown as Libp2p;
}
