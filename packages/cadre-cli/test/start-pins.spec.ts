import { describe, it, expect } from 'vitest';
import { pinnedKeyTrustPolicy } from '@serfab/cadre-core';
import { collectPinnedAuthorityKeys, startCommand } from '../src/commands/start.js';

describe('--pin-authority-key option wiring', () => {
  // Exercises the actual registered commander option (not a stand-in), so the
  // repeatable-flag contract the action depends on is locked: the option exists,
  // defaults to [], and its collector accumulates each occurrence into the array
  // that `options.pinAuthorityKey` later hands to collectPinnedAuthorityKeys.
  const option = startCommand.options.find(o => o.long === '--pin-authority-key');

  it('is registered with an empty-array default', () => {
    expect(option).toBeDefined();
    expect(option?.defaultValue).toEqual([]);
  });

  it('accumulates repeated occurrences via its collector', () => {
    const parseArg = option?.parseArg as (value: string, previous: string[]) => string[];
    expect(parseArg('keyB', parseArg('keyA', []))).toEqual(['keyA', 'keyB']);
  });
});

describe('collectPinnedAuthorityKeys', () => {
  it('returns flag keys when no env is set', () => {
    expect(collectPinnedAuthorityKeys(['keyA', 'keyB'], undefined)).toEqual(['keyA', 'keyB']);
  });

  it('returns env keys (comma-separated) when no flags are passed', () => {
    expect(collectPinnedAuthorityKeys(undefined, 'keyA,keyB')).toEqual(['keyA', 'keyB']);
  });

  it('unions flag and env keys', () => {
    expect(collectPinnedAuthorityKeys(['keyA'], 'keyB,keyC')).toEqual(['keyA', 'keyB', 'keyC']);
  });

  it('dedupes a key supplied via both flag and env (appears once)', () => {
    expect(collectPinnedAuthorityKeys(['keyA', 'keyB'], 'keyA,keyC')).toEqual(['keyA', 'keyB', 'keyC']);
  });

  it('trims surrounding whitespace on every entry', () => {
    expect(collectPinnedAuthorityKeys([' keyA '], ' keyB , keyC ')).toEqual(['keyA', 'keyB', 'keyC']);
  });

  it('collapses an all-whitespace / empty env to no pins', () => {
    // `CADRE_AUTHORITY_KEYS=",, "` must yield [] → caller leaves the policy
    // undefined, preserving the secure DB-anchored default.
    expect(collectPinnedAuthorityKeys(undefined, ',, ')).toEqual([]);
    expect(collectPinnedAuthorityKeys([], '')).toEqual([]);
    expect(collectPinnedAuthorityKeys(undefined, undefined)).toEqual([]);
  });

  it('drops empty entries from a flag array while keeping real keys', () => {
    expect(collectPinnedAuthorityKeys(['keyA', '', '  '], 'keyB')).toEqual(['keyA', 'keyB']);
  });
});

describe('pinnedKeyTrustPolicy wiring contract', () => {
  // Lock the contract the CLI relies on: a policy built from the collected pins
  // trusts a pinned signer key and rejects an unknown one on a cold node (empty
  // AuthorityKey table — knownAuthorityKeys is empty).
  const SIGNER = 'pinned-signer-key';
  const partyId = 'party-1';
  const knownAuthorityKeys = new Set<string>();

  it('trusts a signer key that was pinned', async () => {
    const policy = pinnedKeyTrustPolicy(collectPinnedAuthorityKeys([SIGNER], undefined));
    const decision = await policy.evaluate({ partyId, signerKey: SIGNER, knownAuthorityKeys });
    expect(decision.trusted).toBe(true);
  });

  it('rejects an unknown signer key with a reason', async () => {
    const policy = pinnedKeyTrustPolicy(collectPinnedAuthorityKeys([SIGNER], undefined));
    const decision = await policy.evaluate({ partyId, signerKey: 'some-other-key', knownAuthorityKeys });
    expect(decision.trusted).toBe(false);
    expect(decision.reason).toBeTruthy();
  });
});
