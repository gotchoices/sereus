/**
 * Cross-platform PID liveness check using only stdlib.
 *
 * `process.kill(pid, 0)` sends signal 0, which performs error checking
 * without actually delivering a signal:
 *   - returns successfully when the process exists and we have permission
 *   - throws EPERM when the process exists but is owned by another user
 *     (common on Windows where signals don't translate cleanly)
 *   - throws ESRCH when the process does not exist
 */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // EPERM means the process exists but we lack permission to signal it.
    // That's still "alive" from a liveness perspective.
    return code === 'EPERM';
  }
}
