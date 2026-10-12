/**
 * The `join` rules of `POST /containers` (`create-request-validation.ts`): that a join is
 * required, where the party comes from, when a claim needs `docker.publicHost`, and the
 * shape a bundle must have (`invitation-validation.ts`). No refusal echoes the bundle.
 */

import { describe, it, expect } from 'vitest';
import { validateCreateContainerRequest } from '../create-request-validation.js';
import { UNCLAIMED_PARTY_ID } from '../../types.js';
import {
  TEST_INVITATION_PARTY,
  encodeInvitation,
  encodedTestInvitation,
  testInvitationBundle,
} from './test-invitation.js';

const DIALABLE = { claimable: true };
const UNDIALABLE = { claimable: false };

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
  it('yields the placeholder party and the claim join', () => {
    expect(requestOf({ join: { kind: 'claim' } })).toEqual({
      customerId: 'cust-1',
      partyId: UNCLAIMED_PARTY_ID,
      profile: 'storage',
      join: { kind: 'claim' },
    });
  });

  it('is refused on a provider without docker.publicHost, naming it', () => {
    expect(errorOf({ join: { kind: 'claim' } }, UNDIALABLE)).toContain('docker.publicHost');
  });
});

describe('POST /containers join.kind "invitation"', () => {
  it("yields the bundle's party and the trimmed bundle, and needs no publicHost", () => {
    const invitation = encodedTestInvitation();
    expect(requestOf({ join: { kind: 'invitation', invitation: `  ${invitation}\n` } }, UNDIALABLE)).toEqual({
      customerId: 'cust-1',
      partyId: TEST_INVITATION_PARTY,
      profile: 'storage',
      join: { kind: 'invitation', invitation },
    });
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
  it('refuses a body with no join, a join that is not an object, or one of another kind', () => {
    expect(errorOf({ profile: 'storage' })).toContain('join is required');
    expect(errorOf({ join: 'claim' })).toContain('join is required');
    expect(errorOf({ join: { kind: 'seed' } })).toContain('join.kind must be "claim" or "invitation"');
  });
});
