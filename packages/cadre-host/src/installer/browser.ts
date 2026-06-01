/**
 * Best-effort URL opener. Never throws — if the platform launcher isn't
 * available (headless box, missing xdg-utils, etc.) we just log the URL.
 *
 * Implemented inline rather than pulling in the `open` npm dep so the
 * installer keeps its dependency tree small.
 */

import { spawn } from 'node:child_process';

export interface OpenBrowserResult {
  attempted: boolean;
  spawned: boolean;
  /** Set when the spawn attempt errored synchronously. */
  error?: string;
}

export function openBrowser(url: string, platform: NodeJS.Platform = process.platform): OpenBrowserResult {
  if (platform === 'darwin') return spawnOpener('open', [url]);
  if (platform === 'win32') return spawnOpener('rundll32', ['url.dll,FileProtocolHandler', url]);
  // linux + everything else POSIX-ish
  return spawnOpener('xdg-open', [url]);
}

function spawnOpener(cmd: string, args: string[]): OpenBrowserResult {
  try {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
    // The launcher's absence (ENOENT on a headless box without xdg-utils,
    // etc.) is reported asynchronously via the child's `error` event, not
    // by `spawn()` throwing. Without a listener, Node escalates to an
    // unhandled-error crash and kills the install. Swallow it: this is a
    // best-effort convenience, the install / UI commands have already
    // printed the URL.
    child.on('error', () => { /* best-effort */ });
    child.unref();
    return { attempted: true, spawned: true };
  } catch (err) {
    return { attempted: true, spawned: false, error: (err as Error).message };
  }
}
