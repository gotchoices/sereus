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
 * Three implementations:
 *  - {@link MemoryTrustedOwnerStore} (this module, cross-platform) — ephemeral;
 *    the default when no store is injected via `CadreNodeConfig.trustedOwners`.
 *  - {@link PersistentTrustedOwnerStore} (this module, cross-platform) — durable
 *    over any `DurableSlot` the embedding app supplies (IndexedDB, SecureStore,
 *    SQLite, …). The load/persist policy lives in `node-local-snapshot.ts`; read
 *    {@link NodeLocalSnapshot.open} for what an absent, corrupt, foreign-party
 *    or unreadable slot does.
 *  - `FileTrustedOwnerStore` — the above over a Node file in the node's state
 *    directory; Node-only, behind the subpath
 *    `@serfab/cadre-core/trusted-owner-store-file` (same isolation pattern as
 *    `key-store-file`) so `node:fs` never lands in the RN/browser entry graph.
 *
 * Keys are additive: nothing in this interface removes a key (owner revocation
 * is out of scope here and tracked with the broader control-sync design).
 */
import debug from 'debug';
import { NodeLocalSnapshot, type DurableSlot, type NodeLocalSnapshotSpec } from './node-local-snapshot.js';

const log = debug('sereus:cadre:trusted-owner-store');

/** How an owner key entered the anchor (out-of-band provenance). */
export type TrustSource = 'genesis' | 'invite' | 'operator';

export interface TrustedOwnerStore {
	/** Party this anchor is scoped to. */
	readonly partyId: string;

	/** Is this ed25519 (base64url) key one of my party's out-of-band-trusted owners? */
	has(ownerKey: string): boolean;

	/**
	 * All anchored owner keys (e.g. for seed-trust `knownOwnerKeys`).
	 *
	 * NOTE: both backends copy into a fresh Set per call (so the result is a
	 * snapshot decoupled from later `trust()` calls). Anchors hold a handful of
	 * keys and callers are per-seed, so the copy is free today; if a hot path
	 * ever calls this per message, prefer `has()` or cache the snapshot.
	 */
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

/** One anchored key as persisted: provenance + wall-clock trust time (ms). */
interface TrustedOwnerEntry {
	source: TrustSource;
	trustedAt: number;
}

const KNOWN_SOURCES: ReadonlySet<string> = new Set<TrustSource>(['genesis', 'invite', 'operator']);

/**
 * What the anchor persists: `owners` maps ownerKey (base64url) -> provenance.
 *
 * One unusable entry discards the WHOLE record: trusting a subset of the keys a
 * record claims is a silent, security-relevant downgrade, so a record that
 * cannot be read in full is treated as no anchor at all (see
 * `UnusableEntryPolicy` in `node-local-snapshot.ts`).
 */
const TRUSTED_OWNER_SNAPSHOT: NodeLocalSnapshotSpec<TrustedOwnerEntry> = {
	label: 'trusted-owner anchor',
	payloadKey: 'owners',
	unusableEntry: 'discard-all',
	acceptEntry: (_ownerKey, entry) => {
		if (typeof entry !== 'object' || entry === null) return undefined;
		const { source, trustedAt } = entry as { source?: unknown; trustedAt?: unknown };
		if (typeof source !== 'string' || !KNOWN_SOURCES.has(source)) return undefined;
		if (typeof trustedAt !== 'number') return undefined;
		return { source: source as TrustSource, trustedAt };
	}
};

/**
 * Durable {@link TrustedOwnerStore} over an app-supplied {@link DurableSlot} —
 * the cross-platform half of every persistent backend (the Node
 * `FileTrustedOwnerStore` is this class over a file slot).
 *
 * Construct via {@link open}. Load and persist policy — what an absent,
 * corrupt, foreign-party or unreadable slot does, and what a failed persist
 * does — is documented once on `NodeLocalSnapshot`; this class only supplies
 * the payload shape and the anchor's whole-record-on-bad-entry policy.
 */
export class PersistentTrustedOwnerStore implements TrustedOwnerStore {
	private constructor(private readonly snapshot: NodeLocalSnapshot<TrustedOwnerEntry>) {}

	/** Load (or cold-start) the party's anchor from `slot`. */
	static async open(slot: DurableSlot, partyId: string): Promise<PersistentTrustedOwnerStore> {
		return new PersistentTrustedOwnerStore(
			await NodeLocalSnapshot.open(slot, partyId, TRUSTED_OWNER_SNAPSHOT)
		);
	}

	get partyId(): string {
		return this.snapshot.partyId;
	}

	has(ownerKey: string): boolean {
		return this.snapshot.has(ownerKey);
	}

	all(): ReadonlySet<string> {
		return this.snapshot.keySnapshot();
	}

	/**
	 * Anchor a key: visible via {@link has} / {@link all} synchronously, then the
	 * full snapshot is persisted (see `NodeLocalSnapshot.put`).
	 */
	trust(ownerKey: string, source: TrustSource): Promise<void> {
		if (this.snapshot.has(ownerKey)) {
			// Idempotent: re-enrollment / restart re-seeding keeps the original
			// provenance and skips the write entirely.
			// NOTE: this resolves immediately rather than joining the write chain, so
			// re-trusting a key whose first persist is still in flight does not await
			// that persist. Harmless for the seeding callers (they re-trust only after
			// the original settled, or do not await at all); chain it if a caller ever
			// needs "durable by the time trust() resolves" for a repeat key.
			return Promise.resolve();
		}
		log('trusted owner key anchored (party=%s, source=%s); persisting', this.partyId, source);
		return this.snapshot.put(ownerKey, { source, trustedAt: Date.now() });
	}
}
