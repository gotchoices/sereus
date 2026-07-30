/**
 * Shared control-network stream primitives.
 *
 * The cadre control protocols — seed delivery (`seed-bootstrap.ts`), push-wake
 * (`strand-wake-protocol.ts`), and strand formation (`strand-formation-protocol.ts`)
 * — all speak 4-byte big-endian length-prefixed JSON frames over a libp2p 3.x
 * stream. This module lifts the previously-triplicated stream shape, frame
 * writer, and `withTimeout` wrapper into one place, and adds a timeout-bounded,
 * abort-on-timeout read-to-EOF helper so a misbehaving peer that opens a stream
 * and never half-closes its write end cannot pin a receiver forever.
 *
 * The sender side of all three protocols is the same exchange — dial under a
 * deadline, write one frame, half-close, read one response, reset the stream on
 * any failure — so that shape lives here too, as {@link withDeadline} +
 * {@link exchangeFrame}; each protocol supplies only its dial options, its
 * request object, and its response decoder.
 *
 * Dependency-free by design: it imports nothing from the protocol modules, so
 * the import graph stays acyclic (`control-stream` ← `seed-bootstrap` ←
 * `strand-wake-protocol`). In particular it returns RAW bytes from
 * {@link readStreamToEnd} rather than decoding a frame — callers own the
 * `decodeLengthPrefixedFrame` guard.
 */

/**
 * Minimal libp2p 3.x stream surface: AsyncIterable for reads, `send()` for
 * writes, `close()` to half-close the write end (EOF), `abort()` to reset.
 */
export interface ControlStream extends AsyncIterable<Uint8Array> {
  send(data: Uint8Array): boolean;
  close(): Promise<void>;
  abort(err: Error): void;
}

/** Write a JSON object as a single 4-byte big-endian length-prefixed frame. */
export function writeFrame(stream: ControlStream, obj: unknown): void {
  const body = new TextEncoder().encode(JSON.stringify(obj));
  const prefix = new Uint8Array(4);
  new DataView(prefix.buffer).setUint32(0, body.length, false);
  stream.send(prefix);
  stream.send(body);
}

/**
 * Reject if `op` does not settle within `ms`. On timeout, invoke `onTimeout`
 * before rejecting — a hook for releasing whatever the op is parked on. A
 * throwing `onTimeout` is swallowed so it cannot mask the timeout rejection. The
 * rejection message is exactly `<label> timed out after <ms>ms`, so callers fold
 * any domain prefix into `label`.
 *
 * Senders want {@link withDeadline}, which wires `onTimeout` to an
 * `AbortController` so the in-flight dial/stream is cancelled rather than leaked.
 */
export function withTimeout<T>(
  ms: number,
  label: string,
  op: () => Promise<T>,
  onTimeout?: () => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      try {
        onTimeout?.();
      } catch {
        // Best-effort: a throwing onTimeout must not replace the timeout error.
      }
      reject(new Error(`${label} timed out after ${ms}ms`));
    }, ms);
    op().then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

/**
 * Run `op` under a `withTimeout` deadline that also *cancels* it: the signal
 * handed to `op` is aborted immediately before the timeout rejection, so a
 * sender can pass it to `dialProtocol` (cancelling an in-flight connect) and to
 * {@link exchangeFrame} (resetting a live stream) instead of leaking either.
 */
export function withDeadline<T>(
  ms: number,
  label: string,
  op: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  return withTimeout(ms, label, () => op(controller.signal), () => controller.abort());
}

/**
 * Send one request frame on an open stream, half-close the write end, and read
 * the response through `readResponse`.
 *
 * `signal` is the caller's deadline (see {@link withDeadline}): an abort resets
 * the stream, releasing the otherwise unbounded response read. If the deadline
 * already fired while the stream was being dialed, the freshly-opened stream is
 * reset here rather than left dangling. Every reset — deadline, response-decode
 * failure, or a `readResponse` that rejects without aborting (the size-cap path
 * of {@link readStreamToEnd}) — goes through one idempotent `abort`, so the
 * deadline listener and the error path cannot double-reset a stream.
 *
 * `readResponse` owns its own read bound, which is a backstop rather than the
 * primary one: the caller's deadline started first and therefore fires first.
 * It matters only when an abort does not release the read (e.g. a stream double
 * whose `abort()` is a no-op).
 */
export async function exchangeFrame<T>(
  stream: ControlStream,
  signal: AbortSignal,
  request: unknown,
  readResponse: (stream: ControlStream) => Promise<T>,
  abortMessage: string,
): Promise<T> {
  let reset = false;
  const resetStream = (err: Error): void => {
    if (reset) return;
    reset = true;
    stream.abort(err);
  };

  const abortErr = new Error(abortMessage);
  const onAbort = (): void => resetStream(abortErr);
  if (signal.aborted) {
    onAbort();
    throw abortErr;
  }
  signal.addEventListener('abort', onAbort, { once: true });

  try {
    writeFrame(stream, request);
    // close() half-closes the write end (EOF) while the read end stays open for
    // the response — the libp2p 3.x request/response pattern.
    await stream.close();
    return await readResponse(stream);
  } catch (err) {
    resetStream(err instanceof Error ? err : new Error(String(err)));
    throw err;
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

/** Normalize a libp2p chunk (Uint8Array or Uint8ArrayList) to a flat Uint8Array. */
function toBytes(chunk: Uint8Array | { subarray(): Uint8Array }): Uint8Array {
  return chunk instanceof Uint8Array ? chunk : chunk.subarray();
}

/**
 * Read a stream to EOF, capped at `maxBytes`, bounded by `timeoutMs`, returning
 * the assembled bytes (the caller decodes via `decodeLengthPrefixedFrame`).
 *
 * Implemented as `Promise.race([readLoop, timeout])`:
 * - The size cap throws synchronously inside `readLoop` (a well-behaved peer may
 *   have sent a real-but-too-large frame and could still be reading for the ack,
 *   so this path does NOT abort the stream — it just rejects).
 * - The timeout path is the true hang: it ALSO calls `stream.abort(err)` to
 *   release the stuck read. The race guarantees the helper settles at the
 *   deadline even if `abort()` does not immediately unblock the iterator (e.g. a
 *   test double whose `abort()` is a no-op).
 */
export function readStreamToEnd(
  stream: ControlStream,
  opts: { maxBytes: number; timeoutMs: number; label: string },
): Promise<Uint8Array> {
  const { maxBytes, timeoutMs, label } = opts;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`${label} read timed out after ${timeoutMs}ms`);
      // Release the hung read; the race below settles on `err` regardless of
      // whether abort() promptly unblocks the iterator.
      try {
        stream.abort(err);
      } catch {
        // Best-effort: a broken/closed stream may reject abort.
      }
      reject(err);
    }, timeoutMs);
  });

  const readLoop = collect(stream, maxBytes, label);

  return Promise.race([readLoop, timeout]).finally(() => clearTimeout(timer));
}

/** Accumulate every chunk to EOF, rejecting once the running total exceeds `maxBytes`. */
async function collect(stream: ControlStream, maxBytes: number, label: string): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const bytes = toBytes(chunk);
    chunks.push(bytes);
    total += bytes.length;
    if (total > maxBytes) {
      throw new Error(`${label} message too large: ${total} bytes exceeds max ${maxBytes}`);
    }
  }

  const data = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    data.set(chunk, offset);
    offset += chunk.length;
  }
  return data;
}
