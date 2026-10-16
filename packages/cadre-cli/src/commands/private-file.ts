import fs from 'node:fs';
import { mkdir, open, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';

/**
 * Write a file only its owner can read: created mode 600, and narrowed to 600 before any data is
 * written when it already existed, so a secret never sits in a file other accounts can open.
 * POSIX only in effect; Windows ignores the mode.
 */
export function writePrivateFile(file: string, data: string | Uint8Array): void {
  const fd = fs.openSync(file, 'w', 0o600);
  try {
    fs.fchmodSync(fd, 0o600);
    fs.writeFileSync(fd, data);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Create a private file (mode 600; its directory, when created, 700) that must not already
 * exist, and fsync it before returning. Unlike {@link writePrivateFileAtomically} it never
 * replaces a file, not even one another process created a moment earlier: that fails with
 * `EEXIST`. A crash part-way leaves a short file, which a reader must refuse rather than treat
 * as absent; its contents were never handed out, since this had not returned. For a file that is
 * written once and whose loss costs more than a refused start: an owner key.
 */
export async function createPrivateFileDurably(file: string, data: string | Uint8Array): Promise<void> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const handle = await open(file, 'wx', 0o600);
  try {
    await handle.writeFile(data);
    await handle.sync();
  } catch (err) {
    await handle.close().catch(() => {});
    // This process made the file and nothing has read a key from it: leave no short file behind.
    await rm(file, { force: true }).catch(() => {});
    throw err;
  }
  await handle.close();
}

/**
 * Write a private file (mode 600; its directory, when created, 700) atomically and durably: to a
 * sibling temp file, fsync'd, then renamed over `file`, so a crash leaves either the previous file
 * or the complete new one. For a file whose loss or tearing costs more than a retry: the claim
 * record.
 *
 * NOTE: a copy of cadre-core's `writeFileAtomically` (`fs-atomic.ts`), which that package keeps
 * out of its exported surface, minus its best-effort directory fsync; cadre-host carries the
 * same write-then-rename shape in its own stores. If another package needs it, export
 * cadre-core's and use it here too.
 */
export async function writePrivateFileAtomically(file: string, data: string | Uint8Array): Promise<void> {
  const tmpPath = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const handle = await open(tmpPath, 'wx', 0o600);
  try {
    try {
      await handle.writeFile(data);
      await handle.sync();
    } finally {
      await handle.close().catch(() => {});
    }
    await rename(tmpPath, file);
  } catch (err) {
    await rm(tmpPath, { force: true }).catch(() => {});
    throw err;
  }
}

/**
 * The file's permission bits when accounts other than its owner can read or write it, else
 * `undefined`. POSIX only; Windows has no mode bits to read, so there it is always `undefined`.
 */
export function modeOpenToOtherAccounts(file: string): number | undefined {
  if (process.platform === 'win32') return undefined;
  const mode = fs.statSync(file).mode & 0o777;
  return (mode & 0o077) === 0 ? undefined : mode;
}
