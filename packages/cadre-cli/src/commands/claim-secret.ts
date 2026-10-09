import fs from 'node:fs';
import { parseClaimSecret } from '@serfab/cadre-core';

/** Where a claim secret came from, as messages name it. */
export type ClaimSecretSource = 'CADRE_CLAIM_SECRET' | `claim.secretFile (${string})`;

export interface ResolvedClaimSecret {
  /** The secret text, trimmed; undefined when neither source supplies one. */
  secret?: string;
  /** The source, for messages; set whenever `secret` is. */
  source?: ClaimSecretSource;
  /** Non-fatal problems to print, such as a secret file other accounts can read. */
  warnings: string[];
}

/**
 * Settle a node's claim secret from its two sources: `CADRE_CLAIM_SECRET` (already passed
 * through `specifiedEnv`) and the config's `claim.secretFile` (already resolved to an
 * absolute path). Throws when both are set, since each names the secret and a silent choice
 * would hide a stale one, and when the file is missing, unreadable or not a valid secret.
 * The secret itself is never echoed.
 */
export function resolveClaimSecret(envSecret: string | undefined, secretFile: string | undefined): ResolvedClaimSecret {
  if (envSecret !== undefined && secretFile !== undefined) {
    throw new Error('CADRE_CLAIM_SECRET and claim.secretFile (or CADRE_CLAIM_SECRET_FILE) are both set: each names the claim secret. Set one of them.');
  }
  if (envSecret !== undefined) return { secret: envSecret.trim(), source: 'CADRE_CLAIM_SECRET', warnings: [] };
  if (secretFile === undefined) return { warnings: [] };

  const source: ClaimSecretSource = `claim.secretFile (${secretFile})`;
  let text: string;
  try {
    text = fs.readFileSync(secretFile, 'utf-8');
  } catch (err) {
    throw new Error(`Cannot read the claim secret from ${source}: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
  }
  try {
    parseClaimSecret(text);
  } catch (err) {
    throw new Error(`${source} does not hold a valid claim secret: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
  }
  return { secret: text.trim(), source, warnings: permissionWarnings(secretFile) };
}

/** Warn when a secret file is readable by other accounts. POSIX only; Windows has no mode bits to read. */
function permissionWarnings(file: string): string[] {
  if (process.platform === 'win32') return [];
  const mode = fs.statSync(file).mode & 0o777;
  return (mode & 0o077) === 0
    ? []
    : [`${file} is readable by other accounts (mode ${mode.toString(8)}); anyone who reads it can claim this node. Run: chmod 600 ${file}`];
}
