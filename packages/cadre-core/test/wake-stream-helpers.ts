/**
 * In-memory libp2p-stream test doubles for the push-wake protocol round-trips.
 *
 * Not a `*.spec.ts` file, so vitest's `test/**\/*.spec.ts` glob never runs it as
 * a suite — it is imported by `strand-wake-protocol.spec.ts` and `cadre-node.spec.ts`.
 */

/** Frame a JSON object as a single 4-byte big-endian length-prefixed Uint8Array. */
export function frameMessage(obj: unknown): Uint8Array {
  const body = new TextEncoder().encode(JSON.stringify(obj));
  const out = new Uint8Array(4 + body.length);
  new DataView(out.buffer).setUint32(0, body.length, false);
  out.set(body, 4);
  return out;
}

/**
 * Reassemble the chunks a service `send()`s (prefix + body as separate writes)
 * and decode the single length-prefixed JSON frame they form.
 */
export function decodeFrames<T>(chunks: Uint8Array[]): T {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const data = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    data.set(chunk, offset);
    offset += chunk.length;
  }
  const length = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(0, false);
  return JSON.parse(new TextDecoder().decode(data.subarray(4, 4 + length))) as T;
}

/** Minimal libp2p 3.x stream surface: AsyncIterable reads + `send()` writes. */
export interface MockStream extends AsyncIterable<Uint8Array> {
  send(data: Uint8Array): boolean;
  close(): Promise<void>;
  abort(err: Error): void;
}

/**
 * A one-directional stream that captures everything `send()` and yields a fixed
 * inbound script — used to drive a receiver's `handleStream` in isolation.
 */
export class CapturingStream implements AsyncIterable<Uint8Array> {
  readonly sent: Uint8Array[] = [];
  closed = false;
  aborted: Error | null = null;

  constructor(private readonly inbound: Uint8Array[]) {}

  send(data: Uint8Array): boolean {
    this.sent.push(data);
    return true;
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  /** Records the reset without releasing the read — the script is finite anyway. */
  abort(err: Error): void {
    this.aborted = err;
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<Uint8Array> {
    for (const chunk of this.inbound) {
      yield chunk;
    }
  }
}

/** A bounded async byte channel: push chunks, end the stream, iterate to EOF. */
class ByteQueue {
  private readonly chunks: Uint8Array[] = [];
  private readonly waiters: Array<(r: IteratorResult<Uint8Array>) => void> = [];
  private ended = false;

  push(chunk: Uint8Array): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ value: chunk, done: false });
    } else {
      this.chunks.push(chunk);
    }
  }

  end(): void {
    this.ended = true;
    let waiter: ((r: IteratorResult<Uint8Array>) => void) | undefined;
    while ((waiter = this.waiters.shift())) {
      waiter({ value: undefined as unknown as Uint8Array, done: true });
    }
  }

  async *iterate(): AsyncGenerator<Uint8Array> {
    for (;;) {
      const buffered = this.chunks.shift();
      if (buffered) {
        yield buffered;
        continue;
      }
      if (this.ended) return;
      const result = await new Promise<IteratorResult<Uint8Array>>((resolve) => this.waiters.push(resolve));
      if (result.done) return;
      yield result.value;
    }
  }
}

function makeStream(read: ByteQueue, write: ByteQueue): MockStream {
  return {
    send: (data: Uint8Array) => {
      write.push(data);
      return true;
    },
    close: async () => {
      write.end();
    },
    abort: () => {
      write.end();
    },
    [Symbol.asyncIterator]: () => read.iterate(),
  };
}

/**
 * A connected client/server libp2p-stream pair: bytes the client sends are read
 * by the server and vice versa, with `close()` signaling EOF on the writer's
 * direction. Lets a `dialWake` sender and a `StrandWakeService` receiver run the
 * real protocol against each other with no libp2p.
 */
export function duplexPair(): { clientStream: MockStream; serverStream: MockStream } {
  const clientToServer = new ByteQueue();
  const serverToClient = new ByteQueue();
  return {
    clientStream: makeStream(serverToClient, clientToServer),
    serverStream: makeStream(clientToServer, serverToClient),
  };
}

/**
 * A stream whose read never completes: its iterator's `next()` returns a promise
 * that never resolves, modeling a peer that opens a stream and never half-closes
 * its write end (the indefinite-hang `readStreamToEnd` guards against). `abort()`
 * records the error but deliberately does NOT unblock the read — so a
 * timeout-settle test proves `readStreamToEnd`'s `Promise.race` settles at the
 * deadline on its own, not because `abort()` happened to release the iterator.
 * Captures `send()` so the bounded non-accepting ack is still assertable.
 */
export class NeverEndingStream implements MockStream {
  readonly sent: Uint8Array[] = [];
  closed = false;
  aborted: Error | null = null;

  send(data: Uint8Array): boolean {
    this.sent.push(data);
    return true;
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  abort(err: Error): void {
    this.aborted = err;
  }

  [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
    return {
      // Never resolves: the read loop parks here until the surrounding timeout
      // aborts/rejects it. A manual iterator (vs an async generator) keeps this a
      // no-yield read without tripping `require-yield`.
      next: () => new Promise<IteratorResult<Uint8Array>>(() => { /* never settles */ }),
    };
  }
}

/**
 * A stream whose read parks until explicitly {@link release}d (or `abort`ed) —
 * lets a test hold N inbound streams "in flight" to exercise a concurrency cap,
 * then release them so their reads reach EOF and no read-timeout timers linger
 * past the test. `abort()` both records the error and releases (mirroring a real
 * stream reset unblocking the read).
 */
export class PausableStream implements MockStream {
  readonly sent: Uint8Array[] = [];
  closed = false;
  aborted: Error | null = null;
  private releaseGate!: () => void;
  private readonly gate = new Promise<void>((resolve) => { this.releaseGate = resolve; });

  send(data: Uint8Array): boolean {
    this.sent.push(data);
    return true;
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  abort(err: Error): void {
    this.aborted = err;
    this.releaseGate();
  }

  /** Release the parked read so it reaches EOF (the stream yields no bytes). */
  release(): void {
    this.releaseGate();
  }

  [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
    const gate = this.gate;
    return {
      async next(): Promise<IteratorResult<Uint8Array>> {
        await gate;
        return { value: undefined as unknown as Uint8Array, done: true };
      },
    };
  }
}
