/**
 * Types for the cadre-host update flow.
 *
 * The update flow is split across:
 *
 *   - manifest.ts — fetch + verify the signed `latest.json` envelope.
 *   - store.ts    — persist the user-facing `UpdateState` to `<dataDir>/update-state.json`.
 *   - apply.ts    — invoke `npm install -g` + rollback on failure.
 *   - index.ts    — composes the above (UpdateService).
 *
 * Mirrors the typed-handler pattern used by trust-circle and NAT (handlers
 * throw `UpdateError` whose `.code` the local-UI maps to HTTP status).
 */

/** Inner manifest object — signed by the release key. */
export interface UpdateManifest {
  /** Schema version. Bumped on incompatible manifest changes. */
  v: 1;
  /** Version string being announced (semver). */
  version: string;
  /** ISO publish timestamp. */
  publishedAt: string;
  /** Per-channel install hints. cadre-host currently only consults `npm`. */
  channels: {
    npm: { package: string; tag: string };
  };
  /** Optional human-facing release-notes URL. */
  releaseNotesUrl?: string;
  /**
   * Minimum previous version that can step directly to this release. If the
   * current install is older, the user must update through an intermediate
   * release first.
   */
  minPreviousVersion?: string;
}

/** Signed envelope as fetched from the manifest URL. */
export interface SignedManifest {
  manifest: UpdateManifest;
  /** Detached signature in the form `ed25519:<base64>`. */
  sig: string;
}

/** Persisted shape of `<dataDir>/update-state.json`. */
export interface UpdateState {
  /** Schema version of this file. */
  version: 1;
  /** ISO timestamp of the most recent successful manifest fetch. */
  lastChecked?: string;
  /** Set when the manifest advertises a version newer than `currentVersion`. */
  available?: {
    version: string;
    publishedAt: string;
    releaseNotesUrl?: string;
  };
  /** Records the version before an apply, so a rollback can target it. */
  applyInProgress?: {
    fromVersion: string;
    toVersion: string;
    startedAt: string;
  };
  /** Most recent apply / verification error, surfaced by the UI banner. */
  lastError?: UpdateError;
}

/** Stable error payload — both thrown via `UpdateErrorException` and serialized into state. */
export interface UpdateError {
  code: UpdateErrorCode;
  message: string;
  at: string;
}

export type UpdateErrorCode =
  | 'signature_invalid'
  | 'manifest_invalid'
  | 'unsupported_state_version'
  | 'apply_in_progress'
  | 'apply_failed'
  | 'rollback_failed'
  | 'min_previous_version'
  | 'no_update_available'
  | 'storage_error';

/** Thrown by UpdateService.apply() and related entry points. */
export class UpdateErrorException extends Error {
  readonly code: UpdateErrorCode;

  constructor(code: UpdateErrorCode, message: string) {
    super(message);
    this.name = 'UpdateErrorException';
    this.code = code;
  }
}

/** Result of a successful apply() — the caller can inspect what just happened. */
export interface UpdateApplyResult {
  fromVersion: string;
  toVersion: string;
  restarted: boolean;
  restartError?: string;
}

/** Subset of `host.config.json` consumed by the update flow. */
export interface UpdateSettings {
  /** When true, the daily timer applies updates automatically. */
  autoApply: boolean;
  /** Optional override for the manifest URL. */
  manifestUrl?: string;
}
