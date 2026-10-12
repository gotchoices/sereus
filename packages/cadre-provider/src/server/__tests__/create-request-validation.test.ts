/**
 * The `join` rules of `POST /containers` (`create-request-validation.ts`): which fields a
 * claim or an invitation excludes, where the party comes from, when a claim needs
 * `docker.publicHost`, and the shape a bundle must have (`invitation-validation.ts`).
 * Every refusal names the field, and none echoes the bundle.
 */

import { describe, it, expect } from 'vitest';
import { validateCreateContainerRequest } from '../create-request-validation.js';
import { UNCLAIMED_PARTY_ID } from '../../types.js';
import {
  TEST_INVITATION_PARTY,
  TEST_MEMBER_PEER_ID,
  encodeInvitation,
  encodedTestInvitation,
  testInvitationBundle,
} from './test-invitation.js';

const DIALABLE = { optional: true };
const UNDIALABLE = { optional: false };
const BOOTSTRAP = [`/ip4/127.0.0.1/tcp/4001/p2p/${TEST_MEMBER_PEER_ID}`];
const OWNER_KEY = Buffer.alloc(32, 1).toString('base64url');

function errorOf(body: unknown, options = DIALABLE): string {
  const result = validateCreateContainerRequest(body, 'cust-1', options);
  if (!('error' in result)) throw new Error(`expected a refusal, got ${JSON.stringify(result)}`);
  return result.error;
}

function requestOf(body: unknown, options = DIALABLE) {
  const result = validateCreateContainerRequest(body, 'cust-1', options);
  if ('error' in result) throw new Error(`expected acceptance, got: ${result.error}`);
  return result.request;
}

describe('POST /containers join.kind "claim"', () => {
  it('yields the placeholder party, no bootstrap nodes, and the claim join', () => {
    expect(requestOf({ join: { kind: 'claim' } })).toEqual({
      customerId: 'cust-1',
      partyId: UNCLAIMED_PARTY_ID,
      bootstrapNodes: [],
      profile: 'storage',
      join: { kind: 'claim' },
    });
  });

  it('is refused on a provider without docker.publicHost, naming it', () => {
    expect(errorOf({ join: { kind: 'claim' } }, UNDIALABLE)).toContain('docker.publicHost');
  });

  it.each([
    ['partyId', 'party-1'],
    ['bootstrapNodes', BOOTSTRAP],
    ['pinnedOwnerKeys', [OWNER_KEY]],
  ])('refuses %s beside a claim, naming the field', (field, value) => {
    const message = errorOf({ join: { kind: 'claim' }, [field]: value });
    expect(message).toContain(`${field} must be absent with join.kind "claim"`);
    expect(message).toContain('takes its party and owner from the claim');
  });

  it('accepts bootstrapNodes: [] beside a claim, the publicHost spelling of "none"', () => {
    expect(requestOf({ join: { kind: 'claim' }, bootstrapNodes: [] }).bootstrapNodes).toEqual([]);
  });
});

describe('POST /containers join.kind "invitation"', () => {
  it("yields the bundle's party and the trimmed bundle, and needs no publicHost", () => {
    const invitation = encodedTestInvitation();
    expect(requestOf({ join: { kind: 'invitation', invitation: `  ${invitation}\n` } }, UNDIALABLE)).toEqual({
      customerId: 'cust-1',
      partyId: TEST_INVITATION_PARTY,
      bootstrapNodes: [],
      profile: 'storage',
      join: { kind: 'invitation', invitation },
    });
  });

  it('accepts a partyId that repeats the bundle\'s and refuses one that disagrees', () => {
    const invitation = encodedTestInvitation();
    expect(requestOf({ join: { kind: 'invitation', invitation }, partyId: ` ${TEST_INVITATION_PARTY} ` }).partyId).toBe(TEST_INVITATION_PARTY);
    expect(errorOf({ join: { kind: 'invitation', invitation }, partyId: 'another-party' })).toContain('partyId disagrees with the invitation');
  });

  it.each([
    ['bootstrapNodes', BOOTSTRAP],
    ['pinnedOwnerKeys', [OWNER_KEY]],
  ])('refuses %s beside an invitation, naming the field', (field, value) => {
    expect(errorOf({ join: { kind: 'invitation', invitation: encodedTestInvitation() }, [field]: value }))
      .toContain(`${field} must be absent with join.kind "invitation"`);
  });

  it('refuses a join request by name', () => {
    const joinRequest = encodeInvitation({ v: 1, anything: true }, 'sereus-join-request:1.');
    expect(errorOf({ join: { kind: 'invitation', invitation: joinRequest } })).toContain('is a join request, not an invitation');
  });

  const malformed: [string, string][] = [
    ['another prefix', encodeInvitation(testInvitationBundle(), 'sereus-invite:2.')],
    ['not base64url JSON', 'sereus-invite:1.%%%not-json%%%'],
    ['a JSON array', encodeInvitation([1, 2, 3])],
    ['version 2', encodeInvitation({ ...testInvitationBundle(), v: 2 })],
    ['no partyId', encodeInvitation({ ...testInvitationBundle(), partyId: '' })],
    ['no invitePrivateKey', encodeInvitation({ ...testInvitationBundle(), invitePrivateKey: undefined })],
    ['no invite row', encodeInvitation({ ...testInvitationBundle(), invite: 'row' })],
    ['empty ownerKeys', encodeInvitation({ ...testInvitationBundle(), ownerKeys: [] })],
    ['no members', encodeInvitation({ ...testInvitationBundle(), members: [] })],
    ['a member that is not a multiaddr', encodeInvitation({ ...testInvitationBundle(), members: ['not an address'] })],
    ['a member naming no peer', encodeInvitation({ ...testInvitationBundle(), members: ['/ip4/127.0.0.1/tcp/4001/ws'] })],
    ['a member whose peer id does not decode', encodeInvitation({ ...testInvitationBundle(), members: ['/ip4/127.0.0.1/tcp/4001/ws/p2p/12D3KooReq'] })],
  ];

  it.each(malformed)('refuses a bundle with %s without echoing it', (_what, invitation) => {
    const message = errorOf({ join: { kind: 'invitation', invitation } });
    expect(message).toContain('join.invitation');
    // The bundle carries the invitation's private key: no part of its body may be echoed.
    expect(message).not.toContain(invitation.slice('sereus-invite:1.'.length, 'sereus-invite:1.'.length + 8));
  });
});

describe('POST /containers join shape', () => {
  it('refuses a join that is not an object, or of another kind', () => {
    expect(errorOf({ join: 'claim' })).toContain('join must be an object');
    expect(errorOf({ join: { kind: 'seed' } })).toContain('join.kind must be "claim" or "invitation"');
  });

  it('leaves the seed path as it was when join is absent', () => {
    expect(requestOf({ partyId: 'party-1', bootstrapNodes: BOOTSTRAP, pinnedOwnerKeys: [OWNER_KEY] }, UNDIALABLE)).toEqual({
      customerId: 'cust-1',
      partyId: 'party-1',
      bootstrapNodes: BOOTSTRAP,
      profile: 'storage',
      pinnedOwnerKeys: [OWNER_KEY],
    });
  });
});
