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
  try {
    if (platform === 'darwin') {
      const child = spawn('open', [url], { detached: true, stdio: 'ignore' });
      child.unref();
      return { attempted: true, spawned: true };
    }
    if (platform === 'win32') {
      // rundll32 is the most portable way to invoke the registered handler
      // without going through cmd.exe (which would require escaping URLs).
      const child = spawn('rundll32', ['url.dll,FileProtocolHandler', url], {
        detached: true,
        stdio: 'ignore',
      });
      child.unref();
      return { attempted: true, spawned: true };
    }
    // linux + everything else POSIX-ish
    const child = spawn('xdg-open', [url], { detached: true, stdio: 'ignore' });
    child.unref();
    return { attempted: true, spawned: true };
  } catch (err) {
    return { attempted: true, spawned: false, error: (err as Error).message };
  }
}
