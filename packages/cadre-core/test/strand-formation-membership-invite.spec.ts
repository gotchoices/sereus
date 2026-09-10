/**
 * Formation carries the JOINER's own strand membership invitation
 * (`FormationProvisionResult.membershipInvite`) — the second half of the
 * party-identity split (`strand-formation-membership-invite`).
 *
 * Drives `StrandFormationManager` with an in-memory `FormationUsageRecorder` fake
 * (bound / unbound resolution, call recording) and a fake `issueMembershipInvite`
 * hook, over the same doubles the sibling formation specs use. Covers:
 *
 *  - bound + wired hook → the approval carries the hook's well-formed invitation,
 *    the hook is asked for the RESOLVED strand, and the consent row records AFTER
 *    a successful issue,
 *  - bound + hook throws (runtime absent / no party key / strand-DB reject) → clean
 *    retryable rejection with `MEMBERSHIP_INVITE_UNAVAILABLE_REASON`, NO usage
 *    recorded (the formation token stays unspent), NO responder disclosure,
 *  - bound + hook returns null (open host strand) → approved, no invitation,
 *  - bound + hook UNWIRED (mock/transport posture) → approved, no invitation,
 *  - unbound → the hook is never consulted and no invitation is carried,
 *  - invalid token → the hook is never consulted (rejection parity holds),
 *  - initiator floor: a malformed invitation from a hostile responder fails the
 *    default result validation instead of reaching the joiner,
 *  - `isWellFormedMembershipInvite` shape/bound edges.
 */
import { describe, it, expect } from 'vitest';
import {
  StrandFormationManager,
  MEMBERSHIP_INVITE_UNAVAILABLE_REASON
} from '../src/strand-formation-manager.js';
import {
  isWellFormedMembershipInvite,
  type FormationResultMessage
} from '../src/strand-formation-protocol.js';
import type { FormationUsageRecorder, ResolvedHostStrand } from '../src/strand-solicitation.js';
import type { OpenInvitation, StrandFormationDisclosure, StrandMembershipInvite } from '../src/types.js';
import { mintContactJoiner, mintContactConsent, type JoinerConsent } from './formation-consent-helper.js';
import { captureHandler, bridgingDialer, MockStream } from './formation-stream-helpers.js';

const HOST_PARTY = 'invite-host-party';
const HOST_CADRE = ['/ip4/10.0.0.1/tcp/2/p2p/invite-host'];
const HOST_STRAND_ID = 'strand-invite-host';
const HOST_MEMBER_KEY = 'host-member-private-key';

/** A structurally valid invitation pair (43-char base64url, like real ed25519 keys). */
const GOOD_INVITE: StrandMembershipInvite = {
  inviteKey: 'A'.repeat(43),
  invitePrivateKey: 'B'.repeat(42) + '_'
};

/**
 * In-memory {@link FormationUsageRecorder}: every token is valid/unused, `resolveStrand`
 * answers the canned resolution, and `recordUsage` only records that it was called.
 */
function fakeRecorder(resolution: ResolvedHostStrand): FormationUsageRecorder & { usageRecorded: string[] } {
  const usageRecorded: string[] = [];
  return {
    usageRecorded,
    async isTokenValid() { return { valid: true }; },
    async isTokenUsed() { return false; },
    async resolveStrand() { return resolution; },
    async recordUsage(params) { usageRecorded.push(params.token); }
  };
}

/** A validly-signed consent triple + matching invitation, as `formStrand` needs them. */
async function formationArgs(token: string, purpose: string): Promise<{
  invitation: OpenInvitation;
  disclosure: StrandFormationDisclosure;
  consent: JoinerConsent;
}> {
  const joiner = await mintContactJoiner();
  const disclosure: StrandFormationDisclosure = { partyId: joiner.partyId, purpose };
  const consent = mintContactConsent(joiner, token, disclosure);
  const invitation: OpenInvitation = {
    token,
    sAppId: `sapp-${purpose}`,
    expiration: new Date(Date.now() + 3600_000),
    bootstrap: ['/ip4/127.0.0.1/tcp/1']
  };
  return { invitation, disclosure, consent };
}

interface BothRolesSetup {
  recorder: FormationUsageRecorder & { usageRecorded: string[] };
  hookCalls: string[];
}

/**
 * One manager as BOTH roles over the in-memory bridge (the
 * `strand-formation-manager.spec.ts` shape), with a fake bound/unbound recorder and an
 * optional membership-invite hook.
 */
async function formBothRoles(
  purpose: string,
  resolution: ResolvedHostStrand,
  hook?: (calls: string[]) => (strandId: string) => Promise<StrandMembershipInvite | null>
): Promise<{ setup: BothRolesSetup; result: Awaited<ReturnType<StrandFormationManager['formStrand']>> }> {
  const recorder = fakeRecorder(resolution);
  const hookCalls: string[] = [];
  const manager = new StrandFormationManager({
    formationUsageRecorder: recorder,
    partyId: HOST_PARTY,
    cadrePeerAddrs: HOST_CADRE,
    ...(hook ? { issueMembershipInvite: hook(hookCalls) } : {})
  });
  const { node, invoke } = captureHandler();
  manager.registerResponder(node);
  const { invitation, disclosure, consent } = await formationArgs(`invite-${purpose}`, purpose);
  const result = await manager.formStrand(invitation, disclosure, consent, bridgingDialer(invoke));
  return { setup: { recorder, hookCalls }, result };
}

// ── Frame helpers (the on-wire 4-byte big-endian length prefix) ───────────────

function encodeFrame(obj: unknown): Uint8Array {
  const body = new TextEncoder().encode(JSON.stringify(obj));
  const out = new Uint8Array(4 + body.length);
  new DataView(out.buffer).setUint32(0, body.length, false);
  out.set(body, 4);
  return out;
}

function decodeFirstFrame<T>(chunks: Uint8Array[]): T {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const all = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { all.set(c, off); off += c.length; }
  const length = new DataView(all.buffer, all.byteOffset, all.byteLength).getUint32(0, false);
  return JSON.parse(new TextDecoder().decode(all.subarray(4, 4 + length))) as T;
}

/** Drive ONE responder session from a canned contact; returns the reply frame. */
async function respondOnce(
  manager: StrandFormationManager,
  token: string
): Promise<FormationResultMessage> {
  const { node, invoke } = captureHandler();
  manager.registerResponder(node);
  const joiner = await mintContactJoiner();
  const disclosure: StrandFormationDisclosure = { partyId: joiner.partyId, purpose: 'frame-check' };
  const contact = {
    token,
    partyId: joiner.partyId,
    ...mintContactConsent(joiner, token, disclosure),
    disclosure,
    cadrePeerAddrs: ['/ip4/127.0.0.1/tcp/1/p2p/initiator']
  };
  const stream = new MockStream([encodeFrame(contact)]);
  await invoke(stream);
  return decodeFirstFrame<FormationResultMessage>(stream.sent);
}

const BOUND: ResolvedHostStrand = { kind: 'bound', strandId: HOST_STRAND_ID, memberPrivateKey: HOST_MEMBER_KEY };

describe('formation membership invitation (bound closed path)', () => {
  it('carries the issued invitation on the approval, alongside the member key', async () => {
    const { setup, result } = await formBothRoles('carry', BOUND,
      (calls) => async (strandId) => { calls.push(strandId); return GOOD_INVITE; });

    expect(result.strandId).toBe(HOST_STRAND_ID);
    expect(result.memberPrivateKey).toBe(HOST_MEMBER_KEY);
    expect(result.membershipInvite).toEqual(GOOD_INVITE);
    // The hook was asked for the RESOLVED strand, and the consent row was recorded.
    expect(setup.hookCalls).toEqual([HOST_STRAND_ID]);
    expect(setup.recorder.usageRecorded).toHaveLength(1);
  });

  it('hook throws → clean retryable rejection, token unspent, nothing disclosed', async () => {
    const recorder = fakeRecorder(BOUND);
    const hookCalls: string[] = [];
    const manager = new StrandFormationManager({
      formationUsageRecorder: recorder,
      partyId: HOST_PARTY,
      cadrePeerAddrs: HOST_CADRE,
      issueMembershipInvite: async (strandId) => {
        hookCalls.push(strandId);
        throw new Error('strand runtime is not live on this responder');
      }
    });

    const reply = await respondOnce(manager, 'invite-hook-throws');

    expect(reply.approved).toBe(false);
    expect(reply.reason).toBe(MEMBERSHIP_INVITE_UNAVAILABLE_REASON);
    // Rejected BEFORE recordUsage: the one-time formation token must stay unspent.
    expect(recorder.usageRecorded).toHaveLength(0);
    expect(hookCalls).toEqual([HOST_STRAND_ID]);
    // Rejection parity: no identity, no cadre, no provision result, no invitation.
    expect(reply.partyId).toBeUndefined();
    expect(reply.cadrePeerAddrs).toBeUndefined();
    expect(reply.provisionResult).toBeUndefined();
  });

  it('hook returns null (open host strand) → approved with no invitation', async () => {
    const { setup, result } = await formBothRoles('open-host', BOUND,
      (calls) => async (strandId) => { calls.push(strandId); return null; });

    expect(result.strandId).toBe(HOST_STRAND_ID);
    expect(result.membershipInvite).toBeUndefined();
    expect(setup.hookCalls).toEqual([HOST_STRAND_ID]);
    expect(setup.recorder.usageRecorded).toHaveLength(1);
  });

  it('hook unwired (mock/transport posture) → approved with no invitation', async () => {
    const { setup, result } = await formBothRoles('unwired', BOUND);

    expect(result.strandId).toBe(HOST_STRAND_ID);
    expect(result.memberPrivateKey).toBe(HOST_MEMBER_KEY);
    expect(result.membershipInvite).toBeUndefined();
    expect(setup.recorder.usageRecorded).toHaveLength(1);
  });

  it('the raw approval frame omits membershipInvite (not null-valued) when none is issued', async () => {
    const manager = new StrandFormationManager({
      formationUsageRecorder: fakeRecorder(BOUND),
      partyId: HOST_PARTY,
      cadrePeerAddrs: HOST_CADRE,
      issueMembershipInvite: async () => null
    });

    const reply = await respondOnce(manager, 'invite-frame-omit');

    expect(reply.approved).toBe(true);
    expect('membershipInvite' in (reply.provisionResult ?? {})).toBe(false);
  });
});

describe('formation membership invitation (paths that never issue one)', () => {
  it('unbound path: the hook is never consulted and no invitation is carried', async () => {
    const hookCalls: string[] = [];
    const recorder = fakeRecorder({ kind: 'unbound' });
    recorder.provisionAndRecord = async () => ({ strandId: 'strand-unbound-fresh', memberPrivateKey: null });
    const manager = new StrandFormationManager({
      formationUsageRecorder: recorder,
      partyId: HOST_PARTY,
      cadrePeerAddrs: HOST_CADRE,
      issueMembershipInvite: async (strandId) => { hookCalls.push(strandId); return GOOD_INVITE; }
    });
    const { node, invoke } = captureHandler();
    manager.registerResponder(node);
    const { invitation, disclosure, consent } = await formationArgs('invite-unbound', 'unbound');

    const result = await manager.formStrand(invitation, disclosure, consent, bridgingDialer(invoke));

    expect(result.strandId).toBe('strand-unbound-fresh');
    expect(result.membershipInvite).toBeUndefined();
    expect(hookCalls).toHaveLength(0);
  });

  it('invalid token: rejected before the hook is ever consulted', async () => {
    const hookCalls: string[] = [];
    const recorder = fakeRecorder(BOUND);
    recorder.isTokenValid = async () => ({ valid: false });
    const manager = new StrandFormationManager({
      formationUsageRecorder: recorder,
      partyId: HOST_PARTY,
      cadrePeerAddrs: HOST_CADRE,
      issueMembershipInvite: async (strandId) => { hookCalls.push(strandId); return GOOD_INVITE; }
    });

    const reply = await respondOnce(manager, 'invite-bad-token');

    expect(reply.approved).toBe(false);
    expect(reply.provisionResult).toBeUndefined();
    expect(hookCalls).toHaveLength(0);
    expect(recorder.usageRecorded).toHaveLength(0);
  });
});

describe('formation membership invitation (initiator floor)', () => {
  it('a malformed invitation from a hostile responder fails the default result validation', async () => {
    // The hook's return is force-cast malformed — standing in for a hostile responder,
    // since both roles share this one manager. The initiator's DEFAULT validator must
    // reject the result rather than hand the joiner an unredeemable membership.
    const malformed = { inviteKey: 'not base64url !!!', invitePrivateKey: 42 };
    const recorder = fakeRecorder(BOUND);
    const manager = new StrandFormationManager({
      formationUsageRecorder: recorder,
      partyId: HOST_PARTY,
      cadrePeerAddrs: HOST_CADRE,
      issueMembershipInvite: async () => malformed as unknown as StrandMembershipInvite
    });
    const { node, invoke } = captureHandler();
    manager.registerResponder(node);
    const { invitation, disclosure, consent } = await formationArgs('invite-malformed', 'malformed');

    await expect(
      manager.formStrand(invitation, disclosure, consent, bridgingDialer(invoke))
    ).rejects.toThrow(/Responder result failed validation/);
  });

  it('a permissive custom validator still cannot get a malformed invitation into the result', async () => {
    // The default validator is the FIRST floor; this pins the SECOND — the manager's own
    // re-check, which drops (rather than carries) an invitation a custom
    // FormationResponseValidator waved through.
    const malformed = { inviteKey: 'not base64url !!!', invitePrivateKey: 42 };
    const recorder = fakeRecorder(BOUND);
    const manager = new StrandFormationManager({
      formationUsageRecorder: recorder,
      partyId: HOST_PARTY,
      cadrePeerAddrs: HOST_CADRE,
      formationResponseValidator: { async validateResponse() { return true; } },
      issueMembershipInvite: async () => malformed as unknown as StrandMembershipInvite
    });
    const { node, invoke } = captureHandler();
    manager.registerResponder(node);
    const { invitation, disclosure, consent } = await formationArgs('invite-permissive', 'permissive');

    const result = await manager.formStrand(invitation, disclosure, consent, bridgingDialer(invoke));

    expect(result.strandId).toBe(HOST_STRAND_ID);
    expect(result.membershipInvite).toBeUndefined();
  });

  it('isWellFormedMembershipInvite: accepts the real shape, rejects every malformation', () => {
    expect(isWellFormedMembershipInvite(GOOD_INVITE)).toBe(true);
    // The length bound is inclusive — a future longer encoding must not be rejected one
    // character early.
    expect(isWellFormedMembershipInvite({ inviteKey: 'A'.repeat(256), invitePrivateKey: 'B' })).toBe(true);

    expect(isWellFormedMembershipInvite(undefined)).toBe(false);
    expect(isWellFormedMembershipInvite(null)).toBe(false);
    expect(isWellFormedMembershipInvite('A'.repeat(43))).toBe(false);
    expect(isWellFormedMembershipInvite({})).toBe(false);
    expect(isWellFormedMembershipInvite({ inviteKey: GOOD_INVITE.inviteKey })).toBe(false);
    expect(isWellFormedMembershipInvite({ ...GOOD_INVITE, invitePrivateKey: 42 })).toBe(false);
    expect(isWellFormedMembershipInvite({ ...GOOD_INVITE, inviteKey: '' })).toBe(false);
    expect(isWellFormedMembershipInvite({ ...GOOD_INVITE, inviteKey: 'has spaces!' })).toBe(false);
    expect(isWellFormedMembershipInvite({ ...GOOD_INVITE, inviteKey: 'A'.repeat(257) })).toBe(false);
  });
});
