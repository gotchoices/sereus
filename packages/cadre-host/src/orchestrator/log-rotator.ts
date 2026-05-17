import {
  existsSync,
  renameSync,
  unlinkSync,
} from 'node:fs';
import { join } from 'node:path';

/**
 * On-disk log rotation helper.
 *
 * Children spawned by the orchestrator inherit a direct file descriptor to
 * their `node.log` (see `host-process-orchestrator.ts`), so rotation can no
 * longer be driven by an in-process byte counter — renaming the path under a
 * running child would leave it writing to the renamed inode. Instead the
 * orchestrator calls `rotateOnDisk(...)` at spawn time, before the child is
 * launched and its fd is opened. This is the only safe point to rotate
 * without coordinating with the running process.
 *
 * Within a workdir there is at most one live child, so spawn-time rotation
 * is sufficient for v1: a child that exceeds `logMaxBytes` mid-run will
 * keep appending to the active file until it (or its successor) is restarted.
 */

/**
 * Perform a rotation cascade against on-disk paths: drop the oldest, then
 * shift `.N-1 → .N`, …, `.1 → .2`, and finally `filePath → .1`.
 *
 * Caller is responsible for deciding when to rotate (e.g. when
 * `statSync(filePath).size >= logMaxBytes`). No fd is held by this helper.
 */
export function rotateOnDisk(filePath: string, maxFiles: number): void {
  if (maxFiles < 1) return;

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
}

/** Build the standard log file path for a workdir. */
export function defaultLogPath(workdir: string): string {
  return join(workdir, 'node.log');
}
