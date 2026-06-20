/**
 * connection-status.ts — pure derivation of the chat screen's connection banner
 * (color + text) from the cadre lifecycle state.
 *
 * Extracted out of `app/index.tsx` so the mapping is platform-agnostic and
 * unit-testable in isolation: the {@link BackgroundRunner}-driven `resuming` /
 * `degraded` flags surfaced by `useCadreInternal` flow through here on their way
 * to the status bar, and a `renderHook` test can assert that a degraded resume
 * actually reaches the banner without rendering the full react-native screen.
 */

import type { CadreStatus } from './use-cadre';

export interface ConnectionBannerInput {
  /** A foreground resume is settling (control network catching up). */
  resuming: boolean;
  /** A resume settled without the control network reconnecting (offline). */
  degraded: boolean;
  /** Coarse connection status owned by the hook. */
  status: CadreStatus;
  /** Last error message, if any. */
  error: string | null;
  /** Number of attached strands (shown when connected). */
  strandCount: number;
  /** Number of members in the active strand (shown when connected). */
  memberCount: number;
}

export interface ConnectionBanner {
  /** Background color for the status bar. */
  color: string;
  /** Human-readable status line. */
  text: string;
}

/**
 * Map the cadre lifecycle state to the status bar's color + text. `resuming` and
 * `degraded` take precedence over the coarse `status` — a settling/offline
 * resume must show through even while `status` still reads `connected`.
 */
export function connectionBanner(input: ConnectionBannerInput): ConnectionBanner {
  return { color: bannerColor(input), text: bannerText(input) };
}

function bannerColor({ resuming, degraded, status }: ConnectionBannerInput): string {
  if (resuming) return '#ff9800';
  if (degraded) return '#f44336';
  switch (status) {
    case 'connected': return '#4caf50';
    case 'connecting': return '#ff9800';
    case 'error': return '#f44336';
    default: return '#666';
  }
}

function bannerText(input: ConnectionBannerInput): string {
  const { resuming, degraded, status, error, strandCount, memberCount } = input;
  if (resuming) return 'Resuming — syncing…';
  if (degraded) return 'Offline — reconnecting…';
  switch (status) {
    case 'connected': return `Connected · ${strandCount} strand(s) · ${memberCount} member(s)`;
    case 'connecting': return 'Connecting…';
    default: return error ?? 'Not connected — go to Settings';
  }
}
