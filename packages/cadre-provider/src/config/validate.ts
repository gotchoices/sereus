/**
 * Configuration validation helpers.
 */

import type { AuthConfig } from './types.js';

/**
 * Throws when the auth configuration would silently run the provider fully
 * open. Mode 'none' disables authentication and grants every caller a wildcard
 * identity, so it must be explicitly acknowledged via `allowInsecureNoAuth`.
 */
export function validateAuthConfig(auth: AuthConfig): void {
  if (auth.mode === 'none' && auth.allowInsecureNoAuth !== true) {
    throw new Error(
      "auth.mode 'none' disables authentication and runs fully open. " +
        'Set auth.allowInsecureNoAuth=true (or PROVIDER_ALLOW_INSECURE_NO_AUTH=true) ' +
        "to acknowledge, or use 'api-key'/'oauth'."
    );
  }
}
