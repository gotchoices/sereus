/**
 * A cadre invitation for the hosted-node unit tests: well-formed enough for
 * `decodeCadreInvitation`, which checks shape only. Nothing on the host verifies its
 * signatures; a member does, and the integration scenario covers that.
 */

import { encodeCadreInvitation } from '@serfab/cadre-core';

/** The invitation's issuer: the owner key a joined invitation node is shown under. */
export const ISSUER_KEY = Buffer.alloc(32, 9).toString('base64url');

/** The member a test reports as having admitted the node. */
export const MEMBER_PEER_ID = '12D3KooWQYhTNQdmr3ArTeUHRYzFg94BKyTkoWBDWez9kSCVe2Xo';

export function encodedTestInvitation(partyId: string): string {
  return encodeCadreInvitation({
    v: 1,
    partyId,
    invitePrivateKey: Buffer.alloc(32, 3).toString('base64url'),
    invite: {
      key: Buffer.alloc(32, 4).toString('base64url'),
      peerId: null,
      grantsOwner: false,
      expiresAt: null,
      totalUses: 1,
      stampId: 'stamp-1',
      issuerKey: ISSUER_KEY,
      issuerSig: 'signature',
    },
    ownerKeys: [ISSUER_KEY],
    members: [`/ip4/127.0.0.1/tcp/4001/ws/p2p/${MEMBER_PEER_ID}`],
  });
}
