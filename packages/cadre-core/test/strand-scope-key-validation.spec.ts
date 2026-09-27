import { describe, it, expect, vi, beforeEach } from 'vitest';
import { generatePrivateKey, getPublicKey } from '@optimystic/quereus-plugin-crypto';
import type { IRawStorage } from '@optimystic/db-p2p/rn';
import { StrandInstanceManager } from '../src/strand-instance-manager.js';
import { isValidStrandScopeKey, InvalidStrandIdError } from '../src/storage-scope.js';
import { mintStrandId, mintPlaceholderStrandId } from '../src/strand-id.js';
import { signSchema } from '../src/schema-verification.js';
import type { StrandRow, SAppConfig } from '../src/types.js';
import type { StartStrandConfig } from '../src/strand-instance-manager.js';

/**
 * A strand's storage scope key is its strand id, used verbatim, and a strand row can
 * arrive from another node in the party by replication. Every embedder turns that key
 * straight into a real name — cadre-cli a directory under its storage path, the phone
 * apps a LevelDB filename, the browser an IndexedDB database name — and
 * `buildStrandRuntime` turns the same id into the libp2p protocol prefix
 * `/optimystic/strand-<id>`. Before this check, `startStrand('../../etc/passwd')`
 * succeeded and handed that string to the provider unaltered.
 *
 * The mocks follow `strand-instance-manager-storage-ownership.spec.ts`:
 * `createLibp2pNode` and `StrandDatabase` are doubles, so no real libp2p node or
 * Quereus database starts.
 */
const mocks = vi.hoisted(() => {
  const stop = vi.fn(async () => {});
  const close = vi.fn(async () => {});
  const initialize = vi.fn(async () => {});
  const createLibp2pNode = vi.fn(async () => ({ coordinatedRepo: {}, stop }));
  const headerHeldDb = { eval: async function* () { yield { Count: 1 }; }, schemaManager: { getSchema: () => undefined } };
  const StrandDatabase = vi.fn(function StrandDatabaseMock() {
    return { initialize, close, getDatabase: () => headerHeldDb };
  });
  return { stop, close, initialize, createLibp2pNode, StrandDatabase };
});

vi.mock('@optimystic/db-p2p', () => ({ createLibp2pNode: mocks.createLibp2pNode }));
vi.mock('../src/strand-database.js', () => ({ StrandDatabase: mocks.StrandDatabase }));

const testSchema = 'create table Test (id text primary key);';
const testVersion = '1.0.0';

let authorPrivateKey: string;
let authorPublicKey: string;

beforeEach(() => {
  vi.clearAllMocks();
  authorPrivateKey = generatePrivateKey('ed25519', 'base64url') as string;
  authorPublicKey = getPublicKey(authorPrivateKey, 'ed25519', 'base64url', 'base64url') as string;
});

function createStartConfig(strandId: string, provider: (id: string) => IRawStorage): StartStrandConfig {
  const strandRow: StrandRow = { Id: strandId, MemberPrivateKey: null, Type: 'o', FounderOwnerKey: null };
  const sAppConfig: SAppConfig = {
    id: authorPublicKey,
    version: testVersion,
    schema: testSchema,
    signature: signSchema(testSchema, testVersion, authorPrivateKey)
  };
  return { strandRow, sAppConfig, profile: 'transaction', defaultLatencyHint: 'interactive', storage: { provider } };
}

describe('strand scope key validation', () => {
  it.each([
    ['a path traversal', '../../etc/passwd'],
    ['a control-database key', 'control-ZmFrZQ'],
  ])('refuses a strand whose id is %s, without reaching the storage provider', async (_label, strandId) => {
    const seen: string[] = [];
    const manager = new StrandInstanceManager();

    await expect(
      manager.startStrand(createStartConfig(strandId, (id) => {
        seen.push(id);
        return {} as IRawStorage;
      }))
    ).rejects.toThrow(InvalidStrandIdError);

    expect(seen).toEqual([]);
    expect(mocks.createLibp2pNode).not.toHaveBeenCalled();
    expect(manager.hasStrand(strandId)).toBe(false);
  });

  it.each([
    ['the CSPRNG form', mintStrandId()],
    ['the placeholder form', mintPlaceholderStrandId()],
  ])('accepts an id cadre-core mints in %s', (_label, strandId) => {
    expect(isValidStrandScopeKey(strandId)).toBe(true);
  });

  it.each([
    ['the empty string', ''],
    ['a path traversal', '../../etc/passwd'],
    ['a bare parent directory', '..'],
    ['a bare current directory', '.'],
    ['an embedded separator', 'strand/nested'],
    ['a Windows separator', 'strand\\nested'],
    ['a control-database prefix', 'control-ZmFrZQ'],
    ['an id over the 128-character cap', `strand-${'a'.repeat(128)}`],
  ])('rejects %s', (_label, strandId) => {
    expect(isValidStrandScopeKey(strandId)).toBe(false);
  });
});
