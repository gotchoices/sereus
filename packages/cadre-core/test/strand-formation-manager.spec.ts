/**
 * `StrandFormationManager` provisioning-budget derivation: ONE config knob
 * (`StrandFormationManagerConfig.provisionTimeoutMs`) sets the RESPONDER's own
 * `provisionStrand` work+grace budget; the INITIATOR's `await-response` wait is derived
 * automatically as `host + responseTravelMarginMs` of the ladder derived from the declared
 * link (`initiatorProvisionTimeoutMs` in strand-formation-manager.ts) so the two can never be
 * configured out of the ordering `strand-formation-protocol.ts` documents (responder
 * provisioning < initiator await-response).
 *
 * Unlike `strand-formation-protocol.spec.ts` (drives `FormationListener`/`dialFormation`
 * directly) and `strand-formation-consent.spec.ts` (drives ONE `StrandFormationManager` as a
 * responder only, via a captured libp2p handler + a canned inbound `MockStream`), this file
 * drives a SINGLE manager as BOTH roles over the live in-memory duplex bridge in
 * `formation-stream-helpers.ts`, so `formStrand`'s outbound write actually reaches the
 * manager's OWN `registerResponder` handler and the handler's reply actually reaches back.
 *
 * Covers:
 *  - the host's `provisionTimeoutMs` clean-timeout reply beats the initiator's own (larger,
 *    derived) await-response timeout — i.e. the initiator is still listening when it arrives,
 *  - the same holds in the CLAMPED regime, where a budget too large for the session forces
 *    both roles down to their ceilings,
 *  - `provisionTimeoutMs` omitted and `0` both fall back to independent per-role defaults.
 */
import { describe, it, expect } from 'vitest';
import { StrandFormationManager } from '../src/strand-formation-manager.js';
import type { StrandFormationManagerConfig } from '../src/strand-formation-manager.js';
import type { OpenInvitation, StrandFormationDisclosure } from '../src/types.js';
import { mintContactJoiner, mintContactConsent, type JoinerConsent } from './formation-consent-helper.js';
import { captureHandler, bridgingDialer } from './formation-stream-helpers.js';
import type { StrandProvisioner } from '../src/strand-solicitation.js';

const RESPONDER_CADRE = ['/ip4/10.0.0.1/tcp/2/p2p/both-roles'];

/** A real, validly-signed consent triple + a matching invitation for `formStrand`. */
async function formationArgs(
  token: string,
  purpose: string
): Promise<{ invitation: OpenInvitation; disclosure: StrandFormationDisclosure; consent: JoinerConsent }> {
  const joiner = await mintContactJoiner();
  // contact.partyId (set by formStrand from disclosure.partyId) must be the joiner's REAL
  // libp2p peer id — the responder's consent pre-check pins it against the embedded peerKey.
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

/** Run one formation with this manager acting as BOTH responder and initiator. */
async function formBothRoles(
  purpose: string,
  strandProvisioner: StrandProvisioner,
  config?: StrandFormationManagerConfig
): Promise<{ strandId: string }> {
  const manager = new StrandFormationManager({
    strandProvisioner,
    partyId: 'both-roles-party',
    cadrePeerAddrs: RESPONDER_CADRE,
    config
  });
  const { node: respNode, invoke } = captureHandler();
  await manager.registerResponder(respNode);

  const { invitation, disclosure, consent } = await formationArgs(`invite-${purpose}`, purpose);
  return manager.formStrand(invitation, disclosure, consent, bridgingDialer(invoke));
}

/** A provisioner that never settles — forces the responder onto its own timeout path. */
const stuckProvisioner: StrandProvisioner = {
  provisionStrand: () => new Promise<{ strandId: string }>(() => { /* never settles */ })
};

/** A provisioner that settles well inside any budget under test. */
function quickProvisioner(strandId: string): StrandProvisioner {
  return {
    provisionStrand: async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { strandId };
    }
  };
}

/** The responder's own clean timeout reply, as the initiator surfaces it. */
const RESPONDER_TIMEOUT_REPLY = /Formation rejected: Formation provisioning timed out/;

describe('StrandFormationManager: one provisionTimeoutMs config drives both roles', () => {
  it("the host's own provisionTimeoutMs beats the derived (larger) initiator await-response budget", async () => {
    // config.provisionTimeoutMs = 200 sets the RESPONDER's work+grace budget; the strand
    // provisioner never resolves, so the host cleanly times out and replies
    // 'Formation provisioning timed out' at ~200ms. The initiator's derived budget is
    // 200 + the travel margin at the default declared link (17 500 ms) = 17 700 ms, so it is
    // still listening when that clean reply arrives — the assertion below is that specific
    // rejection, not dialFormation's OWN generic 'Formation await-response timed out after
    // Nms', which is what a same-budget bug (initiator sharing the host's 200ms) would
    // produce instead.
    await expect(
      formBothRoles('budget', stuckProvisioner, { provisionTimeoutMs: 200 })
    ).rejects.toThrow(RESPONDER_TIMEOUT_REPLY);
  });

  it('keeps the responder ahead of the initiator even when BOTH budgets are clamped', async () => {
    // 9000ms is far above what a 1200ms session can hold, so both roles hit their ceiling.
    // The ceilings are NOT the same number. At a 100 ms link the responder's room is
    // 1200 - (contact 200 + validation 400) = 600, and it holds back a reserve for the
    // initiator (capped at half its room), so it lands at 300ms; the initiator waits the
    // full 1200 - dial 200 = 1000ms. Without that reserve the responder's clean reply
    // races the initiator's own timeout — the exact collapse the derived budget exists to
    // prevent, reintroduced by the clamp.
    await expect(
      formBothRoles('clamped', stuckProvisioner, {
        linkRoundTripMs: 100,
        sessionTimeoutMs: 1200,
        stepTimeoutMs: 200,
        dialTimeoutMs: 200,
        provisionTimeoutMs: 9000
      })
    ).rejects.toThrow(RESPONDER_TIMEOUT_REPLY);
  });

  it('provisionTimeoutMs omitted: both sides fall back to their own independent defaults', async () => {
    // config omitted entirely — must not throw/hang deriving the initiator budget from nothing.
    const result = await formBothRoles('unset', quickProvisioner('strand-unset-ok'));
    expect(result.strandId).toBe('strand-unset-ok');
  });

  it('provisionTimeoutMs: 0 behaves as unset, same as omitting it', async () => {
    const result = await formBothRoles('zero', quickProvisioner('strand-zero-ok'), { provisionTimeoutMs: 0 });
    expect(result.strandId).toBe('strand-zero-ok');
  });
});
