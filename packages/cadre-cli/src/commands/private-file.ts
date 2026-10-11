import fs from 'node:fs';

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
