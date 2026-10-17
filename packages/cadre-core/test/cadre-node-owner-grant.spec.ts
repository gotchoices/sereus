import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { CadreNode, OWNER_GRANT_DEFAULT_TTL_MS } from '../src/cadre-node.js';
import { decodeOwnerGrant } from '../src/owner-grant-protocol.js';
import { softwareOwnerSigner, type OwnerSigner } from '../src/owner-signer.js';
import type { InboundConnectionVerdict } from '../src/membership-connection-gater.js';
import type { OwnerGrantRow } from '../src/types.js';
import { freshKeyPair } from './control-constraint-helpers.js';
import { startSelfOwnerNode, type SelfOwnerNode } from './self-owner-node-helpers.js';

/**
 * `CadreNode`'s owner-grant surface, two in-process nodes over a real TCP connection as
 * `cadre-node-cadre-invitation.spec.ts` sets them up: what an owner mints (`createOwnerGrant`:
 * the defaults, the explicit no-expiry backup, the label rule), lists and withdraws; a holder
 * with no machine in the cadre becoming an owner over `/sereus/owner-grant/1.0.0`; a fresh node
 * joining as a machine and an owner with one grant (`joinWithOwnerGrant`); the local path on a
 * member, and its `alone` refusal; what the connection gate makes of a live backup grant; and
 * the removal plan's `grants`. The protocol's own cases ride the shared handler and dial loop
 * the invitation spec drives (`cadre-invite-protocol.spec.ts`); the real-network runs are
 * `owner-grant-without-machine` and `owner-grant-backup-recovery` in `integration-tests`.
 */

/** Epoch ms of a row's stored `datetime` (T-separated, no zone — UTC). */
function expiresAtMs(grant: OwnerGrantRow): number {
  return new Date(`${grant.expiresAt}Z`).getTime();
}

/** Within a few seconds of `expected`: minting reads the clock after the test does. */
function expectAbout(actual: number, expected: number): void {
  expect(Math.abs(actual - expected)).toBeLessThan(5_000);
}

/** `signer` with its approvals counted, so a test can say a refusal came before the prompt. */
function countingSigner(signer: OwnerSigner): OwnerSigner & { approvals: number } {
  const counting = {
    approvals: 0,
    publicKey: signer.publicKey,
    approve<T>(request: Parameters<OwnerSigner['approve']>[0], body: Parameters<OwnerSigner['approve']>[1]): Promise<T> {
      counting.approvals++;
      return signer.approve(request, body) as Promise<T>;
    },
  };
  return counting;
}

/**
 * The peers other than `node` that its control node's FRET still places in a cohort — the
 * cohort a control write needs a super-majority of. A peer that stops leaves it when its leave
 * notice is handled (or its contact strikes run out), which can come after libp2p has reported
 * the connection closed, so a connection count of zero does not yet mean a write commits alone.
 */
function othersInControlCohort(node: CadreNode): string[] {
  const services = node.getControlNode()?.services as { fret?: { assembleCohort(key: Uint8Array, wants: number): string[] } } | undefined;
  if (!services?.fret) throw new Error('the control node has no FRET service');
  const self = node.peerId!.toString();
  // Any coordinate: on a ring this small every live peer is within two of it.
  return services.fret.assembleCohort(new Uint8Array(32), 2).filter((id) => id !== self);
}

async function pollUntil(condition: () => boolean | Promise<boolean>, what: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

describe('CadreNode owner grants', () => {
  /** The owner that mints, and the member machine every holder below redeems at. */
  let member: SelfOwnerNode;

  /** A node started in the member's party on an empty store, with a stable identity: not a member until something admits it. */
  async function startPartyNode(): Promise<CadreNode> {
    const node = new CadreNode({
      controlNetwork: { partyId: member.node.partyId, bootstrapNodes: [] },
      privateKey: await generateKeyPair('Ed25519'),
      profile: 'transaction'
    });
    await node.start();
    return node;
  }

  beforeAll(async () => {
    member = await startSelfOwnerNode('owner-grant-member-');
    // Its own `CadrePeer` row, so it is a live member of its party: the local path's condition.
    await member.node.registerSelf();
  }, 60_000);

  afterAll(async () => {
    await member?.node.stop();
  });

  it('mints with the grant defaults or as a backup, round-trips its encoding, lists and withdraws, and the removal plan names the live ones', async () => {
    const now = Date.now();
    const { grant, encoded, reach } = await member.node.createOwnerGrant({ label: ' hardware key ' });
    expect(grant.partyId).toBe(member.node.partyId);
    expect(grant.grant.label).toBe('hardware key');
    expect(grant.grant.totalUses).toBe(1);
    expect(grant.grant.issuerKey).toBe(member.ownerKey.publicKeyB64);
    expectAbout(expiresAtMs(grant.grant), now + OWNER_GRANT_DEFAULT_TTL_MS);
    expect(grant.ownerKeys).toEqual([member.ownerKey.publicKeyB64]);
    expect(member.node.getMultiaddrs()).toEqual(expect.arrayContaining(grant.members));
    expect(reach).toBe('issuer-only');
    expect(decodeOwnerGrant(encoded)).toEqual(grant);

    // A backup: no expiry, asked for explicitly; no label when none is given.
    const backup = (await member.node.createOwnerGrant({ expiresInMs: null, uses: 2 })).grant;
    expect(backup.grant.expiresAt).toBeNull();
    expect(backup.grant.label).toBeNull();
    expect(backup.grant.totalUses).toBe(2);
    await expect(member.node.createOwnerGrant({ uses: 0 })).rejects.toThrow(/positive integer/);
    await expect(member.node.createOwnerGrant({ label: 'x'.repeat(65) })).rejects.toThrow(/at most 64/);

    const live = (await member.node.listOwnerGrants()).filter((status) => status.live).map((status) => status.grant.key);
    expect(live).toEqual(expect.arrayContaining([grant.grant.key, backup.grant.key]));
    // Removing the issuer would make both unredeemable; a withdrawn one is already dead and drops out.
    const planned = (await member.node.planOwnerKeyRemoval(member.ownerKey.publicKeyB64)).grants.map((row) => row.key);
    expect(planned).toEqual(expect.arrayContaining([grant.grant.key, backup.grant.key]));

    expect(await member.node.withdrawOwnerGrant(backup.grant.key)).toBe(true);
    expect(await member.node.withdrawOwnerGrant(backup.grant.key)).toBe(false);
    const withdrawn = (await member.node.listOwnerGrants()).find((status) => status.grant.key === backup.grant.key);
    expect(withdrawn).toMatchObject({ live: false, withdrawn: true, usesRecorded: 0 });
    expect(withdrawn?.grant).toEqual(backup.grant);
    expect((await member.node.planOwnerKeyRemoval(member.ownerKey.publicKeyB64)).grants.map((row) => row.key)).not.toContain(backup.grant.key);
  });

  it('a holder with no machine in the cadre becomes an owner over the protocol, labelled by the grant; a repeat is already an owner', async () => {
    const { grant } = await member.node.createOwnerGrant({ label: 'hardware key' });
    const holder = await startPartyNode();
    try {
      const signer = softwareOwnerSigner(freshKeyPair().privateKey);
      // Wrong party: refused before anything is pinned or dialed.
      await expect(holder.redeemOwnerGrant({ ...grant, partyId: 'another-party' }, signer)).rejects.toThrow(/another-party/);
      expect(holder.getTrustedOwnerStore()!.has(member.ownerKey.publicKeyB64)).toBe(false);

      const result = await holder.redeemOwnerGrant(grant, signer);

      expect(result).toEqual({ ownerKey: signer.publicKey, alreadyOwner: false, memberPeerId: member.node.peerId!.toString() });
      expect(await member.node.listOwnerKeys()).toContainEqual({
        key: signer.publicKey, label: 'hardware key', vouchedBy: member.ownerKey.publicKeyB64, heldHere: false, trusted: true,
      });
      // No machine was admitted; the holder pinned the bundle's owner keys.
      expect((await member.node.listAuthorizedMembers()).map((row) => row.peerId)).not.toContain(holder.peerId!.toString());
      expect(holder.getTrustedOwnerStore()!.has(member.ownerKey.publicKeyB64)).toBe(true);

      // The same key again, with a fresh nonce: already an owner, and the single use is not spent twice.
      expect((await holder.redeemOwnerGrant(grant, signer)).alreadyOwner).toBe(true);
      expect((await member.node.listOwnerGrants()).find((status) => status.grant.key === grant.grant.key)).toMatchObject({ live: false, usesRecorded: 1 });
    } finally {
      await holder.stop();
    }
  }, 90_000);

  it('joinWithOwnerGrant admits a fresh node as a machine and wires it as an owner; a member redeems locally; a live backup grant leaves a stranger provisional', async () => {
    const { grant } = await member.node.createOwnerGrant({ expiresInMs: null, label: 'paper backup' });
    const joiner = await startPartyNode();
    try {
      const signer = softwareOwnerSigner(freshKeyPair().privateKey);
      const result = await joiner.joinWithOwnerGrant(grant, signer);

      expect(result).toMatchObject({ peerId: member.node.peerId!.toString(), ownerKey: signer.publicKey, alreadyOwner: false, ownerWired: true });
      expect(await joiner.isOwner()).toBe(true);
      expect((await member.node.listAuthorizedMembers()).map((row) => row.peerId)).toContain(joiner.peerId!.toString());
      expect(await member.node.listOwnerKeys()).toContainEqual(expect.objectContaining({ key: signer.publicKey, label: 'paper backup', trusted: true }));

      // The member, connected to the joiner, redeems a grant locally for a key it does not wire.
      // The bundle's `ownerKeys` are not pinned on this path: a member's anchor is not widened by pasted text.
      expect(member.node.getControlConnectionCount()).toBeGreaterThan(0);
      expect(othersInControlCohort(member.node)).toEqual([joiner.peerId!.toString()]);
      const local = softwareOwnerSigner(freshKeyPair().privateKey);
      const { grant: second } = await member.node.createOwnerGrant({ label: 'yubikey' });
      const strangerKey = freshKeyPair().publicKey;
      expect(await member.node.redeemOwnerGrant({ ...second, ownerKeys: [...second.ownerKeys, strangerKey] }, local))
        .toEqual({ ownerKey: local.publicKey, alreadyOwner: false, memberPeerId: null });
      expect(await member.node.listOwnerKeys()).toContainEqual(expect.objectContaining({ key: local.publicKey, label: 'yubikey', heldHere: false }));
      expect(member.node.getTrustedOwnerStore()!.has(strangerKey)).toBe(false);

      // A grant no longer live is refused by name before the approval.
      const { grant: withdrawn } = await member.node.createOwnerGrant();
      expect(await member.node.withdrawOwnerGrant(withdrawn.grant.key)).toBe(true);
      const unprompted = countingSigner(softwareOwnerSigner(freshKeyPair().privateKey));
      await expect(member.node.redeemOwnerGrant(withdrawn, unprompted)).rejects.toMatchObject({ name: 'OwnerGrantRejectedError', code: 'grant-spent' });
      expect(unprompted.approvals).toBe(0);

      // The gate: a live grant with no expiry does not count as expecting a stranger, so one is
      // admitted only provisionally while it is live (the member's party has other members now).
      await member.node.createOwnerGrant({ expiresInMs: null });
      const gate = member.node as unknown as { admitInboundControlConnection(remotePeerId: string): Promise<InboundConnectionVerdict> };
      expect(await gate.admitInboundControlConnection('12D3KooWStrangerWithNoRowAnywhere')).toBe('admit-provisionally');
    } finally {
      await joiner.stop();
    }
  }, 120_000);

  it('a member redeeming locally while alone is refused by name, before the approval', async () => {
    // The joiner above left the member with another member in its snapshot and, once its
    // connection is gone, none: the add-while-alone rule. The grant minted below is a control
    // write, so the joiner must also be out of the member's cohort, or the write waits on it.
    await pollUntil(() => member.node.getControlConnectionCount() === 0 && othersInControlCohort(member.node).length === 0, 'the member to be alone');
    const { grant } = await member.node.createOwnerGrant();
    const signer = countingSigner(softwareOwnerSigner(freshKeyPair().privateKey));

    await expect(member.node.redeemOwnerGrant(grant, signer)).rejects.toMatchObject({ name: 'OwnerKeyAddRefusedError', code: 'alone' });

    expect(signer.approvals).toBe(0);
    expect((await member.node.getControlDatabase()!.getOwnerKeys()).has(signer.publicKey)).toBe(false);
  }, 60_000);
});
