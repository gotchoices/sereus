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
 * Write a private file (mode 600; its directory, when created, 700) atomically and durably: to a
 * sibling temp file, fsync'd, then renamed over `file`, so a crash leaves either the previous file
 * or the complete new one. For a file whose loss or tearing costs more than a retry: the claim
 * record, an owner key.
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
