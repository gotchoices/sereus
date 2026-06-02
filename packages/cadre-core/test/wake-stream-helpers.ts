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

  constructor(private readonly inbound: Uint8Array[]) {}

  send(data: Uint8Array): boolean {
    this.sent.push(data);
    return true;
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  abort(_err: Error): void {
    // no-op
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
