/**
 * A cadre invitation bundle for the provider's unit tests: well-formed for
 * `validateInvitation`, which checks shape only. Nothing here verifies signatures; the
 * node and a member do, and the integration scenarios cover that. Built by hand rather
 * than with cadre-core's `encodeCadreInvitation`, since this package does not depend on
 * cadre-core (see `invitation-validation.ts`).
 */

/** A decodable peer id, the member the bundle names. */
export const TEST_MEMBER_PEER_ID = '12D3KooWA9hbnKrRnPRSPTRkzXqTHzGE8YpJ3JHZmQ5tGwLRTMmp';

/** The cadre the test bundle joins. */
export const TEST_INVITATION_PARTY = 'party-invited';

/** The issuer's owner key the bundle carries (a public key; any 32 bytes shape one). */
export const TEST_ISSUER_KEY = Buffer.alloc(32, 9).toString('base64url');

/** The decoded bundle, as an object the tests can alter before encoding. */
export function testInvitationBundle(partyId: string = TEST_INVITATION_PARTY): Record<string, unknown> {
  return {
    v: 1,
    partyId,
    invitePrivateKey: Buffer.alloc(32, 3).toString('base64url'),
    invite: {
      key: Buffer.alloc(32, 4).toString('base64url'),
      peerId: null,
      expiresAt: null,
      totalUses: 1,
      stampId: 'stamp-1',
      issuerKey: TEST_ISSUER_KEY,
      issuerSig: 'signature',
    },
    ownerKeys: [TEST_ISSUER_KEY],
    members: [`/ip4/127.0.0.1/tcp/4001/ws/p2p/${TEST_MEMBER_PEER_ID}`],
  };
}

/** `prefix` + base64url of the bundle's JSON — cadre-core's `encodeCadreInvitation` shape. */
export function encodeInvitation(bundle: unknown, prefix = 'sereus-invite:1.'): string {
  return `${prefix}${Buffer.from(JSON.stringify(bundle)).toString('base64url')}`;
}

/** The encoded test bundle for `partyId`. */
export function encodedTestInvitation(partyId: string = TEST_INVITATION_PARTY): string {
  return encodeInvitation(testInvitationBundle(partyId));
}
