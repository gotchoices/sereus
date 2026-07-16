import { describe, it, expect } from 'vitest';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { selectControlCohortDials } from '../src/control-cohort.js';
import { ed25519PublicKeyB64FromPeerId } from '../src/seed-bootstrap.js';
import type { CohortPeerRow } from '../src/strand-cohort.js';

/** A real Ed25519 peer + its derived base64url owner key. */
async function makePeer(): Promise<{ peerId: string; key: string }> {
  const peerId = peerIdFromPrivateKey(await generateKeyPair('Ed25519')).toString();
  const key = ed25519PublicKeyB64FromPeerId(peerId);
  if (!key) throw new Error('failed to derive key from peerId');
  return { peerId, key };
}

function row(peerId: string): CohortPeerRow {
  return { peerId, multiaddr: null };
}

describe('selectControlCohortDials', () => {
  it('returns nothing for no siblings', () => {
    const sel = selectControlCohortDials([], new Set(), 6);
    expect(sel.dials).toEqual([]);
    expect(sel.cappedNonOwner).toBe(0);
  });

  it('dials every backbone (owner) member regardless of the degree cap', async () => {
    const owners = await Promise.all([makePeer(), makePeer(), makePeer()]);
    const ownerKeys = new Set(owners.map((a) => a.key));
    const siblings = owners.map((a) => row(a.peerId));

    // targetDegree 0 → no non-owner fill, but all 3 owners still dialed.
    const sel = selectControlCohortDials(siblings, ownerKeys, 0);

    const expected = owners.map((a) => a.peerId).sort();
    expect(sel.dials.map((d) => d.peerId)).toEqual(expected);
    expect(sel.cappedNonOwner).toBe(0);
  });

  it('fills non-owner members up to targetDegree and reports the capped remainder', async () => {
    const owner = await makePeer();
    const nonAuth = await Promise.all(Array.from({ length: 5 }, () => makePeer()));
    const ownerKeys = new Set([owner.key]);
    const siblings = [owner, ...nonAuth].map((p) => row(p.peerId));

    const targetDegree = 2;
    const sel = selectControlCohortDials(siblings, ownerKeys, targetDegree);

    const dialedIds = sel.dials.map((d) => d.peerId);
    // The owner is always present.
    expect(dialedIds).toContain(owner.peerId);
    // Exactly targetDegree non-owner dials, the lexicographically smallest.
    const nonAuthIds = new Set(nonAuth.map((p) => p.peerId));
    const dialedNonAuth = dialedIds.filter((id) => nonAuthIds.has(id)).sort();
    const expectedFill = nonAuth.map((p) => p.peerId).sort().slice(0, targetDegree).sort();
    expect(dialedNonAuth).toEqual(expectedFill);
    expect(sel.cappedNonOwner).toBe(5 - targetDegree);
  });

  it('degenerates to a full mesh for a small party (members <= degree)', async () => {
    const owner = await makePeer();
    const nonAuth = await Promise.all([makePeer(), makePeer()]);
    const ownerKeys = new Set([owner.key]);
    const siblings = [owner, ...nonAuth].map((p) => row(p.peerId));

    const sel = selectControlCohortDials(siblings, ownerKeys, 6);

    expect(sel.dials).toHaveLength(3);
    expect(sel.cappedNonOwner).toBe(0);
  });

  it('is deterministic across input orderings (stable backbone + fill)', async () => {
    const peers = await Promise.all(Array.from({ length: 6 }, () => makePeer()));
    const ownerKeys = new Set([peers[0]!.key, peers[1]!.key]);
    const siblings = peers.map((p) => row(p.peerId));
    const reversed = [...siblings].reverse();

    const a = selectControlCohortDials(siblings, ownerKeys, 3);
    const b = selectControlCohortDials(reversed, ownerKeys, 3);

    expect(a.dials.map((d) => d.peerId)).toEqual(b.dials.map((d) => d.peerId));
    expect(a.cappedNonOwner).toBe(b.cappedNonOwner);
  });

  it('with no known owners, fills purely from the bounded non-owner set', async () => {
    const peers = await Promise.all(Array.from({ length: 4 }, () => makePeer()));
    const siblings = peers.map((p) => row(p.peerId));

    const sel = selectControlCohortDials(siblings, new Set(), 2);

    expect(sel.dials).toHaveLength(2);
    expect(sel.cappedNonOwner).toBe(2);
    // The two smallest peerIds, deterministically.
    expect(sel.dials.map((d) => d.peerId)).toEqual(peers.map((p) => p.peerId).sort().slice(0, 2));
  });

  it('treats a negative targetDegree as zero (backbone-only)', async () => {
    const owner = await makePeer();
    const nonAuth = await makePeer();
    const sel = selectControlCohortDials(
      [owner, nonAuth].map((p) => row(p.peerId)),
      new Set([owner.key]),
      -5
    );
    expect(sel.dials.map((d) => d.peerId)).toEqual([owner.peerId]);
    expect(sel.cappedNonOwner).toBe(1);
  });
});
