import { describe, it, expect } from 'vitest';
import { cadreInviteAddMessage, ownerGrantAddMessage } from '../src/control-database.js';
import { decodeOwnerGrant, encodeOwnerGrant, type OwnerGrantBundle } from '../src/owner-grant-protocol.js';
import { decodeCadreInvitation, encodeCadreInvitation, type CadreInvitation } from '../src/cadre-invite-protocol.js';
import { decodeCadreJoinRequest, encodeCadreJoinRequest, OWNER_GRANT_PREFIX, OWNER_KEY_EXPORT_STEM } from '../src/cadre-join-request.js';
import { decodeOwnerKeyExport, unlockOwnerKeyExport } from '../src/owner-key-export.js';
import { freshKeyPair, freshStamp, peerIdOf, signAs } from './control-constraint-helpers.js';

/**
 * The owner grant's text form (`owner-grant-protocol.ts`: `encodeOwnerGrant` / `decodeOwnerGrant`)
 * and the by-name refusals between it and the three other texts a user pastes into an app: a
 * cadre invitation, a join request and an owner key export. A grant pasted into the wrong field
 * is refused, never sent to a member; and none of the other three decodes as a grant.
 */
describe('owner grant codec', () => {
  const partyId = 'owner-grant-codec';
  const issuer = freshKeyPair();
  const grantKey = freshKeyPair();
  const memberAddr = `/ip4/127.0.0.1/tcp/4001/p2p/${peerIdOf(freshKeyPair())}`;

  const signedGrant = { key: grantKey.publicKey, label: 'paper backup', expiresAt: null, totalUses: 1, stampId: freshStamp() };
  const bundle: OwnerGrantBundle = {
    v: 1,
    partyId,
    grantPrivateKey: grantKey.privateKey,
    grant: { ...signedGrant, issuerKey: issuer.publicKey, issuerSig: signAs(issuer, ownerGrantAddMessage(partyId, signedGrant)) },
    ownerKeys: [issuer.publicKey],
    members: [memberAddr],
  };
  const encodedGrant = encodeOwnerGrant(bundle);

  const inviteKey = freshKeyPair();
  const signedInvite = { key: inviteKey.publicKey, peerId: null, expiresAt: null, totalUses: 1, stampId: freshStamp() };
  const invitation: CadreInvitation = {
    v: 1,
    partyId,
    invitePrivateKey: inviteKey.privateKey,
    invite: { ...signedInvite, issuerKey: issuer.publicKey, issuerSig: signAs(issuer, cadreInviteAddMessage(partyId, signedInvite)) },
    ownerKeys: [issuer.publicKey],
    members: [memberAddr],
  };
  const encodedInvitation = encodeCadreInvitation(invitation);
  const encodedRequest = encodeCadreJoinRequest({ v: 1, peerId: peerIdOf(freshKeyPair()), appName: 'New app' });
  const plainOwnerKey = `${OWNER_KEY_EXPORT_STEM}:1.e30`;
  const lockedOwnerKey = `${OWNER_KEY_EXPORT_STEM}-locked:1.e30`;

  it('round-trips behind its prefix and refuses another version, a malformed bundle, bad base64url and no prefix', () => {
    expect(encodedGrant.startsWith(OWNER_GRANT_PREFIX)).toBe(true);
    expect(decodeOwnerGrant(encodedGrant)).toEqual(bundle);
    expect(decodeOwnerGrant(`  ${encodedGrant}\n`)).toEqual(bundle);
    expect(() => decodeOwnerGrant(encodeOwnerGrant({ ...bundle, v: 2 as unknown as 1 }))).toThrow(/unsupported version/);
    expect(() => decodeOwnerGrant(encodeOwnerGrant({ ...bundle, ownerKeys: [] }))).toThrow(/malformed/);
    expect(() => decodeOwnerGrant(encodeOwnerGrant({ ...bundle, grant: { ...bundle.grant, label: 'x'.repeat(65) } }))).toThrow(/malformed/);
    expect(() => decodeOwnerGrant(encodeOwnerGrant({ ...bundle, grant: { ...bundle.grant, totalUses: 0 } }))).toThrow(/malformed/);
    expect(() => decodeOwnerGrant(`${OWNER_GRANT_PREFIX}not base64url json`)).toThrow(/does not decode/);
    expect(() => decodeOwnerGrant(encodedGrant.slice(OWNER_GRANT_PREFIX.length))).toThrow(/must start with/);
  });

  it.each<[string, string, RegExp]>([
    ['a cadre invitation', encodedInvitation, /cadre invitation, not an owner grant/],
    ['a join request', encodedRequest, /join request, not an owner grant/],
    ['a plain owner key', plainOwnerKey, /owner key, not an owner grant/],
    ['a locked owner key', lockedOwnerKey, /owner key, not an owner grant/],
  ])('the grant decoder refuses %s by name', (_kind, text, message) => {
    expect(() => decodeOwnerGrant(text)).toThrow(message);
  });

  it('the invitation, join-request and owner-key decoders each refuse a grant by name', async () => {
    expect(() => decodeCadreInvitation(encodedGrant)).toThrow(/owner grant, not a cadre invitation/);
    expect(() => decodeCadreJoinRequest(encodedGrant)).toThrow(/owner grant, not a join request/);
    expect(() => decodeOwnerKeyExport(encodedGrant)).toThrow(expect.objectContaining({ code: 'not-an-owner-key', message: expect.stringMatching(/owner grant, not an owner key/) }));
    await expect(unlockOwnerKeyExport(encodedGrant, 'passphrase')).rejects.toMatchObject({ code: 'not-an-owner-key' });
  });
});
