import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { Writable } from 'node:stream';

export interface LogRotatorOptions {
  /** Active log file path (e.g. <workdir>/node.log). */
  filePath: string;
  /** Bytes threshold at which a rotation occurs. */
  maxBytes: number;
  /** Maximum number of rotated files retained (e.g. 5 keeps .1..5). */
  maxFiles: number;
}

/**
 * Size-based rotating log writer. Backed by `fs.writeSync` rather than a
 * `WriteStream` so that rotation can rename files immediately — Windows
 * holds file locks until a WriteStream's async close fully drains, which
 * makes renameSync racy.
 */
export class LogRotator {
  private fd: number;
  private bytes: number;
  private closed = false;
  private readonly writable: Writable;

  constructor(private readonly opts: LogRotatorOptions) {
    mkdirSync(dirname(opts.filePath), { recursive: true });
    this.fd = openSync(opts.filePath, 'a');
    let initial = 0;
    try {
      initial = statSync(opts.filePath).size;
    } catch {
      initial = 0;
    }
    this.bytes = initial;

    this.writable = new Writable({
      write: (chunk: Buffer | string, _enc, cb) => {
        try {
          this.write(chunk);
          cb();
        } catch (err) {
          cb(err as Error);
        }
      },
    });
  }

  /** Writable that child stdio can be piped into. */
  writeStream(): Writable {
    return this.writable;
  }

  write(chunk: string | Buffer): void {
    if (this.closed) return;
    const data = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    writeSync(this.fd, data);
    this.bytes += data.byteLength;
    if (this.bytes >= this.opts.maxBytes) {
      this.rotate();
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try { closeSync(this.fd); } catch { /* ignore */ }
  }

  private rotate(): void {
    if (this.closed) return;
    const { filePath, maxFiles } = this.opts;

    // Close current fd before renaming on Windows.
    try { closeSync(this.fd); } catch { /* ignore */ }

    // Drop oldest, then shift .N-1 -> .N, ..., .1 -> .2, base -> .1
    const oldest = `${filePath}.${maxFiles}`;
    if (existsSync(oldest)) {
      try { unlinkSync(oldest); } catch { /* ignore */ }
    }
    for (let i = maxFiles - 1; i >= 1; i--) {
      const from = `${filePath}.${i}`;
      const to = `${filePath}.${i + 1}`;
      if (existsSync(from)) {
        try { renameSync(from, to); } catch { /* ignore */ }
      }
    }
    if (existsSync(filePath)) {
      try { renameSync(filePath, `${filePath}.1`); } catch { /* ignore */ }
    }

    this.fd = openSync(filePath, 'a');
    this.bytes = 0;
  }
}

/** Build the standard log file path for a workdir. */
export function defaultLogPath(workdir: string): string {
  return join(workdir, 'node.log');
}
