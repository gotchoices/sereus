/**
 * Pick the right service-host impl for the current platform.
 */

import { detectPlatform, type SupportedPlatform } from '../platform.js';
import { SystemdServiceHost } from './systemd.js';
import { LaunchdServiceHost } from './launchd.js';
import { NssmServiceHost } from './nssm.js';
import type { ServiceHost } from './types.js';

export type { ServiceHost, ServiceHostContext, ServiceHostStatus } from './types.js';

export function createServiceHost(platform: SupportedPlatform = detectPlatform()): ServiceHost {
  switch (platform) {
    case 'linux':  return new SystemdServiceHost();
    case 'darwin': return new LaunchdServiceHost();
    case 'win32':  return new NssmServiceHost();
  }
}

export { SystemdServiceHost, LaunchdServiceHost, NssmServiceHost };
