import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Libp2p } from '@libp2p/interface';
import { CadreNode } from '../src/cadre-node.js';
import type { ControlDatabase } from '../src/control-database.js';
import { CadreInviteIssuerUnknownError, cadreInviteAddMessage, generateStampId } from '../src/control-database.js';
import {
  CadreInviteHandler,
  CadreInviteRejectedError,
  CadreInviteReplyInvalidError,
  CadreInviteUnreachableError,
  decodeCadreInvitation,
  encodeCadreInvitation,
  redeemAtMembers,
  signRedeemRequest,
  type CadreInvitation,
  type CadreInviteRedeemReply,
  type CadreInviteStore
} from '../src/cadre-invite-protocol.js';
import { writeFrame, type ControlStream } from '../src/control-stream.js';
import type { CadreInviteRow } from '../src/types.js';
import { freshKeyPair, freshStamp, signAs, type KeyPair } from './control-constraint-helpers.js';
import { mintContactJoiner, type TestContactJoiner } from './formation-consent-helper.js';
import { makeStreamPair } from './formation-stream-helpers.js';

/**
 * The cadre invitation redemption protocol (`cadre-invite-protocol.ts`), both halves driven
 * in-process: the member side is a real `CadreInviteHandler` over a real control database
 * (so every refusal code below is the one the engine's own constraint produces), the device
 * side is `redeemAtMembers` over a libp2p double whose `dialProtocol` bridges each bundle
 * address into a responder of the case's choosing. What travels is the real request: the
 * holder's `'redeem'` signature with the invitation key and the device's `'consent'`
 * signature with its identity key.
 *
 * The wire-level proof (a started device dialing a started member over TCP) is in
 * `cadre-node-cadre-invitation.spec.ts`; the owner-offline scenario over a real network is
 * the ticket `cadre-invitations-redeemable-by-any-member`'s.
 */

/** Per-address deadline for the in-process bridge: generous, and nothing here crosses a link. */
const BRIDGE_BUDGET_MS = 10_000;

type Responder = (stream: ControlStream) => Promise<void>;

/**
 * How the dialer double answers one bundle address: a responder handed the member end of a
 * stream pair, `'unreachable'` (the dial itself fails), or `'drop-reply'` — the responder
 * runs and commits, but the device end reads end-of-stream before the reply, as a connection
 * cut between commit and reply looks from the device.
 */
type Route = Responder | 'unreachable' | { dropReplyOf: Responder };

/** A `Libp2p` double routing `dialProtocol` by address, recording the order it was asked in. */
function dialerOver(routes: Record<string, Route>): { node: Libp2p; dials: string[] } {
  const dials: string[] = [];
  const node = {
    dialProtocol: async (addr: { toString(): string }) => {
      const key = addr.toString();
      dials.push(key);
      const route = routes[key];
      if (route === undefined || route === 'unreachable') {
        throw new Error(`dial of ${key} failed`);
      }
      const [memberEnd, deviceEnd] = makeStreamPair();
      if (typeof route === 'function') {
        void route(memberEnd).catch((err: unknown) => console.error('responder threw', err));
        return deviceEnd;
      }
      void route.dropReplyOf(memberEnd).catch((err: unknown) => console.error('responder threw', err));
      // The device's writes still reach the member; its reads end at once.
      return {
        send: (data: Uint8Array) => deviceEnd.send(data),
        close: () => deviceEnd.close(),
        abort: (err: Error) => deviceEnd.abort(err),
        async *[Symbol.asyncIterator]() { /* end-of-stream before any reply */ }
      } satisfies ControlStream;
    }
  } as unknown as Libp2p;
  return { node, dials };
}

/** A responder that answers a canned reply without reading the request. */
function canned(reply: CadreInviteRedeemReply): Responder {
  return async (stream) => {
    writeFrame(stream, reply);
    await stream.close();
  };
}

/** A store that must never be reached; every method throws. */
const untouchable: CadreInviteStore = {
  seatCadreInvite: async () => { throw new Error('store touched'); },
  isCadreInviteLive: async () => { throw new Error('store touched'); },
  redeemCadreInvite: async () => { throw new Error('store touched'); },
  querySeedPeers: async () => { throw new Error('store touched'); }
};

/** An owner-signed row built by hand, as a stranger's machine would forge one for a known key. */
function rowSignedBy(issuer: KeyPair, key: string): CadreInviteRow {
  const signed = { key, peerId: null, grantsOwner: false, expiresAt: null, totalUses: null, stampId: freshStamp() };
  return { ...signed, issuerKey: issuer.publicKey, issuerSig: signAs(issuer, cadreInviteAddMessage(signed)) };
}

describe('cadre invitation redemption protocol', () => {
  let member: CadreNode;
  let db: ControlDatabase;
  let founder: KeyPair;
  let partyId: string;
  let memberPeerId: string;
  let memberAddr: string;
  let handler: CadreInviteHandler;
  /** Every device the real handler pushed the control store to, and whether its row was already written then. */
  const pushes: Array<{ peerId: string; admittedAtPush: boolean }> = [];

  beforeAll(async () => {
    founder = freshKeyPair();
    partyId = 'cadre-invite-proto-' + Math.random().toString(36).slice(2);
    member = new CadreNode({
      controlNetwork: { partyId, bootstrapNodes: [] },
      profile: 'transaction',
      // The member judges the device's chain against THIS anchor once the rows are written.
      trustedOwners: { pinnedKeys: [founder.publicKey] }
    });
    await member.start();
    db = member.getControlDatabase()!;
    expect(await db.ensureOwnerKey(founder.publicKey)).toBe(true);
    memberPeerId = member.peerId!.toString();
    memberAddr = `/ip4/127.0.0.1/tcp/4001/p2p/${memberPeerId}`;
    handler = new CadreInviteHandler({
      partyId,
      store: db,
      catchUpDevice: async (peerId) => {
        pushes.push({ peerId, admittedAtPush: (await db.queryCadrePeers()).some((row) => row.peerId === peerId) });
      }
    });
  }, 60_000);

  afterAll(async () => {
    await member?.stop();
  });

  /** Mint an invitation the owner way and wrap it in its bundle, naming `members`. */
  async function mint(opts: { grantsOwner?: boolean; peerId?: string; expiresInMs?: number; totalUses?: number } = {}, members: string[] = [memberAddr]): Promise<CadreInvitation> {
    const invite = freshKeyPair();
    const row = await db.insertCadreInvite({
      key: invite.publicKey,
      peerId: opts.peerId ?? null,
      grantsOwner: opts.grantsOwner ?? false,
      expiresAtMs: opts.expiresInMs === undefined ? undefined : Date.now() + opts.expiresInMs,
      totalUses: opts.totalUses ?? 1
    }, founder.publicKey, (message) => signAs(founder, message));
    return { v: 1, partyId, invitePrivateKey: invite.privateKey, invite: row, ownerKeys: [founder.publicKey], members };
  }

  /** The request `device` sends for `invitation`, signed with both keys. */
  function requestFor(invitation: CadreInvitation, device: TestContactJoiner, multiaddrs: string[] = []) {
    return signRedeemRequest(invitation, { peerKey: device.peerKey, peerPrivateKey: device.privateKey }, generateStampId(device.partyId), multiaddrs);
  }

  /** The member's real handler as `device` reaches it: the connection's remote peer is the device. */
  function memberAs(device: TestContactJoiner, h: CadreInviteHandler = handler): Responder {
    return (stream) => h.handleStream(stream, device.partyId);
  }

  function redeem(node: Libp2p, invitation: CadreInvitation, request: ReturnType<typeof signRedeemRequest>) {
    return redeemAtMembers(node, {
      invitation,
      request,
      isTrustedIssuer: (key) => invitation.ownerKeys.includes(key),
      addressBudgetMs: BRIDGE_BUDGET_MS
    });
  }

  it('accepts end to end: the member writes the chain, the device verifies the reply', async () => {
    const device = await mintContactJoiner();
    const invitation = await mint({ grantsOwner: true });
    const addrs = ['/ip4/10.0.0.5/tcp/4001'];
    const { node } = dialerOver({ [memberAddr]: memberAs(device) });

    const result = await redeem(node, invitation, requestFor(invitation, device, addrs));

    expect(result.memberPeerId).toBe(memberPeerId);
    expect(result.memberAddr).toBe(memberAddr);
    expect(result.reply.partyId).toBe(partyId);
    expect(result.reply.invite).toEqual(invitation.invite);
    // The reply's dial hints are the member's own peer projection, the device's new row included.
    expect(result.reply.peers.map((peer) => peer.peerId)).toContain(device.partyId);

    // On the member: an invitation-admitted peer row carrying the device's addresses, the
    // owner row the grant seated, one usage row, and the device authorized through the chain.
    const peer = (await db.queryCadrePeers()).find((row) => row.peerId === device.partyId);
    expect(peer?.multiaddr).toBe(addrs.join(','));
    expect(peer?.vouchSig).toBeNull();
    expect(typeof peer?.vouchUsage).toBe('string');
    expect(await db.getOwnerKeys()).toContain(device.peerKey);
    expect(await db.countCadreInviteUsage(invitation.invite.key)).toBe(1);
    expect((await member.listAuthorizedMembers()).map((row) => row.peerId)).toContain(device.partyId);
    // The device was handed the control store once, before its rows were written.
    expect(pushes.filter((push) => push.peerId === device.partyId)).toEqual([{ peerId: device.partyId, admittedAtPush: false }]);
  });

  it('moves past a member that does not know the issuer (issuer-unknown is retryable) to one that does', async () => {
    const device = await mintContactJoiner();
    const strangerAddr = `/ip4/127.0.0.1/tcp/4002/p2p/${(await mintContactJoiner()).partyId}`;
    const invitation = await mint({}, [strangerAddr, memberAddr]);
    // A member whose OwnerKey table lacks the issuer refuses the seat by name, as
    // `ControlDatabase.seatCadreInvite` does; the handler maps it to the retryable code.
    const unknownIssuer = new CadreInviteHandler({
      partyId,
      store: {
        ...untouchable,
        seatCadreInvite: async (row) => { throw new CadreInviteIssuerUnknownError(row.key, row.issuerKey); }
      }
    });
    const { node, dials } = dialerOver({ [strangerAddr]: memberAs(device, unknownIssuer), [memberAddr]: memberAs(device) });

    const result = await redeem(node, invitation, requestFor(invitation, device));

    expect(dials).toEqual([strangerAddr, memberAddr]);
    expect(result.memberAddr).toBe(memberAddr);
    expect(await db.countCadreInviteUsage(invitation.invite.key)).toBe(1);
  });

  it('refuses a request whose peer key is not the connecting identity before any database work, and the device stops', async () => {
    const device = await mintContactJoiner();
    const impostor = await mintContactJoiner();
    const invitation = await mint({}, [memberAddr, `${memberAddr}-second`]);
    const strict = new CadreInviteHandler({ partyId, store: untouchable });
    // The request is the device's, signed by the device, but the connection is the impostor's.
    const { node, dials } = dialerOver({ [memberAddr]: memberAs(impostor, strict), [`${memberAddr}-second`]: memberAs(device) });

    const failure = await redeem(node, invitation, requestFor(invitation, device)).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(CadreInviteRejectedError);
    expect((failure as CadreInviteRejectedError).code).toBe('invite-invalid');
    expect((failure as CadreInviteRejectedError).retryable).toBe(false);
    // Final: the second address, which would have accepted, is never asked.
    expect(dials).toEqual([memberAddr]);
  });

  it('refuses a reply whose row is not signed by a pinned owner key, and stops', async () => {
    const device = await mintContactJoiner();
    const invitation = await mint({}, [`${memberAddr}-forged`, memberAddr]);
    const forged = canned({
      accepted: true,
      partyId,
      invite: rowSignedBy(freshKeyPair(), invitation.invite.key),
      peers: []
    });
    const { node, dials } = dialerOver({ [`${memberAddr}-forged`]: forged, [memberAddr]: memberAs(device) });

    const failure = await redeem(node, invitation, requestFor(invitation, device)).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(CadreInviteReplyInvalidError);
    expect(dials).toEqual([`${memberAddr}-forged`]);
    expect(await db.countCadreInviteUsage(invitation.invite.key)).toBe(0);
  });

  it('a reply dropped after the member committed: the retry at the next address is accepted with one usage row', async () => {
    const device = await mintContactJoiner();
    const invitation = await mint({}, [`${memberAddr}-cut`, memberAddr]);
    const { node, dials } = dialerOver({ [`${memberAddr}-cut`]: { dropReplyOf: memberAs(device) }, [memberAddr]: memberAs(device) });

    const result = await redeem(node, invitation, requestFor(invitation, device));

    expect(dials).toEqual([`${memberAddr}-cut`, memberAddr]);
    expect(result.memberAddr).toBe(memberAddr);
    // The first attempt committed; the second was answered as already a member and wrote nothing.
    expect(await db.countCadreInviteUsage(invitation.invite.key)).toBe(1);
    expect((await db.queryCadrePeers()).filter((row) => row.peerId === device.partyId)).toHaveLength(1);
  });

  it('refuses an expired invitation as invite-spent, by the engine\'s own refusal', async () => {
    const device = await mintContactJoiner();
    const invitation = await mint({ expiresInMs: -60_000 });
    const { node } = dialerOver({ [memberAddr]: memberAs(device) });

    const failure = await redeem(node, invitation, requestFor(invitation, device)).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(CadreInviteRejectedError);
    expect((failure as CadreInviteRejectedError).code).toBe('invite-spent');
    expect((await db.queryCadrePeers()).some((row) => row.peerId === device.partyId)).toBe(false);
    // The holder of an invitation that is no longer live is sent nothing.
    expect(pushes.some((push) => push.peerId === device.partyId)).toBe(false);
  });

  it('sends nothing to the holder of a forged row naming a real owner, and the seat refuses it', async () => {
    const device = await mintContactJoiner();
    const invite = freshKeyPair();
    // Every liveness condition but the signature holds: the row names the founder, an owner
    // here, as issuer, is unexpired and unused, and this member holds no row under its key.
    const forged = { ...rowSignedBy(freshKeyPair(), invite.publicKey), issuerKey: founder.publicKey };
    const invitation: CadreInvitation = { v: 1, partyId, invitePrivateKey: invite.privateKey, invite: forged, ownerKeys: [founder.publicKey], members: [memberAddr] };
    const { node } = dialerOver({ [memberAddr]: memberAs(device) });

    const failure = await redeem(node, invitation, requestFor(invitation, device)).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(CadreInviteUnreachableError);
    expect((failure as CadreInviteUnreachableError).outcomes[0]?.error).toMatchObject({ code: 'issuer-unknown' });
    expect(pushes.some((push) => push.peerId === device.partyId)).toBe(false);
    expect(await db.queryCadreInvite(invite.publicKey)).toBeNull();
  });

  it('reports every address\'s outcome when none accepts', async () => {
    const device = await mintContactJoiner();
    const invitation = await mint({}, ['not a multiaddr', `${memberAddr}-dead`]);
    const { node } = dialerOver({ [`${memberAddr}-dead`]: 'unreachable' });

    const failure = await redeem(node, invitation, requestFor(invitation, device)).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(CadreInviteUnreachableError);
    expect((failure as CadreInviteUnreachableError).outcomes.map((outcome) => outcome.addr)).toEqual(['not a multiaddr', `${memberAddr}-dead`]);
    expect((failure as CadreInviteUnreachableError).retryable).toBe(true);
  });

  it('encodes and decodes a bundle, refusing another version or a malformed one', async () => {
    const invitation = await mint();
    expect(decodeCadreInvitation(encodeCadreInvitation(invitation))).toEqual(invitation);
    expect(() => decodeCadreInvitation(encodeCadreInvitation({ ...invitation, v: 2 as unknown as 1 }))).toThrow(/unsupported version/);
    expect(() => decodeCadreInvitation(encodeCadreInvitation({ ...invitation, ownerKeys: [] }))).toThrow(/malformed/);
    expect(() => decodeCadreInvitation('not base64url json')).toThrow(/does not decode/);
  });
});
