/**
 * Platform detection helpers for the installer.
 *
 * Kept narrow on purpose — `process.platform` everywhere else in the
 * installer is funneled through here so tests can stub a single point.
 */

export type SupportedPlatform = 'linux' | 'darwin' | 'win32';

const SUPPORTED: ReadonlySet<NodeJS.Platform> = new Set<NodeJS.Platform>([
  'linux',
  'darwin',
  'win32',
]);

export function detectPlatform(p: NodeJS.Platform = process.platform): SupportedPlatform {
  if (!SUPPORTED.has(p)) {
    throw new Error(
      `Unsupported platform: ${p}. cadre-host install supports linux, darwin, win32.`,
    );
  }
  return p as SupportedPlatform;
}

export function isPosix(p: SupportedPlatform): boolean {
  return p === 'linux' || p === 'darwin';
}
