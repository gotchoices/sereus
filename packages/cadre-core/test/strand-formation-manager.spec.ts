/**
 * `StrandFormationManager` provisioning-budget derivation: ONE config knob
 * (`StrandFormationManagerConfig.provisionTimeoutMs`) sets the RESPONDER's own
 * `provisionStrand` work+grace budget; the INITIATOR's `await-response` wait is derived
 * automatically as `host + PROVISION_RESPONSE_TRAVEL_MARGIN_MS` (`initiatorProvisionTimeoutMs`
 * in strand-formation-manager.ts) so the two can never be configured out of the ordering
 * `strand-formation-protocol.ts` documents (responder provisioning < initiator await-response).
 *
 * Unlike `strand-formation-protocol.spec.ts` (drives `FormationListener`/`dialFormation`
 * directly) and `strand-formation-consent.spec.ts` (drives ONE `StrandFormationManager` as a
 * responder only, via a captured libp2p handler + a canned inbound `MockStream`), this file
 * drives a SINGLE manager as BOTH roles over a real in-memory duplex bridge — `QueueStream` +
 * `makePair` below — so `formStrand`'s outbound write actually reaches the manager's OWN
 * `registerResponder` handler and the handler's reply actually reaches back.
 *
 * Covers:
 *  - the host's `provisionTimeoutMs` clean-timeout reply beats the initiator's own (larger,
 *    derived) await-response timeout — i.e. the initiator is still listening when it arrives,
 *  - `provisionTimeoutMs` omitted and `0` both fall back to independent per-role defaults.
 */
import { describe, it, expect } from 'vitest';
import type { Libp2p } from '@libp2p/interface';
import type { ControlStream } from '../src/control-stream.js';
import { StrandFormationManager } from '../src/strand-formation-manager.js';
import type { OpenInvitation, StrandFormationDisclosure } from '../src/types.js';
import { mintContactJoiner, mintContactConsent, type JoinerConsent } from './formation-consent-helper.js';

// ── In-memory duplex bridge: a live libp2p-shaped stream pair, not a canned frame list ──

/**
 * One end of an in-memory duplex pipe. `send()` delivers straight into the PEER's inbox (a
 * live push, not a canned reply list), so a real caller on one end can write and a real
 * handler on the other end can read — needed here because `formStrand` must actually see the
 * manager's OWN responder reply, not a pre-scripted frame.
 */
class QueueStream implements ControlStream {
  readonly sent: Uint8Array[] = [];
  closed = false;
  peer!: QueueStream;
  private readonly inbox: Uint8Array[] = [];
  private pendingResolve?: (result: IteratorResult<Uint8Array>) => void;
  private ended = false;

  private deliver(data: Uint8Array): void {
    if (this.pendingResolve) {
      const resolve = this.pendingResolve;
      this.pendingResolve = undefined;
      resolve({ value: data, done: false });
      return;
    }
    this.inbox.push(data);
  }

  private endInbox(): void {
    this.ended = true;
    if (this.pendingResolve) {
      const resolve = this.pendingResolve;
      this.pendingResolve = undefined;
      resolve({ value: undefined as unknown as Uint8Array, done: true });
    }
  }

  send(data: Uint8Array): boolean {
    this.sent.push(data);
    this.peer.deliver(data);
    return true;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.peer.endInbox();
  }

  abort(_err: Error): void {
    this.closed = true;
    this.peer.endInbox();
  }

  [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
    return {
      next: (): Promise<IteratorResult<Uint8Array>> => {
        if (this.inbox.length > 0) {
          return Promise.resolve({ value: this.inbox.shift()!, done: false });
        }
        if (this.ended) {
          return Promise.resolve({ value: undefined as unknown as Uint8Array, done: true });
        }
        return new Promise((resolve) => { this.pendingResolve = resolve; });
      }
    };
  }
}

/** Two cross-wired `QueueStream`s: `a.send()` reaches `b`'s reader and vice versa. */
function makePair(): [QueueStream, QueueStream] {
  const a = new QueueStream();
  const b = new QueueStream();
  a.peer = b;
  b.peer = a;
  return [a, b];
}

/** A mock node that captures the registered protocol handler so it can be driven directly. */
function captureHandler(): { node: Libp2p; invoke: (stream: unknown, conn: unknown) => Promise<void> } {
  let handler: ((stream: unknown, conn: unknown) => Promise<void>) | undefined;
  const node = {
    handle: (_id: string, fn: (stream: unknown, conn: unknown) => Promise<void>) => { handler = fn; },
    unhandle: () => {}
  } as unknown as Libp2p;
  return {
    node,
    invoke: async (stream: unknown, conn: unknown) => {
      if (!handler) throw new Error('handler not registered');
      await handler(stream, conn);
    }
  };
}

/** A `Libp2p` double whose `dialProtocol` bridges straight into the responder's OWN handler. */
function bridgingDialer(invoke: (stream: unknown, conn: unknown) => Promise<void>): Libp2p {
  return {
    dialProtocol: async () => {
      const [respEnd, initEnd] = makePair();
      void invoke(respEnd, {});
      return initEnd;
    }
  } as unknown as Libp2p;
}

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

const rand = (): string => Math.random().toString(36).slice(2);

describe('StrandFormationManager: one provisionTimeoutMs config drives both roles', () => {
  it("the host's own provisionTimeoutMs beats the derived (larger) initiator await-response budget", async () => {
    // config.provisionTimeoutMs = 200 sets the RESPONDER's work+grace budget; the strand
    // provisioner never resolves, so the host cleanly times out and replies
    // 'Formation provisioning timed out' at ~200ms. The initiator's derived budget is
    // 200 + PROVISION_RESPONSE_TRAVEL_MARGIN_MS (3000) = 3200ms, so it is still listening
    // when that clean reply arrives — the assertion below is that specific rejection, not
    // dialFormation's OWN generic 'Formation await-response timed out after Nms', which is
    // what a same-budget bug (initiator sharing the host's 200ms) would produce instead.
    const token = `invite-budget-${rand()}`;
    const manager = new StrandFormationManager({
      strandProvisioner: { provisionStrand: () => new Promise<{ strandId: string }>(() => { /* never settles */ }) },
      partyId: 'both-roles-party',
      cadrePeerAddrs: RESPONDER_CADRE,
      config: { provisionTimeoutMs: 200 }
    });
    const { node: respNode, invoke } = captureHandler();
    manager.registerResponder(respNode);

    const { invitation, disclosure, consent } = await formationArgs(token, 'budget');

    await expect(
      manager.formStrand(invitation, disclosure, consent, bridgingDialer(invoke))
    ).rejects.toThrow(/Formation rejected: Formation provisioning timed out/);
  });

  it('provisionTimeoutMs omitted: both sides fall back to their own independent defaults', async () => {
    const token = `invite-unset-${rand()}`;
    const manager = new StrandFormationManager({
      strandProvisioner: {
        provisionStrand: async () => {
          await new Promise((resolve) => setTimeout(resolve, 20));
          return { strandId: 'strand-unset-ok' };
        }
      },
      partyId: 'both-roles-party',
      cadrePeerAddrs: RESPONDER_CADRE
      // config omitted entirely — must not throw/hang deriving the initiator budget from nothing.
    });
    const { node: respNode, invoke } = captureHandler();
    manager.registerResponder(respNode);

    const { invitation, disclosure, consent } = await formationArgs(token, 'unset');

    const result = await manager.formStrand(invitation, disclosure, consent, bridgingDialer(invoke));
    expect(result.strandId).toBe('strand-unset-ok');
  });

  it('provisionTimeoutMs: 0 behaves as unset, same as omitting it', async () => {
    const token = `invite-zero-${rand()}`;
    const manager = new StrandFormationManager({
      strandProvisioner: {
        provisionStrand: async () => {
          await new Promise((resolve) => setTimeout(resolve, 20));
          return { strandId: 'strand-zero-ok' };
        }
      },
      partyId: 'both-roles-party',
      cadrePeerAddrs: RESPONDER_CADRE,
      config: { provisionTimeoutMs: 0 }
    });
    const { node: respNode, invoke } = captureHandler();
    manager.registerResponder(respNode);

    const { invitation, disclosure, consent } = await formationArgs(token, 'zero');

    const result = await manager.formStrand(invitation, disclosure, consent, bridgingDialer(invoke));
    expect(result.strandId).toBe('strand-zero-ok');
  });
});
