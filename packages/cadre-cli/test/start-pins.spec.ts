import { describe, it, expect } from 'vitest';
import { pinnedKeyTrustPolicy } from '@serfab/cadre-core';
import { collectPinnedOwnerKeys, startCommand, validatePinnedOwnerKeys } from '../src/commands/start.js';

/** A well-formed (but not necessarily on-curve) base64url 32-byte Ed25519 public key, for shape tests. */
const VALID_KEY_A = Buffer.alloc(32, 1).toString('base64url');
const VALID_KEY_B = Buffer.alloc(32, 2).toString('base64url');

describe('--pin-owner-key option wiring', () => {
  // Exercises the actual registered commander option (not a stand-in), so the
  // repeatable-flag contract the action depends on is locked: the option exists,
  // defaults to [], and its collector accumulates each occurrence into the array
  // that `options.pinOwnerKey` later hands to collectPinnedOwnerKeys.
  const option = startCommand.options.find(o => o.long === '--pin-owner-key');

  it('is registered with an empty-array default', () => {
    expect(option).toBeDefined();
    expect(option?.defaultValue).toEqual([]);
  });

  it('accumulates repeated occurrences via its collector', () => {
    const parseArg = option?.parseArg as (value: string, previous: string[]) => string[];
    expect(parseArg('keyB', parseArg('keyA', []))).toEqual(['keyA', 'keyB']);
  });
});

describe('collectPinnedOwnerKeys', () => {
  it('returns flag keys when no env is set', () => {
    expect(collectPinnedOwnerKeys(['keyA', 'keyB'], undefined)).toEqual(['keyA', 'keyB']);
  });

  it('returns env keys (comma-separated) when no flags are passed', () => {
    expect(collectPinnedOwnerKeys(undefined, 'keyA,keyB')).toEqual(['keyA', 'keyB']);
  });

  it('unions flag and env keys', () => {
    expect(collectPinnedOwnerKeys(['keyA'], 'keyB,keyC')).toEqual(['keyA', 'keyB', 'keyC']);
  });

  it('dedupes a key supplied via both flag and env (appears once)', () => {
    expect(collectPinnedOwnerKeys(['keyA', 'keyB'], 'keyA,keyC')).toEqual(['keyA', 'keyB', 'keyC']);
  });

  it('trims surrounding whitespace on every entry', () => {
    expect(collectPinnedOwnerKeys([' keyA '], ' keyB , keyC ')).toEqual(['keyA', 'keyB', 'keyC']);
  });

  it('collapses an all-whitespace / empty env to no pins', () => {
    // `CADRE_OWNER_KEYS=",, "` must yield [] → caller leaves the policy
    // undefined, preserving the secure anchored default.
    expect(collectPinnedOwnerKeys(undefined, ',, ')).toEqual([]);
    expect(collectPinnedOwnerKeys([], '')).toEqual([]);
    expect(collectPinnedOwnerKeys(undefined, undefined)).toEqual([]);
  });

  it('drops empty entries from a flag array while keeping real keys', () => {
    expect(collectPinnedOwnerKeys(['keyA', '', '  '], 'keyB')).toEqual(['keyA', 'keyB']);
  });
});

describe('pinnedKeyTrustPolicy wiring contract', () => {
  // Lock the contract the CLI relies on: a policy built from the collected pins
  // trusts a pinned signer key and rejects an unknown one on a cold node (empty
  // OwnerKey table — knownOwnerKeys is empty).
  const SIGNER = 'pinned-signer-key';
  const partyId = 'party-1';
  const knownOwnerKeys = new Set<string>();

  it('trusts a signer key that was pinned', async () => {
    const policy = pinnedKeyTrustPolicy(collectPinnedOwnerKeys([SIGNER], undefined));
    const decision = await policy.evaluate({ partyId, signerKey: SIGNER, knownOwnerKeys });
    expect(decision.trusted).toBe(true);
  });

  it('rejects an unknown signer key with a reason', async () => {
    const policy = pinnedKeyTrustPolicy(collectPinnedOwnerKeys([SIGNER], undefined));
    const decision = await policy.evaluate({ partyId, signerKey: 'some-other-key', knownOwnerKeys });
    expect(decision.trusted).toBe(false);
    expect(decision.reason).toBeTruthy();
  });
});

describe('validatePinnedOwnerKeys', () => {
  it('passes through well-formed base64url Ed25519-shaped keys unchanged', () => {
    expect(validatePinnedOwnerKeys([VALID_KEY_A, VALID_KEY_B])).toEqual([VALID_KEY_A, VALID_KEY_B]);
  });

  it('rejects a malformed --pin-owner-key / CADRE_OWNER_KEYS entry, naming the bad value', () => {
    expect(() => validatePinnedOwnerKeys([VALID_KEY_A, 'not-a-real-key']))
      .toThrow(/not-a-real-key/);
  });

  it('rejects a non-base64url pin with a message pointing at pinned owner keys', () => {
    expect(() => validatePinnedOwnerKeys(['has+slash/and=pad']))
      .toThrow(/pinned owner key/i);
  });
});
