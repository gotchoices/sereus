import { describe, it, expect, beforeEach } from 'vitest';
import { generatePrivateKey, getPublicKey, digest, sign } from '@optimystic/quereus-plugin-crypto';
import { CadreNode } from '../src/cadre-node.js';
import {
  SeedBootstrapService,
  canonicalSeedPayload,
  SEED_PROTOCOL,
} from '../src/seed-bootstrap.js';
import {
  pinnedKeyTrustPolicy,
  type SeedTrustPolicy,
} from '../src/seed-trust-policy.js';
import type {
  ControlNetworkSeed,
  SeedPeer,
  SeedMessage,
  SeedAckMessage,
} from '../src/types.js';

/**
 * Wiring coverage for the `CadreNodeConfig.seedTrustPolicy` seam.
 *
 * The node forwards its node-wide default policy into ALL THREE
 * `SeedBootstrapService` construction sites — the owner service
 * (`initializeSeedBootstrap`), the receive-only listener (`enableSeedListener`),
 * and the temp service `applySeed` builds when no service exists. A missed site
 * silently reverts that path to the anchored default and the cold-start
 * network case fails only in production, so each path is exercised explicitly.
 *
 * Precedence under test:
 *   applySeed(seed, { trustPolicy })   ← per-call override (highest)
 *     └─ CadreNode.config.seedTrustPolicy  ← service default (this seam)
 *          └─ anchoredTrustPolicy()        ← secure fallback (unset → cold reject)
 */
describe('CadreNode seedTrustPolicy wiring', () => {
  let ownerPrivateKey: string;
  let ownerPublicKey: string;
  let attackerPrivateKey: string;
  let attackerPublicKey: string;
  /** Fixed party the signed seeds claim; node partyIds are randomized below. */
  const seedParty = 'seed-trust-party';

  beforeEach(() => {
    ownerPrivateKey = generatePrivateKey('ed25519', 'base64url') as string;
    ownerPublicKey = getPublicKey(ownerPrivateKey, 'ed25519', 'base64url', 'base64url') as string;
    attackerPrivateKey = generatePrivateKey('ed25519', 'base64url') as string;
    attackerPublicKey = getPublicKey(attackerPrivateKey, 'ed25519', 'base64url', 'base64url') as string;
  });

  /** A signature-valid, peerless cold seed signed by `privateKey`. */
  function signSeed(privateKey: string, publicKey: string): ControlNetworkSeed {
    const seedData = { partyId: seedParty, peers: [] as SeedPeer[] };
    const seedDigest = digest([canonicalSeedPayload(seedData)], 'sha256', 'base64url') as string;
    const signature = sign(
      seedDigest, privateKey, 'ed25519', 'base64url', 'base64url', 'base64url'
    ) as string;
    return { ...seedData, signature, signerKey: publicKey };
  }

  /** A cold (empty trusted-owner anchor, no bootstrap peers) CadreNode. */
  function makeColdNode(seedTrustPolicy?: SeedTrustPolicy): CadreNode {
    return new CadreNode({
      controlNetwork: {
        partyId: 'node-' + Math.random().toString(36).slice(2),
        bootstrapNodes: [],
      },
      profile: 'transaction',
      seedTrustPolicy,
    });
  }

  /** Start a node and neutralize the background self-registration timer. */
  async function startClean(node: CadreNode): Promise<void> {
    await node.start();
    clearTimeout((node as unknown as { selfRegistrationTimer: ReturnType<typeof setTimeout> }).selfRegistrationTimer);
    (node as unknown as { selfRegistrationTimer: null }).selfRegistrationTimer = null;
  }

  it('cold node with no configured policy rejects a seed (secure anchored default, temp-service path)', async () => {
    const node = makeColdNode(); // seedTrustPolicy unset
    try {
      await startClean(node);
      // No initializeSeedBootstrap / enableSeedListener → applySeed builds a temp
      // service. Unset policy must fall through to anchoredTrustPolicy().
      const result = await node.applySeed(signSeed(ownerPrivateKey, ownerPublicKey));
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/anchored trust policy/i);
    } finally {
      await node.stop();
    }
  }, 60_000);

  it('cold node with a configured pinned default applies a seed via the temp-service path (no per-call override)', async () => {
    const node = makeColdNode(pinnedKeyTrustPolicy([ownerPublicKey]));
    try {
      await startClean(node);
      // The configured default is the ONLY seam a network-delivered seed can use.
      const result = await node.applySeed(signSeed(ownerPrivateKey, ownerPublicKey));
      expect(result.success).toBe(true);
    } finally {
      await node.stop();
    }
  }, 60_000);

  it('a per-call trustPolicy override beats the forwarded configured default (temp-service path)', async () => {
    // Configure a default that rejects the real signer (pin a DIFFERENT key).
    // Both applySeed calls run through the service-less temp-service path; since the
    // temp service no longer registers the wire handler, two consecutive calls are
    // safe (no DuplicateProtocolHandlerError) — exercise override-vs-default directly.
    const node = makeColdNode(pinnedKeyTrustPolicy([attackerPublicKey]));
    try {
      await startClean(node);
      const seed = signSeed(ownerPrivateKey, ownerPublicKey);

      // Without an override the forwarded configured default rejects.
      const rejected = await node.applySeed(seed);
      expect(rejected.success).toBe(false);

      // A per-call override pinning the real signer wins over the default.
      const accepted = await node.applySeed(seed, {
        trustPolicy: pinnedKeyTrustPolicy([ownerPublicKey]),
      });
      expect(accepted.success).toBe(true);
    } finally {
      await node.stop();
    }
  }, 60_000);

  it('two consecutive temp-service applySeed calls are idempotent: both apply, no unhandled rejection', async () => {
    // A service-less cold node routes every applySeed through a throwaway temp service.
    // Before the registerHandler:false fix, the second call re-ran libp2p.handle() for
    // SEED_PROTOCOL and the resulting DuplicateProtocolHandlerError surfaced as an
    // unhandled promise rejection (the caller fire-and-forgets the handle() promise).
    // Pin the real signer so both calls succeed and the only thing under test is safety.
    const node = makeColdNode(pinnedKeyTrustPolicy([ownerPublicKey]));
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown): void => { rejections.push(reason); };
    try {
      await startClean(node);
      const seed = signSeed(ownerPrivateKey, ownerPublicKey);

      // Scope the listener to the applySeed window — the only place the duplicate
      // handle() rejection would originate.
      process.on('unhandledRejection', onRejection);
      const first = await node.applySeed(seed);
      const second = await node.applySeed(seed);
      expect(first.success).toBe(true);
      expect(second.success).toBe(true);

      // The control node carries no leaked seed handler from the discarded temp services.
      const controlNode = node.getControlNode();
      expect(controlNode).not.toBeNull();
      expect(controlNode!.getProtocols()).not.toContain(SEED_PROTOCOL);

      // Let any deferred unhandledRejection (a duplicate handle() rejection) surface.
      await new Promise(resolve => setTimeout(resolve, 50));
      const duplicateHandlerRejections = rejections.filter(
        r => r instanceof Error && /already registered for protocol/i.test(r.message)
      );
      expect(duplicateHandlerRejections).toEqual([]);
      expect(rejections).toEqual([]);
    } finally {
      process.off('unhandledRejection', onRejection);
      await node.stop();
    }
  }, 60_000);

  it('a temp-service applySeed leaves the handler free for a later persistent listener', async () => {
    // After a temp-service applySeed, no discarded service owns SEED_PROTOCOL, so a
    // subsequently-enabled persistent listener can register the handler cleanly —
    // no DuplicateProtocolHandlerError, no unhandled rejection.
    const node = makeColdNode(pinnedKeyTrustPolicy([ownerPublicKey]));
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown): void => { rejections.push(reason); };
    try {
      await startClean(node);
      process.on('unhandledRejection', onRejection);
      const applied = await node.applySeed(signSeed(ownerPrivateKey, ownerPublicKey));
      expect(applied.success).toBe(true);

      // No leaked handler from the temp service before the listener owns it.
      expect(node.getControlNode()!.getProtocols()).not.toContain(SEED_PROTOCOL);

      // The persistent listener now claims the handler for the first time.
      node.enableSeedListener();
      await new Promise(resolve => setTimeout(resolve, 50));
      expect(node.getControlNode()!.getProtocols()).toContain(SEED_PROTOCOL);
      expect(rejections).toEqual([]);
    } finally {
      process.off('unhandledRejection', onRejection);
      await node.stop();
    }
  }, 60_000);

  it('enableSeedListener forwards the configured policy: pinned default applies, unset rejects', async () => {
    // With a configured pinned default the listener-built service applies a cold seed.
    const withPolicy = makeColdNode(pinnedKeyTrustPolicy([ownerPublicKey]));
    try {
      await startClean(withPolicy);
      withPolicy.enableSeedListener();
      const svc = withPolicy.getSeedBootstrapService();
      expect(svc).not.toBeNull();
      // getSeedBootstrapService().applySeed is the same entry the protocol handler uses.
      const result = await svc!.applySeed(signSeed(ownerPrivateKey, ownerPublicKey));
      expect(result.success).toBe(true);
    } finally {
      await withPolicy.stop();
    }

    // The same listener path with no configured policy rejects (secure default).
    const noPolicy = makeColdNode();
    try {
      await startClean(noPolicy);
      noPolicy.enableSeedListener();
      const svc = noPolicy.getSeedBootstrapService();
      const result = await svc!.applySeed(signSeed(ownerPrivateKey, ownerPublicKey));
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/anchored trust policy/i);
    } finally {
      await noPolicy.stop();
    }
  }, 60_000);

  it('enableSeedListener anchors on the node-local store, not the replicated table', async () => {
    // The inbound network path has no per-call policy override, so the listener
    // service must see the node's anchor. An invite pin (trustOwnerKeys) is
    // therefore enough for the secure default to accept, while a key that only
    // reached the replicated OwnerKey table is not.
    const node = makeColdNode(); // secure default, no configured pins
    try {
      await startClean(node);
      node.enableSeedListener();
      const svc = node.getSeedBootstrapService();
      expect(svc).not.toBeNull();

      const db = node.getControlDatabase();
      await db!.insertOwnerKey(attackerPublicKey);
      const forged = await svc!.applySeed(signSeed(attackerPrivateKey, attackerPublicKey));
      expect(forged.success).toBe(false);

      // Anchoring the real owner out-of-band flips the identical service to accept.
      await node.trustOwnerKeys([ownerPublicKey], 'invite');
      const accepted = await svc!.applySeed(signSeed(ownerPrivateKey, ownerPublicKey));
      expect(accepted.success).toBe(true);
    } finally {
      await node.stop();
    }
  }, 60_000);

  it('enableSeedListener is idempotent and retains the policy captured on first construction', async () => {
    const node = makeColdNode(pinnedKeyTrustPolicy([ownerPublicKey]));
    try {
      await startClean(node);
      node.enableSeedListener();
      const first = node.getSeedBootstrapService();
      node.enableSeedListener(); // early-returns; must not drop/replace the service
      const second = node.getSeedBootstrapService();
      expect(second).toBe(first);
      // Policy captured on first construction still applies after the no-op call.
      const result = await second!.applySeed(signSeed(ownerPrivateKey, ownerPublicKey));
      expect(result.success).toBe(true);
    } finally {
      await node.stop();
    }
  }, 60_000);

  it('owner path forwards the policy and a pinned default never narrows anchored trust', async () => {
    // Pin a DIFFERENT key as the configured default; the real owner's key reaches
    // the node's anchor via genesis (initializeSeedBootstrap). pinnedKeyTrustPolicy
    // unions anchored ∪ pinned, so the anchored signer must still apply (the
    // configured default does not narrow trust).
    const node = makeColdNode(pinnedKeyTrustPolicy([attackerPublicKey]));
    try {
      await startClean(node);

      // initializeSeedBootstrap is the owner construction site — exercise that it
      // forwards the configured policy AND genesis-anchors this node's own key.
      node.initializeSeedBootstrap(ownerPrivateKey);
      expect(node.getTrustedOwnerStore()!.has(ownerPublicKey)).toBe(true);

      const result = await node.applySeed(signSeed(ownerPrivateKey, ownerPublicKey));
      expect(result.success).toBe(true);
    } finally {
      await node.stop();
    }
  }, 60_000);

  it('a key present only in the replicated OwnerKey table does not authorize a seed', async () => {
    // The ticket-5 regression: an attacker that can write control state
    // genesis-inserts its own key, which replicates into every peer's OwnerKey
    // table. Seed trust reads the node-local anchor, so that write buys nothing.
    const node = makeColdNode(); // secure default, no pins
    try {
      await startClean(node);
      node.initializeSeedBootstrap(ownerPrivateKey); // anchors the real owner

      const db = node.getControlDatabase();
      expect(db).not.toBeNull();
      await db!.insertOwnerKey(attackerPublicKey);
      expect(await db!.getOwnerKeys()).toContain(attackerPublicKey);

      const rejected = await node.applySeed(signSeed(attackerPrivateKey, attackerPublicKey));
      expect(rejected.success).toBe(false);
      expect(rejected.error).toMatch(/anchored trust policy/i);

      // ...while the anchored owner is unaffected.
      const accepted = await node.applySeed(signSeed(ownerPrivateKey, ownerPublicKey));
      expect(accepted.success).toBe(true);
    } finally {
      await node.stop();
    }
  }, 60_000);

  it('a pin-accepted signer is anchored on the node, so a later seed needs no pin', async () => {
    // Enrollment: the invite's owner key arrives as a per-call pin. After the
    // first seed the node-local anchor holds it, so the secure default (no pin,
    // no configured policy) accepts the next seed from the same owner.
    const node = makeColdNode();
    try {
      await startClean(node);
      const seed = signSeed(ownerPrivateKey, ownerPublicKey);

      expect(node.getTrustedOwnerStore()!.has(ownerPublicKey)).toBe(false);
      const first = await node.applySeed(seed, {
        trustPolicy: pinnedKeyTrustPolicy([ownerPublicKey]),
      });
      expect(first.success).toBe(true);
      expect(node.getTrustedOwnerStore()!.has(ownerPublicKey)).toBe(true);

      const second = await node.applySeed(seed);
      expect(second.success).toBe(true);
    } finally {
      await node.stop();
    }
  }, 60_000);
});

/**
 * The inbound libp2p seed-protocol handler resolves trust to the service-level
 * default (no per-call override exists for a wire-delivered seed). A
 * configured-default rejection must surface as the `SeedAckMessage.reason`, not
 * be swallowed. Driven through the registered handler with a mock libp2p so the
 * full read-apply-ack path is exercised without two real networked nodes.
 */
describe('seed protocol handler — configured-default rejection surfaces in the ack', () => {
  let ownerPrivateKey: string;
  let ownerPublicKey: string;
  let attackerPublicKey: string;
  const seedParty = 'seed-ack-party';

  beforeEach(() => {
    ownerPrivateKey = generatePrivateKey('ed25519', 'base64url') as string;
    ownerPublicKey = getPublicKey(ownerPrivateKey, 'ed25519', 'base64url', 'base64url') as string;
    const attackerPrivateKey = generatePrivateKey('ed25519', 'base64url') as string;
    attackerPublicKey = getPublicKey(attackerPrivateKey, 'ed25519', 'base64url', 'base64url') as string;
  });

  function signSeed(): ControlNetworkSeed {
    const seedData = { partyId: seedParty, peers: [] as SeedPeer[] };
    const seedDigest = digest([canonicalSeedPayload(seedData)], 'sha256', 'base64url') as string;
    const signature = sign(
      seedDigest, ownerPrivateKey, 'ed25519', 'base64url', 'base64url', 'base64url'
    ) as string;
    return { ...seedData, signature, signerKey: ownerPublicKey };
  }

  function frame(obj: unknown): Uint8Array {
    const body = new TextEncoder().encode(JSON.stringify(obj));
    const out = new Uint8Array(4 + body.length);
    new DataView(out.buffer).setUint32(0, body.length, false);
    out.set(body, 4);
    return out;
  }

  it('rejects a network-delivered seed under the configured default and reports the reason', async () => {
    type Handler = (stream: unknown, connection: unknown) => Promise<void>;
    let captured: Handler | undefined;
    const libp2p = {
      handle: (_proto: string, fn: Handler) => { captured = fn; },
      unhandle: async () => {},
      peerStore: { merge: async () => {} },
      dial: async () => {},
    };

    // Configured default pins a DIFFERENT key, so the real owner signer is rejected.
    const service = new SeedBootstrapService({
      partyId: seedParty,
      trustPolicy: pinnedKeyTrustPolicy([attackerPublicKey]),
    });
    service.initialize(
      libp2p as never,
      { getOwnerKeys: async () => new Set<string>() } as never
    );
    expect(captured).toBeDefined();

    const seed = signSeed();
    const message: SeedMessage = {
      partyId: seed.partyId,
      peers: seed.peers,
      signature: seed.signature,
      signerKey: seed.signerKey,
    };

    const sent: Uint8Array[] = [];
    const stream = {
      async *[Symbol.asyncIterator]() { yield frame(message); },
      send: (b: Uint8Array) => { sent.push(b); return true; },
      close: async () => {},
      abort: () => {},
    };
    const connection = { remotePeer: { toString: () => '12D3KooWRemote' } };

    await captured!(stream, connection);

    // The handler sends [4-byte length][ack json]; the ack body is the last frame.
    const ackBody = sent[sent.length - 1];
    const ack = JSON.parse(new TextDecoder().decode(ackBody)) as SeedAckMessage;
    expect(ack.accepted).toBe(false);
    expect(ack.reason).toMatch(/pinned-key trust policy/i);
  });
});
