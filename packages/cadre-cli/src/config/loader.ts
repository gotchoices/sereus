import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import debug from 'debug';
import { privateKeyFromProtobuf } from '@libp2p/crypto/keys';
import type { PrivateKey } from '@libp2p/interface';
import { validatePushCredentials } from '@serfab/cadre-core';
import { type OverrideResult, applyEnvOverrides } from '@serfab/config-check';
import type { CliConfig, ResolvedConfig } from './types.js';
import { ENV_OVERRIDES, checkEnvNames } from './env.js';
import { validateConfig } from './schema.js';
import { parseStrandFilter } from './strand-filter.js';

const log = debug('cadre:cli:config');

/**
 * Parse a YAML or JSON config file. Parse only: the result is whatever the file says, checked
 * by nothing yet. {@link loadValidatedConfig} is the entry point that hands back a `CliConfig`.
 */
export async function loadConfigFile(configPath: string): Promise<unknown> {
  const fullPath = path.resolve(configPath);
  log('Loading config from: %s', fullPath);

  if (!fs.existsSync(fullPath)) {
    throw new Error(`Config file not found: ${fullPath}`);
  }

  const content = fs.readFileSync(fullPath, 'utf-8');
  const ext = path.extname(fullPath).toLowerCase();

  if (ext === '.yaml' || ext === '.yml') {
    return yaml.load(content);
  } else if (ext === '.json') {
    return JSON.parse(content);
  } else {
    // Try YAML first, fall back to JSON
    try {
      return yaml.load(content);
    } catch {
      return JSON.parse(content);
    }
  }
}

/**
 * Apply environment variable overrides to a parsed config tree, after rejecting any unknown or
 * retired `CADRE_*` variable by name (see `env.ts`). The tree comes back with every set
 * variable written over it, unchecked, and `provenance` records which variable wrote which path.
 *
 * `env` defaults to `process.env` at call time — `cadre start --identity-file` exports
 * `CADRE_KEY_FILE` just before resolving and relies on that — and tests pass their own.
 */
export function applyEnvironmentOverrides(raw: unknown, env: NodeJS.ProcessEnv = process.env): OverrideResult {
  checkEnvNames(env);
  return applyEnvOverrides(raw, env, ENV_OVERRIDES, logOverride);
}

function logOverride(envVar: string, value: string): void {
  // CADRE_PUSH carries private keys, which are never logged.
  log('Applying env override: %s=%s', envVar, envVar === 'CADRE_PUSH' ? '[redacted]' : value);
}

/**
 * Load the node identity from a libp2p protobuf-encoded private key file.
 *
 * This is the ONE on-disk identity format: what `cadre enroll create` writes, what cadre-host
 * writes to each managed node's `identity.key`, and what the docker entrypoint mints into `cadre-peer.key`.
 * See `@serfab/cadre-host`'s `orchestrator/identity-file.ts` for why the protobuf form rather than raw
 * key bytes.
 */
export function loadIdentityKey(keyPath: string): PrivateKey {
  // NOTE: a relative path resolves against the process working directory, NOT the config file's
  // directory (which is what `nodeStateDir` falls back to). Every shipped launcher passes an
  // absolute path — the docker entrypoint, cadre-host's spawn args, and `cadre-install.sh`'s sed
  // over `example.cadre.yaml` — so the two only diverge for a hand-written relative `keyFile`, and
  // then they fail loudly ("Identity key file not found") rather than quietly. If a launcher ever
  // needs a config-relative key path, resolve it against the config directory here instead.
  const fullPath = path.resolve(keyPath);
  log('Loading identity key from: %s', fullPath);

  if (!fs.existsSync(fullPath)) {
    throw new Error(`Identity key file not found: ${fullPath}`);
  }

  const bytes = fs.readFileSync(fullPath);
  try {
    // NOTE: no fallback decoder here, deliberately. `privateKeyFromRaw` accepts ANY 64 bytes as an
    // Ed25519 key without validating them, so a truncated protobuf used to decode as a *different,
    // valid* identity and the node came up under a PeerId nobody expected.
    // NOTE: this catches structural damage only. A single flipped byte INSIDE the 64-byte payload
    // still decodes, and still yields a different PeerId, because the payload carries no checksum.
    // Closing that needs a recorded peer id to verify against —
    // backlog/debt-identity-key-file-has-no-integrity-check.
    return privateKeyFromProtobuf(new Uint8Array(bytes));
  } catch (err) {
    throw new Error(
      `Invalid identity key file ${fullPath}: not a libp2p protobuf-encoded private key. ` +
      `Regenerate it with 'cadre enroll create', or point identity.keyFile at the correct file.`,
      { cause: err },
    );
  }
}

/**
 * Validate a resolved push block before it reaches `CadreNode.start`.
 *
 * The schema pass has already checked each field's type. The provisioners (cadre-host's
 * secret store, cadre-provider's per-tenant config) reject a partial set, but the cli is the
 * common sink for *both* a file-config `push` block and the `CADRE_PUSH` env override — a
 * hand-edited `cadre.json` or a partial env value would otherwise build a notifier that only
 * fails at the first push. Fail fast at start instead, using cadre-core's shared validator
 * (the dependency-free seam built for exactly this).
 */
function validateResolvedPush(push: CliConfig['push']): void {
  if (!push) return;
  const errors = validatePushCredentials(push);
  if (errors.length > 0) {
    throw new Error(`Invalid push credentials: ${errors.join('; ')}`);
  }
}

/**
 * Load a config file, apply the environment, and check the result — the one path every
 * command takes to a `CliConfig`. Throws one `Error` listing every problem, each attributed
 * to the file or to the variable that wrote the offending value.
 */
export async function loadValidatedConfig(
  configPath: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<CliConfig> {
  const fullPath = path.resolve(configPath);
  const raw = await loadConfigFile(configPath);
  const { tree, provenance } = applyEnvironmentOverrides(raw, env);
  return validateConfig(tree, provenance, fullPath);
}

/**
 * Resolve configuration: load and validate the file with its environment overrides, then
 * load the identity key and settle the node-state directory and strand filter.
 */
export async function resolveConfig(
  configPath: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ResolvedConfig> {
  const fullConfigPath = path.resolve(configPath);
  const config = await loadValidatedConfig(configPath, env);
  validateResolvedPush(config.push);

  // Node-local state (bootstrap-peer store, trusted-owner anchor) lives in an
  // explicit directory when configured, else defaults to the directory holding
  // the config file — every launcher already writes a per-node config into
  // that node's own working directory, so that default is node-specific
  // regardless of how the node's identity is sourced.
  const nodeStateDir = config.nodeState?.dir
    ? path.resolve(config.nodeState.dir)
    : path.dirname(fullConfigPath);

  // Load the node identity if one is configured. One key, one format — an absent `keyFile` means
  // "no identity configured" (CadreNode generates an ephemeral keypair); a present-but-undecodable
  // one throws rather than degrading to that, since a silent regeneration is a new PeerId.
  const privateKey: PrivateKey | undefined = config.identity?.keyFile
    ? loadIdentityKey(config.identity.keyFile)
    : undefined;

  // Everything not resolved into something else is carried over as-is, so a key added to
  // `CliConfig` reaches the node without being listed here.
  // `claim` is stripped like `identity`: `CadreNodeConfig.claim` is the node's claim policy, which
  // `cadre start` builds from the secret, not this file reference.
  const { identity: _identity, nodeState: _nodeState, strandFilter, claim, ...nodeFacing } = config;
  return {
    ...nodeFacing,
    privateKey,
    nodeStateDir,
    strandFilter: parseStrandFilter(strandFilter),
    ...(claim?.secretFile ? { claimSecretFile: path.resolve(claim.secretFile) } : {}),
  };
}
