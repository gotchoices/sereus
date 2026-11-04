import { describe, it, expect } from 'vitest';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { ed25519KeyPairFromLibp2p } from '../src/ed25519-key.js';
import { generateStrandMemberKey } from '../src/strand-member-key.js';
import { openPartyKey, partyKeyRecipients, sealPartyKey, type PartyKeyOpener, type PartyKeyRecipient } from '../src/sealed-party-key.js';

/** A machine as the envelope sees it: its control peer id with the identity key behind it, as a recipient and as the opener. */
async function machine(): Promise<{ recipient: PartyKeyRecipient; opener: PartyKeyOpener }> {
  const key = await generateKeyPair('Ed25519');
  const peerId = peerIdFromPrivateKey(key).toString();
  const pair = ed25519KeyPairFromLibp2p(key);
  return { recipient: { peerId, publicKeyB64: pair.publicKeyB64 }, opener: { peerId, privateKeyB64: pair.privateKeyB64 } };
}

describe('sealed party key', () => {
  it('opens for each recipient, answers null to a machine outside the envelope, and refuses another strand id or another key', async () => {
    const [a, b, outsider] = await Promise.all([machine(), machine(), machine()]);
    const privateKey = await generateStrandMemberKey();
    const sealed = sealPartyKey(privateKey, 'strand-1', [a.recipient, b.recipient]);

    expect(sealed).not.toContain(privateKey);
    expect(partyKeyRecipients(sealed).sort()).toEqual([a.recipient.peerId, b.recipient.peerId].sort());
    expect(openPartyKey(sealed, 'strand-1', a.opener)).toBe(privateKey);
    expect(openPartyKey(sealed, 'strand-1', b.opener)).toBe(privateKey);
    expect(openPartyKey(sealed, 'strand-1', outsider.opener)).toBeNull();
    // The envelope copied onto another strand's row.
    expect(() => openPartyKey(sealed, 'strand-2', a.opener)).toThrow(/does not open/);
    // A recipient's entry tried under another machine's key: an altered row.
    expect(() => openPartyKey(sealed, 'strand-1', { peerId: a.recipient.peerId, privateKeyB64: outsider.opener.privateKeyB64 })).toThrow(/does not open/);
  });
});
