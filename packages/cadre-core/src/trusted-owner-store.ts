/**
 * Node-local, NON-replicated trusted-owner anchor.
 *
 * The replicated `CadreControl.OwnerKey` table cannot anchor trust: any
 * connecting node can genesis-insert its own key into its local table and that
 * row replicates into every peer's copy, so "is this key in `OwnerKey`?" can be
 * made true by a stranger. This store is the anchor that CAN be trusted — a
 * per-party, on-device record of owner keys established OUT OF BAND: founding
 * the party (genesis self-trust), the pinned keys carried by the `CadreInvite`
 * that enrolled this node, or an explicit operator pin. It is never written
 * from replicated control state; that is the whole point.
 *
 * Two implementations:
 *  - {@link MemoryTrustedOwnerStore} (this module, cross-platform) — ephemeral;
 *    the default when no store is injected via `CadreNodeConfig.trustedOwners`.
 *  - `FileTrustedOwnerStore` — persisted JSON next to the identity key; Node-only,
 *    behind the subpath `@serfab/cadre-core/trusted-owner-store-file` (same
 *    isolation pattern as `key-store-file`) so `node:fs` never lands in the
 *    RN/browser entry graph.
 *
 * Keys are additive: nothing in this interface removes a key (owner revocation
 * is out of scope here and tracked with the broader control-sync design).
 */
import debug from 'debug';

const log = debug('sereus:cadre:trusted-owner-store');

/** How an owner key entered the anchor (out-of-band provenance). */
export type TrustSource = 'genesis' | 'invite' | 'operator';

export interface TrustedOwnerStore {
	/** Party this anchor is scoped to. */
	readonly partyId: string;

	/** Is this ed25519 (base64url) key one of my party's out-of-band-trusted owners? */
	has(ownerKey: string): boolean;

	/** All anchored owner keys (e.g. for seed-trust `knownOwnerKeys`). */
	all(): ReadonlySet<string>;

	/**
	 * Add a key established out of band (genesis self-trust / invite pin /
	 * operator pin). Idempotent: re-trusting a known key is a no-op that keeps
	 * the original source. Implementations MUST reflect the key in {@link has} /
	 * {@link all} synchronously; the returned promise tracks durability only
	 * (a file-backed persist), so a synchronous caller may safely consult the
	 * store right after invoking this.
	 */
	trust(ownerKey: string, source: TrustSource): Promise<void>;
}

/**
 * Ephemeral in-memory anchor for nodes without durable storage (tests, browser
 * demos, not-yet-persisted mobile). Same contract, no disk: trust established
 * here must be re-supplied (invite / operator pin) on the next process.
 */
export class MemoryTrustedOwnerStore implements TrustedOwnerStore {
	private readonly keys = new Map<string, TrustSource>();

	constructor(readonly partyId: string) {}

	has(ownerKey: string): boolean {
		return this.keys.has(ownerKey);
	}

	all(): ReadonlySet<string> {
		return new Set(this.keys.keys());
	}

	async trust(ownerKey: string, source: TrustSource): Promise<void> {
		if (this.keys.has(ownerKey)) {
			return;
		}
		this.keys.set(ownerKey, source);
		log('trusted owner key anchored (party=%s, source=%s)', this.partyId, source);
	}
}
