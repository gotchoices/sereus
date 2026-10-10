/**
 * How to reach the local UI from where the admin is sitting. On a machine with a desktop, open
 * the URL; over SSH or on a headless server, forward the port from the admin's own computer
 * first. The UI binds 127.0.0.1 only and checks the Host header, so the local port must equal
 * the remote one.
 */

import { hostname, userInfo } from 'node:os';

/** Over SSH, or Linux with no display server: a browser here would show nothing to the admin. */
export function isHeadless(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.SSH_CONNECTION || env.SSH_TTY) return true;
  return platform === 'linux' && !env.DISPLAY && !env.WAYLAND_DISPLAY;
}

/** The lines telling the admin how to open the UI at `port`. */
export function uiAccessLines(port: number, headless: boolean, who: { user: string; host: string } = currentLogin()): string[] {
  const url = `http://127.0.0.1:${port}`;
  if (!headless) return [`Open the UI: ${url}`];
  return [
    'Open the UI from your own computer (this session has no screen):',
    `  ssh -L ${port}:127.0.0.1:${port} ${who.user}@${who.host}`,
    `  then browse to ${url}`,
  ];
}

function currentLogin(): { user: string; host: string } {
  let user = '<you>';
  try {
    user = userInfo().username;
  } catch {
    // no passwd entry (some containers): keep the placeholder
  }
  return { user, host: hostname() };
}
