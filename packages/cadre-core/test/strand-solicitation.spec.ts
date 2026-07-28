import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createLibp2p, type Libp2p } from 'libp2p';
import { tcp } from '@libp2p/tcp';
import { noise } from '@chainsafe/libp2p-noise';
import { yamux } from '@chainsafe/libp2p-yamux';
import { generateKeyPair } from '@libp2p/crypto/keys';
import {
  StrandSolicitationService,
  type DisclosureValidator,
  type FormationUsageRecorder,
  type FormationSigner,
  type FormationResponseValidator,
  type StrandProvisioner
} from '../src/strand-solicitation.js';
import type { StrandFormationDisclosure, OpenInvitation } from '../src/types.js';

// Helper to create libp2p nodes with proper keys for Noise
async function createLibp2pNodeWithKeys(port: number = 0): Promise<Libp2p> {
  const privateKey = await generateKeyPair('Ed25519');
  return createLibp2p({
    privateKey,
    addresses: { listen: [`/ip4/127.0.0.1/tcp/${port}`] },
    transports: [tcp()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    connectionManager: { dialTimeout: 5000 }
  });
}

describe('StrandSolicitationService', () => {
  describe('formStrand', () => {
    it('should generate member key and private key', async () => {
      const service = new StrandSolicitationService();
      const disclosure: StrandFormationDisclosure = {
        partyId: 'party-123',
        purpose: 'Test strand formation'
      };

      const result = await service.formStrand('test-token', disclosure);

      expect(result.memberKey).toBeDefined();
      expect(result.memberKey.startsWith('12D3KooW')).toBe(true); // Ed25519 peer ID
      expect(result.invitePrivateKey).toBeDefined();
      expect(result.invitePrivateKey.length).toBeGreaterThan(0);
      expect(result.strandId).toBeDefined();
      expect(result.strandId.startsWith('strand-')).toBe(true);
    });

    it('should generate unique keys for each call', async () => {
      const service = new StrandSolicitationService();
      const disclosure: StrandFormationDisclosure = { partyId: 'party-123' };

      const result1 = await service.formStrand('token-1', disclosure);
      const result2 = await service.formStrand('token-2', disclosure);

      expect(result1.memberKey).not.toBe(result2.memberKey);
      expect(result1.strandId).not.toBe(result2.strandId);
    });
  });

  describe('validateStrandFormation', () => {
    it('should throw without formationSigner', async () => {
      const service = new StrandSolicitationService();
      const disclosure: StrandFormationDisclosure = { partyId: 'party-123' };

      await expect(service.validateStrandFormation('token', disclosure))
        .rejects.toThrow('FormationSigner not configured');
    });

    it('should throw for invalid token', async () => {
      const mockRecorder: FormationUsageRecorder = {
        recordUsage: async () => {},
        isTokenUsed: async () => false,
        isTokenValid: async () => ({ valid: false })
      };
      const mockSigner: FormationSigner = {
        signFormation: async () => ({ validationKey: 'key', validationSignature: 'sig' })
      };

      const service = new StrandSolicitationService({
        formationUsageRecorder: mockRecorder,
        formationSigner: mockSigner
      });

      await expect(service.validateStrandFormation('bad-token', {}))
        .rejects.toThrow('Invalid or expired token');
    });

    it('should throw for already-used token', async () => {
      const mockRecorder: FormationUsageRecorder = {
        recordUsage: async () => {},
        isTokenUsed: async () => true,
        isTokenValid: async () => ({ valid: true })
      };
      const mockSigner: FormationSigner = {
        signFormation: async () => ({ validationKey: 'key', validationSignature: 'sig' })
      };

      const service = new StrandSolicitationService({
        formationUsageRecorder: mockRecorder,
        formationSigner: mockSigner
      });

      await expect(service.validateStrandFormation('used-token', {}))
        .rejects.toThrow('Token has already been used');
    });

    it('should throw for failed disclosure validation', async () => {
      const mockValidator: DisclosureValidator = {
        validateDisclosure: async () => false
      };
      const mockSigner: FormationSigner = {
        signFormation: async () => ({ validationKey: 'key', validationSignature: 'sig' })
      };

      const service = new StrandSolicitationService({
        disclosureValidator: mockValidator,
        formationSigner: mockSigner
      });

      await expect(service.validateStrandFormation('token', { partyId: 'bad-party' }))
        .rejects.toThrow('Disclosure validation failed');
    });

    it('should return validation result for valid formation', async () => {
      const mockSigner: FormationSigner = {
        signFormation: async () => ({
          validationKey: 'validation-key-123',
          validationSignature: 'signature-abc'
        })
      };

      const service = new StrandSolicitationService({
        formationSigner: mockSigner
      });

      const result = await service.validateStrandFormation('valid-token', { partyId: 'party-1' });

      expect(result.validationKey).toBe('validation-key-123');
      expect(result.validationSignature).toBe('signature-abc');
    });
  });

  describe('createOpenInvitation', () => {
    it('should create invitation with correct fields', async () => {
      const service = new StrandSolicitationService();
      const bootstrap = ['/ip4/127.0.0.1/tcp/4001/p2p/12D3KooWTest'];

      const invitation = await service.createOpenInvitation('sapp-123', 3600000, bootstrap);

      expect(invitation.token).toBeDefined();
      expect(invitation.token.startsWith('invite-')).toBe(true);
      expect(invitation.sAppId).toBe('sapp-123');
      expect(invitation.bootstrap).toEqual(bootstrap);
      expect(invitation.expiration).toBeInstanceOf(Date);
      expect(invitation.expiration.getTime()).toBeGreaterThan(Date.now());
    });
  });

  // ── hasOutstandingInvitation: the connection gate's formation exemption ────
  //
  // "Does this node EXPECT a stranger?" — the sole input to
  // `CadreNode.admitInboundControlConnection`'s formation check. Two sources:
  // the in-memory mint registry, then the recorder's optional durable answer.
  describe('hasOutstandingInvitation', () => {
    /** A recorder with only the required members; usage/validity are inert. */
    function inertRecorder(overrides: Partial<FormationUsageRecorder> = {}): FormationUsageRecorder {
      return {
        recordUsage: async () => {},
        isTokenUsed: async () => false,
        isTokenValid: async () => ({ valid: true }),
        ...overrides
      };
    }

    it('is false for a fresh service that has minted nothing (eager registration stays gated)', async () => {
      const service = new StrandSolicitationService();
      expect(await service.hasOutstandingInvitation()).toBe(false);
    });

    it('is true after minting, and false again once that mint expires', async () => {
      vi.useFakeTimers();
      try {
        const service = new StrandSolicitationService();
        await service.createOpenInvitation('sapp-1', 60_000, []);
        expect(await service.hasOutstandingInvitation()).toBe(true);

        // Exactly at expiry the invitation is already gone (`expiresAtMs <= now`),
        // matching the recorder's strict-freshness comparison.
        vi.advanceTimersByTime(60_000);
        expect(await service.hasOutstandingInvitation()).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    it('with no recorder, an unexpired mint is outstanding by construction (no consumption oracle)', async () => {
      const service = new StrandSolicitationService();
      await service.createOpenInvitation('sapp-1', 60_000, []);
      expect(await service.hasOutstandingInvitation()).toBe(true);
    });

    it('drops a mint the recorder reports consumed, and never re-asks about it', async () => {
      let usedChecks = 0;
      const service = new StrandSolicitationService({
        formationUsageRecorder: inertRecorder({
          isTokenUsed: async () => { usedChecks++; return true; }
        })
      });
      await service.createOpenInvitation('sapp-1', 60_000, []);

      expect(await service.hasOutstandingInvitation()).toBe(false);
      expect(usedChecks).toBe(1);
      // Consumption is permanent: the registry entry is gone, so no second read.
      expect(await service.hasOutstandingInvitation()).toBe(false);
      expect(usedChecks).toBe(1);
    });

    it('keeps a minted-but-unconsumed token outstanding', async () => {
      const service = new StrandSolicitationService({
        formationUsageRecorder: inertRecorder({ isTokenUsed: async () => false })
      });
      await service.createOpenInvitation('sapp-1', 60_000, []);
      expect(await service.hasOutstandingInvitation()).toBe(true);
    });

    it('delegates to the recorder when the registry is empty', async () => {
      const durable = new StrandSolicitationService({
        formationUsageRecorder: inertRecorder({ hasOutstandingInvitation: async () => true })
      });
      expect(await durable.hasOutstandingInvitation()).toBe(true);

      const drained = new StrandSolicitationService({
        formationUsageRecorder: inertRecorder({ hasOutstandingInvitation: async () => false })
      });
      expect(await drained.hasOutstandingInvitation()).toBe(false);
    });

    it('is false when the recorder omits the optional durable method', async () => {
      const service = new StrandSolicitationService({ formationUsageRecorder: inertRecorder() });
      expect(await service.hasOutstandingInvitation()).toBe(false);
    });

    it('registerMintedInvitation covers a token minted elsewhere (publishFormationInvite path)', async () => {
      const service = new StrandSolicitationService();
      service.registerMintedInvitation('invite-from-elsewhere', Number.POSITIVE_INFINITY);
      expect(await service.hasOutstandingInvitation()).toBe(true);
    });
  });

  describe('recordFormationComplete', () => {
    it('should call recorder when available', async () => {
      let recorded: { token: string; initiatorKey: string; strandId: string } | null = null;

      const mockRecorder: FormationUsageRecorder = {
        recordUsage: async (token, initiatorKey, strandId) => {
          recorded = { token, initiatorKey, strandId };
        },
        isTokenUsed: async () => false,
        isTokenValid: async () => ({ valid: true })
      };

      const service = new StrandSolicitationService({
        formationUsageRecorder: mockRecorder
      });

      await service.recordFormationComplete('token-1', 'key-1', 'strand-1');

      expect(recorded).toEqual({
        token: 'token-1',
        initiatorKey: 'key-1',
        strandId: 'strand-1'
      });
    });

    it('should not throw without recorder', async () => {
      const service = new StrandSolicitationService();

      await expect(service.recordFormationComplete('t', 'k', 's')).resolves.not.toThrow();
    });
  });
});

describe('StrandFormationManager Integration', () => {
  let nodeA: Libp2p;
  let nodeB: Libp2p;

  beforeEach(async () => {
    nodeA = await createLibp2pNodeWithKeys();
    nodeB = await createLibp2pNodeWithKeys();
    await nodeA.start();
    await nodeB.start();
  });

  afterEach(async () => {
    try { await nodeA?.stop(); } catch { /* best-effort teardown */ }
    try { await nodeB?.stop(); } catch { /* best-effort teardown */ }
  });

  it('should form strand via real protocol', async () => {
    // Create mock provisioner that returns a strand
    const mockProvisioner: StrandProvisioner = {
      provisionStrand: async () => ({
        strandId: `strand-${Date.now()}-test`
      })
    };

    // Create mock usage recorder that accepts all tokens
    const mockRecorder: FormationUsageRecorder = {
      recordUsage: async () => {},
      isTokenUsed: async () => false,
      isTokenValid: async (token) => ({
        valid: token.startsWith('invite-'),
        invitation: undefined
      })
    };

    // Responder (nodeA) - the party who created the invitation
    const responderService = new StrandSolicitationService({
      partyId: 'responder-party',
      cadrePeerAddrs: nodeA.getMultiaddrs().map(ma => ma.toString()),
      strandProvisioner: mockProvisioner,
      formationUsageRecorder: mockRecorder
    });
    responderService.registerResponder(nodeA);

    // Create an invitation
    const invitation = await responderService.createOpenInvitation(
      'test-sapp',
      60000,
      nodeA.getMultiaddrs().map(ma => ma.toString())
    );

    // Initiator (nodeB) - the party who received the invitation
    const initiatorService = new StrandSolicitationService({
      partyId: 'initiator-party',
      cadrePeerAddrs: nodeB.getMultiaddrs().map(ma => ma.toString())
    });

    // Form the strand
    const result = await initiatorService.formStrand(
      invitation,
      { partyId: 'initiator-party', purpose: 'Test strand formation' },
      nodeB
    );

    expect(result.memberKey).toBeDefined();
    expect(result.memberKey.startsWith('12D3KooW')).toBe(true);
    expect(result.strandId).toBeDefined();
    expect(result.strandId.startsWith('strand-')).toBe(true);

    // Cleanup
    responderService.unregisterResponder(nodeA);
  }, 15000);

  it('should handle multiple concurrent formations', async () => {
    const mockProvisioner: StrandProvisioner = {
      provisionStrand: async () => ({
        strandId: `strand-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      })
    };

    const mockRecorder: FormationUsageRecorder = {
      recordUsage: async () => {},
      isTokenUsed: async () => false,
      isTokenValid: async () => ({ valid: true })
    };

    const responderService = new StrandSolicitationService({
      partyId: 'responder-party',
      cadrePeerAddrs: nodeA.getMultiaddrs().map(ma => ma.toString()),
      strandProvisioner: mockProvisioner,
      formationUsageRecorder: mockRecorder
    });
    responderService.registerResponder(nodeA);

    const invitation = await responderService.createOpenInvitation(
      'test-sapp',
      60000,
      nodeA.getMultiaddrs().map(ma => ma.toString())
    );

    // Create multiple initiators
    const promises = [];
    for (let i = 0; i < 3; i++) {
      const initiatorService = new StrandSolicitationService({
        partyId: `initiator-${i}`
      });
      promises.push(
        initiatorService.formStrand(invitation, { partyId: `initiator-${i}` }, nodeB)
      );
    }

    const results = await Promise.all(promises);

    expect(results.length).toBe(3);
    const strandIds = results.map(r => r.strandId);
    const uniqueIds = new Set(strandIds);
    expect(uniqueIds.size).toBe(3); // Each formation should get a unique strand

    responderService.unregisterResponder(nodeA);
  }, 20000);

  it('should reject invalid tokens', async () => {
    const mockRecorder: FormationUsageRecorder = {
      recordUsage: async () => {},
      isTokenUsed: async () => false,
      isTokenValid: async (token) => ({ valid: token === 'valid-token' })
    };

    const responderService = new StrandSolicitationService({
      partyId: 'responder-party',
      formationUsageRecorder: mockRecorder
    });
    responderService.registerResponder(nodeA);

    // Create invitation with invalid token
    const invitation: OpenInvitation = {
      token: 'invalid-token',
      sAppId: 'test-sapp',
      expiration: new Date(Date.now() + 60000),
      bootstrap: nodeA.getMultiaddrs().map(ma => ma.toString())
    };

    const initiatorService = new StrandSolicitationService({
      partyId: 'initiator-party'
    });

    await expect(
      initiatorService.formStrand(invitation, {}, nodeB)
    ).rejects.toThrow();

    responderService.unregisterResponder(nodeA);
  }, 10000);
});

// ── Real disclosure + result validation over the native transport ─────────────
//
// These promote the confirmed reproduction (disclosure/token/cadre-addrs were
// never carried end-to-end, result validation was stubbed) into permanent tests.
describe('StrandFormationManager transport: real disclosure + result validation', () => {
  let nodeA: Libp2p;
  let nodeB: Libp2p;

  beforeEach(async () => {
    nodeA = await createLibp2pNodeWithKeys();
    nodeB = await createLibp2pNodeWithKeys();
    await nodeA.start();
    await nodeB.start();
  });

  afterEach(async () => {
    try { await nodeA?.stop(); } catch { /* best-effort teardown */ }
    try { await nodeB?.stop(); } catch { /* best-effort teardown */ }
  });

  it('transmits the real token and disclosure to the responder', async () => {
    let captured: { token: string; disclosure: StrandFormationDisclosure } | null = null;
    const capturingValidator: DisclosureValidator = {
      validateDisclosure: async (token, disclosure) => {
        captured = { token, disclosure };
        return true;
      }
    };

    const responder = new StrandSolicitationService({
      partyId: 'responder-party',
      cadrePeerAddrs: nodeA.getMultiaddrs().map(ma => ma.toString()),
      strandProvisioner: { provisionStrand: async () => ({ strandId: 'strand-real-1' }) },
      disclosureValidator: capturingValidator
    });
    responder.registerResponder(nodeA);

    const invitation = await responder.createOpenInvitation(
      'test-sapp',
      60000,
      nodeA.getMultiaddrs().map(ma => ma.toString())
    );

    const initiator = new StrandSolicitationService({
      partyId: 'initiator-party',
      cadrePeerAddrs: nodeB.getMultiaddrs().map(ma => ma.toString())
    });

    const result = await initiator.formStrand(
      invitation,
      { partyId: 'ignored-overridden-by-memberkey', purpose: 'real-purpose' },
      nodeB
    );

    // The responder saw the REAL token + disclosure — not '' + { partyId: sessionId }.
    expect(captured).not.toBeNull();
    expect(captured!.token).toBe(invitation.token);
    expect(captured!.disclosure.purpose).toBe('real-purpose');
    expect(captured!.disclosure.partyId).toBe(result.memberKey);

    responder.unregisterResponder(nodeA);
  }, 15000);

  it('delivers the responder real cadre addresses to the initiator (no placeholders)', async () => {
    const responderAddrs = nodeA.getMultiaddrs().map(ma => ma.toString());
    let receivedAddrs: string[] | undefined;
    const captureResponse: FormationResponseValidator = {
      validateResponse: async ({ response }) => {
        receivedAddrs = response.cadrePeerAddrs;
        return true;
      }
    };

    const responder = new StrandSolicitationService({
      partyId: 'responder-party',
      cadrePeerAddrs: responderAddrs,
      strandProvisioner: { provisionStrand: async () => ({ strandId: 'strand-addr-1' }) }
    });
    responder.registerResponder(nodeA);

    const invitation = await responder.createOpenInvitation('test-sapp', 60000, responderAddrs);

    const initiator = new StrandSolicitationService({
      partyId: 'initiator-party',
      cadrePeerAddrs: nodeB.getMultiaddrs().map(ma => ma.toString()),
      formationResponseValidator: captureResponse
    });

    await initiator.formStrand(invitation, { purpose: 'addr-check' }, nodeB);

    expect(receivedAddrs).toEqual(responderAddrs);
    expect(receivedAddrs?.length).toBeGreaterThan(0);
    expect(receivedAddrs?.some(a => a.includes('.local'))).toBe(false);

    responder.unregisterResponder(nodeA);
  }, 15000);

  it('rejects a responder that returns an empty strandId', async () => {
    const responder = new StrandSolicitationService({
      partyId: 'responder-party',
      cadrePeerAddrs: nodeA.getMultiaddrs().map(ma => ma.toString()),
      // Malicious/stub responder: provisions an empty strand id.
      strandProvisioner: { provisionStrand: async () => ({ strandId: '' }) }
    });
    responder.registerResponder(nodeA);

    const invitation = await responder.createOpenInvitation(
      'test-sapp',
      60000,
      nodeA.getMultiaddrs().map(ma => ma.toString())
    );

    const initiator = new StrandSolicitationService({
      partyId: 'initiator-party',
      cadrePeerAddrs: nodeB.getMultiaddrs().map(ma => ma.toString())
    });

    await expect(
      initiator.formStrand(invitation, { purpose: 'reject-empty-strand' }, nodeB)
    ).rejects.toThrow();

    responder.unregisterResponder(nodeA);
  }, 15000);

  it('rejects a responder that discloses no cadre addresses', async () => {
    const responder = new StrandSolicitationService({
      partyId: 'responder-party',
      // Omits its disclosed cadre entirely.
      cadrePeerAddrs: [],
      strandProvisioner: { provisionStrand: async () => ({ strandId: 'strand-nocadre-1' }) }
    });
    responder.registerResponder(nodeA);

    const invitation = await responder.createOpenInvitation(
      'test-sapp',
      60000,
      nodeA.getMultiaddrs().map(ma => ma.toString())
    );

    const initiator = new StrandSolicitationService({
      partyId: 'initiator-party',
      cadrePeerAddrs: nodeB.getMultiaddrs().map(ma => ma.toString())
    });

    await expect(
      initiator.formStrand(invitation, { purpose: 'reject-no-cadre' }, nodeB)
    ).rejects.toThrow();

    responder.unregisterResponder(nodeA);
  }, 15000);
});
