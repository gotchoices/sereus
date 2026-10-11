/**
 * Strict validation of the node configuration tree.
 *
 * `validateConfig` runs once, on the file's tree with the environment already written over
 * it, and either returns a complete `CliConfig` or throws one `Error` listing every problem
 * — an operator fixing a hand-edited file should not have to restart once per typo. Each
 * line names the offending key and its source: the config file, or the `CADRE_*` variable
 * whose write covers that key.
 *
 * The validator owns *shape*: which keys exist, their types, closed value sets, integer-ness,
 * non-emptiness of identifiers and paths. Range checks that already fail loudly downstream
 * stay there and are not repeated here (multiaddr syntax and transport support, the
 * `*Ms` network values being above zero, push credential completeness).
 *
 * The checker mechanism — `objectOf`'s field tables, the message wording, the typo suggestion,
 * `null` meaning an absent block — is `@serfab/config-check`'s, so that every Sereus program
 * reading a config file checks it the same way. What is here is cadre-cli's own: one field table per block
 * of `CliConfig`, and which `CADRE_*` variables can supply a missing key.
 */

import type { ApnsCredentials, FcmCredentials, LatencyHint, NodeProfile, PushCredentials } from '@serfab/cadre-core';
import {
  type Checker,
  arrayOf,
  booleanValue,
  describeValue,
  finiteNumber,
  nonEmptyString,
  nonNegativeInteger,
  nonNegativeNumber,
  objectOf,
  oneOf,
  positiveNumber,
  refine,
  secretString,
  stringValue,
  validateTree,
} from '@serfab/config-check';
import type { CliConfig, StrandFilterConfig } from './types.js';
import { ENV_MAPPINGS } from './env.js';
import { parseStrandFilter } from './strand-filter.js';

// ---------------------------------------------------------------------------
// Field tables — one per block of CliConfig, plus cadre-core's push credential types
// ---------------------------------------------------------------------------

type Block<K extends keyof CliConfig> = NonNullable<CliConfig[K]>;

/**
 * A named-but-valueless `keyFile` is the trap: `identity:\n  keyFile:` parses to `{ keyFile: null }`
 * and would otherwise resolve to *no identity*, so the node generates a fresh keypair and comes
 * up as a stranger to its own cadre. Same for `''`, whitespace, or a non-string. The operator
 * plainly meant to configure an identity; say so instead of re-keying the node.
 */
const identityKeyFile: Checker<string> = (value, keyPath, ctx) =>
  typeof value === 'string' && value.trim() !== ''
    ? value
    : ctx.fail(
      keyPath,
      `${keyPath} must be a path to a libp2p protobuf private key file, got ${describeValue(value)}. ` +
      `Remove the identity block entirely to run without a stable peer id; leaving it empty would ` +
      `silently start the node under a NEW one.`,
    );

// NOTE: transitional — this map exists only to give old configs a pointed error instead of a
// generic "unknown key". Safe to delete once no config in circulation names either key; the
// field table is the permanent guard and must stay.
const RETIRED_IDENTITY_KEYS = new Map<string, string>([
  ['protobufKeyFile', "renamed to 'keyFile' — same libp2p protobuf format, no file change needed"],
  ['privateKeyHex', "removed — write the key to a file ('cadre enroll create') and set 'keyFile'"],
]);

const identity = objectOf<Block<'identity'>>(
  { keyFile: identityKeyFile },
  { retired: RETIRED_IDENTITY_KEYS },
);

const controlNetwork = objectOf<Block<'controlNetwork'>>(
  {
    partyId: nonEmptyString,
    // May be empty: a cadre's founding node (`start --owner` on a fresh party) has no one to dial.
    bootstrapNodes: arrayOf(nonEmptyString),
  },
  { required: ['partyId', 'bootstrapNodes'] },
);

/** Whatever {@link parseStrandFilter} accepts; its message already names the key. */
const strandFilter: Checker<StrandFilterConfig> = (value, keyPath, ctx) => {
  try {
    parseStrandFilter(value);
    return value as StrandFilterConfig;
  } catch (err) {
    return ctx.fail(keyPath, err instanceof Error ? err.message : String(err));
  }
};

const strandReactivity = objectOf<Block<'strandReactivity'>>(
  {
    enabled: booleanValue,
    strandIds: arrayOf(nonEmptyString),
  },
  { required: ['enabled'] },
);

const storage = refine(
  objectOf<Block<'storage'>>(
    {
      type: oneOf<Block<'storage'>['type']>({ memory: true, file: true }),
      path: nonEmptyString,
      quotaBytes: nonNegativeInteger,
    },
    { required: ['type'] },
  ),
  // Cross-field: a file store needs somewhere to put the files. `resolveStorageConfig` checks
  // this too, without naming the file; this check runs first.
  (value, keyPath, ctx) =>
    value.type === 'file' && value.path === undefined
      ? ctx.missing(`${keyPath}.path`, `when ${keyPath}.type is 'file'`)
      : value,
);

const network = objectOf<Block<'network'>>({
  listenAddrs: arrayOf(stringValue),
  announceAddrs: arrayOf(stringValue),
  appendAnnounceAddrs: arrayOf(stringValue),
  relayAddrs: arrayOf(stringValue),
  enableRelay: booleanValue,
  // 0 is meaningful: refuse every unauthorized reservation.
  unauthorizedRelayReservationCap: nonNegativeInteger,
  cohortQueryTimeoutMs: finiteNumber,
  linkRoundTripMs: finiteNumber,
});

const hibernation = objectOf<Block<'hibernation'>>(
  {
    enabled: booleanValue,
    defaultLatencyHint: oneOf<LatencyHint>({ realtime: true, interactive: true, background: true, archive: true }),
  },
  { required: ['enabled'] },
);

const nodeState = objectOf<Block<'nodeState'>>({ dir: nonEmptyString });

const claim = objectOf<Block<'claim'>>({ secretFile: nonEmptyString });

// Push sub-fields are type-checked only. Which of them must be present when a platform block
// is present stays with cadre-core's `validatePushCredentials`, which host and provider also
// use; `resolveConfig` calls it after this pass.
const fcm = objectOf<FcmCredentials>({
  projectId: stringValue,
  clientEmail: stringValue,
  privateKey: secretString,
});

const apns = objectOf<ApnsCredentials>({
  keyId: stringValue,
  teamId: stringValue,
  bundleId: stringValue,
  privateKey: secretString,
  production: booleanValue,
});

const push = objectOf<PushCredentials>({
  fcm,
  apns,
  cooldownMs: nonNegativeNumber,
  debounceMs: nonNegativeNumber,
});

const root = objectOf<CliConfig>(
  {
    identity,
    controlNetwork,
    profile: oneOf<NodeProfile>({ transaction: true, storage: true }),
    strandFilter,
    strandReactivity,
    storage,
    network,
    hibernation,
    strandWatchInterval: positiveNumber,
    nodeState,
    push,
    claim,
  },
  { required: ['controlNetwork', 'profile'] },
);

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Validate the merged config tree against the field tables above.
 *
 * `provenance` maps each dotted path the environment wrote to the variable that wrote it
 * (`applyEnvironmentOverrides` builds it); a problem at a key is attributed to the variable
 * whose written path is the longest prefix of that key, and to `configPath` when none is.
 * Throws one `Error` whose message lists every problem, one per line.
 */
export function validateConfig(
  tree: unknown,
  provenance: ReadonlyMap<string, string>,
  configPath: string,
): CliConfig {
  return validateTree(tree, root, { configPath, provenance, suppliersOf: envVarsFor });
}

/** Reverse lookup in {@link ENV_MAPPINGS}: the variables that write `keyPath` or a key beneath it. */
function envVarsFor(keyPath: string): string[] {
  return Object.entries(ENV_MAPPINGS)
    .filter(([, { path }]) => path === keyPath || path.startsWith(`${keyPath}.`))
    .map(([envVar]) => envVar);
}
