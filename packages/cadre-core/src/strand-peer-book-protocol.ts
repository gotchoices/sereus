/**
 * The strand peer book SWAP protocol, `/sereus/strand-peers/1.0.0`, on the STRAND
 * libp2p node: when two strand peers connect, each sends the other the signed
 * entries of its strand peer book (`strand-peer-book.ts`) — its own current
 * addresses, self-signed, plus the freshest signed entry it holds for every other
 * peer of the strand — and merges what comes back. That closes the two gaps the
 * node-local book alone leaves: a peer whose relay reservation or address ROTATES is
 * known to the others by its old address only until they happen to reconnect, and in
 * a strand of three or more parties a late joiner holds an address only for the party
 * that invited it. After one swap it holds everyone's.
 *
 * Wire shape, modeled on `strand-addr-protocol.ts`: 4-byte big-endian length-prefixed
 * JSON frames over one stream, one request → one response, the shared
 * `control-stream.ts` primitives, a read timeout and a concurrency cap on the
 * receiver, and a {@link MAX_BOOK_FRAME_SIZE} cap on what either side buffers.
 * Request and response are the same {@link StrandPeerBookFrame}. Only SIGNED entries
 * ever travel: an entry this node observed or a formation carried is its own
 * observation, not the peer's statement, and is never forwarded.
 *
 * ── Whose signature ──
 *
 * Each entry is signed by the named peer's own STRAND TRANSPORT key
 * (`strand-transport-key.ts`, the key its strand libp2p node runs under), over the
 * canonical JSON of `{ v: 1, strandId, peerId, addrs, issuedAt }`. Verification needs
 * no key exchange: an Ed25519 libp2p peer id embeds its public key, so any receiver
 * checks that the entry for peer X was signed by X. NOT the strand member key, for
 * four reasons:
 *
 * 1. Open strands have no shared member key at all, and the book has to work there.
 * 2. A member-key signature proves only "some member said this", so any member could
 *    forge another member's address and cost every peer a 16 s relayed dial per
 *    launch; a self-signature is a claim only the named peer can make.
 * 3. On a closed strand the member key is shared by every machine of a party, so it
 *    cannot identify a machine anyway.
 * 4. Membership is a separate question, judged at the connection by the revocation
 *    gate today (`strand-revocation-enforcer.ts`) and by the allowlist later
 *    (`feat-strand-member-allowlist-admission`); this protocol rides that gate
 *    (`node.handle` → `authorizeInboundStream` on a closed strand).
 *
 * **The book therefore proves "this peer's own claim about where it is", never "this
 * peer is a member of the strand".** An address grants no authority (the dialed peer
 * authenticates by peer id at the handshake), so the worst a forged or stale entry
 * costs is a failed dial, and a self-signature is exactly what bounds who can impose
 * that cost on whom.
 *
 * ── Clocks ──
 *
 * `issuedAt` is the signer's clock. It is compared only between entries from the
 * SAME signer (the store's merge rule), so skew between machines is harmless — except
 * that a far-future stamp would pin an entry forever, hence the
 * {@link STRAND_PEER_ISSUED_AT_SKEW_MS} ceiling (reject and log). The store ages an
 * entry from `max(issuedAt, lastSeenAt)`, so a signer far in the past ages out fast,
 * which is the right failure for a machine with a broken clock.
 */
import debug from 'debug';
import type { Connection, Libp2p, PrivateKey } from '@libp2p/interface';
import { peerIdFromString } from '@libp2p/peer-id';
import { toString as uint8ArrayToString, fromString as uint8ArrayFromString } from 'uint8arrays';
import { canonicalJson } from './canonical-json.js';
import { type ControlStream, exchangeFrame, readStreamToEnd, withDeadline, writeFrame } from './control-stream.js';
import { decodeLengthPrefixedFrame } from './seed-bootstrap.js';
import { groupAddrsByPeerId } from './peer-addr-book.js';
import { MAX_STRAND_ADDRS } from './strand-formation-protocol.js';
import { MAX_STRAND_PEERS } from './strand-peer-book.js';

const log = debug('sereus:cadre:strand-peer-book-protocol');

/** Protocol id of the strand peer book swap, registered on every running strand node. */
export const STRAND_PEER_BOOK_PROTOCOL = '/sereus/strand-peers/1.0.0';

/** Version tag inside every signed payload, so a later payload shape cannot verify as this one. */
export const SIGNED_STRAND_PEER_ENTRY_VERSION = 1;

/**
 * How far ahead of the receiver's clock a signed entry's `issuedAt` may be. Skew
 * between honest machines is seconds; a stamp further ahead than this is a broken
 * clock or an attempt to pin an entry, and is rejected rather than held.
 */
export const STRAND_PEER_ISSUED_AT_SKEW_MS = 5 * 60 * 1000;

/**
 * Cap on one frame's bytes. A typical full frame — {@link MAX_STRAND_PEERS} entries of
 * {@link MAX_STRAND_ADDRS} addresses at roughly 150 bytes each, plus a peer id and
 * signature per entry — is about 40 KiB, but nothing bounds a multiaddr's length (a
 * long DNS name can take one past 300 bytes), so a sender trims its forwarded
 * entries to fit ({@link trimBookFrameToFit}) rather than trusting the arithmetic;
 * {@link assertBookFrameFits} is then the invariant check.
 */
export const MAX_BOOK_FRAME_SIZE = 64 * 1024;

/** Default cap on concurrent inbound swap streams a single strand node serves. */
const DEFAULT_MAX_CONCURRENT = 100;

/**
 * One peer's own signed statement of where it is: a `StrandPeerEntry` without the
 * receiver-local `lastSeenAt`. `addrs` may be empty — a peer that lost its relay
 * reservation truthfully says "not reachable now", and that displaces a stale
 * reachable list at every receiver.
 */
export interface SignedStrandPeerEntry {
	/** The signer's strand transport peer id (Ed25519, so it embeds the verifying key). */
	peerId: string;
	/** Bound to `peerId`, signaling-first, at most `MAX_STRAND_ADDRS`. */
	addrs: string[];
	/** Signer's clock, ms. Greater wins between two statements by the same signer. */
	issuedAt: number;
	/** base64url Ed25519 signature over {@link signedStrandPeerEntryPayload}. */
	sig: string;
}

/** Request and response of the swap: the sender's signed book for one strand. */
export interface StrandPeerBookFrame {
	/** Must name the strand whose network the frame arrived on; anything else is refused. */
	strandId: string;
	/** At most {@link MAX_STRAND_PEERS}. */
	entries: SignedStrandPeerEntry[];
}

/** The bytes a signed entry's signature covers. */
export function signedStrandPeerEntryPayload(
	strandId: string,
	entry: Pick<SignedStrandPeerEntry, 'peerId' | 'addrs' | 'issuedAt'>
): Uint8Array {
	return new TextEncoder().encode(canonicalJson({
		v: SIGNED_STRAND_PEER_ENTRY_VERSION,
		strandId,
		peerId: entry.peerId,
		addrs: entry.addrs,
		issuedAt: entry.issuedAt
	}));
}

/**
 * Sign this node's own entry with its strand transport key. `addrs` must already be
 * bound to the key's peer id (`dialableAddrs` in `strand-peer-observer.ts` does that);
 * a receiver rejects an entry whose addresses do not all attribute to the signer.
 */
export async function signStrandPeerEntry(
	privateKey: PrivateKey,
	strandId: string,
	addrs: string[],
	issuedAt: number
): Promise<SignedStrandPeerEntry> {
	if (privateKey.type !== 'Ed25519') {
		throw new Error(`signStrandPeerEntry requires an Ed25519 key, got ${privateKey.type}`);
	}
	const peerId = privateKey.publicKey.toString();
	const entry = { peerId, addrs: [...addrs], issuedAt };
	const sig = await privateKey.sign(signedStrandPeerEntryPayload(strandId, entry));
	return { ...entry, sig: uint8ArrayToString(sig, 'base64url') };
}

/** Why a received entry was dropped — for logs and for the verification test. */
export type StrandPeerEntryVerdict =
	| { ok: true; entry: SignedStrandPeerEntry }
	| { ok: false; reason: string };

/**
 * Verify one received entry: well-formed, an Ed25519 peer id, every address bound to
 * that peer id, `issuedAt` not further ahead of `now` than the skew ceiling, and a
 * valid self-signature. Never throws: junk from a peer is a verdict, not an error.
 */
export async function verifySignedStrandPeerEntry(
	strandId: string,
	raw: unknown,
	now: number
): Promise<StrandPeerEntryVerdict> {
	const shaped = shapeEntry(raw);
	if (typeof shaped === 'string') {
		return { ok: false, reason: shaped };
	}
	let publicKey;
	try {
		const peerId = peerIdFromString(shaped.peerId);
		if (peerId.type !== 'Ed25519') {
			return { ok: false, reason: `peer id ${shaped.peerId} is ${peerId.type}, not Ed25519` };
		}
		publicKey = peerId.publicKey;
	} catch (error) {
		return { ok: false, reason: `peer id ${shaped.peerId} does not parse: ${(error as Error).message}` };
	}
	const attributed = groupAddrsByPeerId([...shaped.addrs]).get(shaped.peerId)?.length ?? 0;
	if (attributed !== shaped.addrs.length) {
		return { ok: false, reason: `${shaped.addrs.length - attributed} addr(s) do not attribute to ${shaped.peerId}` };
	}
	if (shaped.issuedAt > now + STRAND_PEER_ISSUED_AT_SKEW_MS) {
		return { ok: false, reason: `issuedAt ${shaped.issuedAt} is more than ${STRAND_PEER_ISSUED_AT_SKEW_MS} ms ahead of now` };
	}
	try {
		const sig = uint8ArrayFromString(shaped.sig, 'base64url');
		if (!(await publicKey.verify(signedStrandPeerEntryPayload(strandId, shaped), sig))) {
			return { ok: false, reason: `signature does not verify for ${shaped.peerId}` };
		}
	} catch (error) {
		return { ok: false, reason: `signature unusable for ${shaped.peerId}: ${(error as Error).message}` };
	}
	return { ok: true, entry: shaped };
}

/** Structural check of untrusted JSON: the fields, their types, the address cap. */
function shapeEntry(raw: unknown): SignedStrandPeerEntry | string {
	if (typeof raw !== 'object' || raw === null) return 'entry is not an object';
	const { peerId, addrs, issuedAt, sig } = raw as Record<string, unknown>;
	if (typeof peerId !== 'string' || peerId.length === 0) return 'peerId is not a string';
	if (!Array.isArray(addrs) || addrs.some((addr) => typeof addr !== 'string' || addr.length === 0)) {
		return `addrs of ${peerId} is not a list of strings`;
	}
	if (addrs.length > MAX_STRAND_ADDRS) return `${peerId} lists ${addrs.length} addrs, over the cap of ${MAX_STRAND_ADDRS}`;
	if (!Number.isSafeInteger(issuedAt) || (issuedAt as number) < 0) return `issuedAt of ${peerId} is not a timestamp`;
	if (typeof sig !== 'string' || sig.length === 0) return `sig of ${peerId} is not a string`;
	// A duplicate address is not a protocol error, but the store de-duplicates and the
	// attribution count above compares lengths, so collapse it here.
	return { peerId, addrs: [...new Set(addrs as string[])], issuedAt: issuedAt as number, sig };
}

/**
 * Verify a whole received frame. A frame-level violation — the wrong strand, entries
 * not a list, more entries than {@link MAX_STRAND_PEERS} — throws, and the caller
 * refuses the frame. An entry that fails {@link verifySignedStrandPeerEntry} is
 * dropped INDIVIDUALLY with a debug line; its siblings are kept. An entry naming
 * `selfPeerId` is dropped too: this node's own statement is authoritative locally
 * and a remote copy of it is at best redundant. One entry per peer id (the first).
 */
export async function verifyStrandPeerBookFrame(
	strandId: string,
	raw: unknown,
	selfPeerId: string,
	now: number
): Promise<SignedStrandPeerEntry[]> {
	if (typeof raw !== 'object' || raw === null) {
		throw new Error('strand peer book frame is not an object');
	}
	const { strandId: named, entries } = raw as Record<string, unknown>;
	if (named !== strandId) {
		throw new Error(`strand peer book frame names strand ${String(named)}, expected ${strandId}`);
	}
	if (!Array.isArray(entries)) {
		throw new Error('strand peer book frame entries is not a list');
	}
	if (entries.length > MAX_STRAND_PEERS) {
		throw new Error(`strand peer book frame carries ${entries.length} entries, over the cap of ${MAX_STRAND_PEERS}`);
	}
	const verified = new Map<string, SignedStrandPeerEntry>();
	for (const candidate of entries) {
		const verdict = await verifySignedStrandPeerEntry(strandId, candidate, now);
		if (!verdict.ok) {
			log('strand %s: dropping received entry: %s', strandId, verdict.reason);
			continue;
		}
		if (verdict.entry.peerId === selfPeerId || verified.has(verdict.entry.peerId)) {
			continue;
		}
		verified.set(verdict.entry.peerId, verdict.entry);
	}
	return [...verified.values()];
}

/** The encoded size of a frame, as {@link writeFrame} would send it (the 4-byte prefix aside). */
function encodedFrameBytes(frame: StrandPeerBookFrame): number {
	return new TextEncoder().encode(JSON.stringify(frame)).length;
}

/**
 * The frame with its LAST entries dropped until it encodes within
 * {@link MAX_BOOK_FRAME_SIZE} and {@link MAX_STRAND_PEERS}. Callers list the entries
 * in the order they would rather keep them (the own entry first, then freshest
 * first), so what goes is the stalest forwarded statement, and a frame that fits is
 * returned as is. Dropping an entry is logged: a forwarded peer the recipient never
 * learns of is worth seeing in a trace.
 */
export function trimBookFrameToFit(frame: StrandPeerBookFrame): StrandPeerBookFrame {
	let entries = frame.entries.slice(0, MAX_STRAND_PEERS);
	while (entries.length > 0 && encodedFrameBytes({ strandId: frame.strandId, entries }) > MAX_BOOK_FRAME_SIZE) {
		entries = entries.slice(0, -1);
	}
	if (entries.length === frame.entries.length) return frame;
	log('strand %s: frame trimmed from %d to %d entr(ies) to fit the caps', frame.strandId, frame.entries.length, entries.length);
	return { strandId: frame.strandId, entries };
}

/**
 * Refuse to send a frame the receiver would reject: over the entry cap, or over
 * {@link MAX_BOOK_FRAME_SIZE} once encoded. A caller that built its frame through
 * {@link trimBookFrameToFit} cannot trip this; it is the invariant check, not a
 * runtime condition to handle.
 */
export function assertBookFrameFits(frame: StrandPeerBookFrame): void {
	if (frame.entries.length > MAX_STRAND_PEERS) {
		throw new Error(`strand peer book frame carries ${frame.entries.length} entries, over the cap of ${MAX_STRAND_PEERS}`);
	}
	const bytes = encodedFrameBytes(frame);
	if (bytes > MAX_BOOK_FRAME_SIZE) {
		throw new Error(`strand peer book frame is ${bytes} bytes, over the cap of ${MAX_BOOK_FRAME_SIZE}`);
	}
}

/** Read a stream to EOF and decode its single frame, bounded by `timeoutMs` and the size cap. */
async function readBookFrame(stream: ControlStream, timeoutMs: number): Promise<unknown> {
	const data = await readStreamToEnd(stream, { maxBytes: MAX_BOOK_FRAME_SIZE, timeoutMs, label: 'Strand peer book' });
	return JSON.parse(new TextDecoder().decode(decodeLengthPrefixedFrame(data, MAX_BOOK_FRAME_SIZE)));
}

/** What the {@link StrandPeerBookService} receiver needs from its host, injected so it is testable without a node. */
export interface StrandPeerBookServiceDeps {
	strandId: string;
	/** This strand node's own peer id: a received entry naming it is never merged. */
	selfPeerId: string;
	/**
	 * The entries to answer `forPeerId` with — this node's own signed entry plus every
	 * signed entry it holds, minus `forPeerId`'s own (the asker knows where it is).
	 */
	localEntries(forPeerId: string): SignedStrandPeerEntry[];
	/** The asker's VERIFIED entries, for the host to merge. Must not throw. */
	onEntries(entries: SignedStrandPeerEntry[], fromPeerId: string): void;
	/** Clock, for tests. Default `Date.now`. */
	now?: () => number;
	/**
	 * How long the receiver waits for the inbound request frame (ms). Required for the same
	 * reason as {@link ExchangeStrandPeerBookOptions.timeoutMs}: the swap gives both sides one
	 * link-derived deadline.
	 */
	readTimeoutMs: number;
	/** Default {@link DEFAULT_MAX_CONCURRENT}. Over it, an empty frame is returned unread. */
	maxConcurrent?: number;
}

/**
 * Receiver side: registers the protocol on a strand node and, per inbound frame,
 * verifies and hands over the asker's entries, then answers with the local book.
 * Registered through `node.handle`, so on a closed strand every inbound stream
 * passes the revocation gate first — a revoked machine cannot push addresses into
 * anyone's book.
 */
export class StrandPeerBookService {
	private readonly readTimeoutMs: number;
	private readonly maxConcurrent: number;
	private readonly now: () => number;
	private node: Libp2p | null = null;
	private activeStreams = 0;

	constructor(private readonly deps: StrandPeerBookServiceDeps) {
		this.readTimeoutMs = deps.readTimeoutMs;
		this.maxConcurrent = deps.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
		this.now = deps.now ?? Date.now;
	}

	/** In-flight inbound streams. */
	get activeCount(): number {
		return this.activeStreams;
	}

	/** Register the handler. Resolves once libp2p has recorded the protocol on the self record. */
	async initialize(node: Libp2p): Promise<void> {
		this.node = node;
		// `runOnLimitedConnection: true`: strand peers reach each other over relayed
		// (limited) connections as a matter of course, and this is one small frame each way.
		await node.handle(STRAND_PEER_BOOK_PROTOCOL, (rawStream: unknown, rawConnection: unknown) => {
			const remotePeerId = (rawConnection as Connection).remotePeer.toString();
			void this.handleStream(rawStream as ControlStream, remotePeerId);
		}, { runOnLimitedConnection: true });
		log('[%s] registered %s', this.deps.strandId, STRAND_PEER_BOOK_PROTOCOL);
	}

	/** Unregister the handler and release the node reference. */
	async shutdown(): Promise<void> {
		if (this.node) {
			await this.node.unhandle(STRAND_PEER_BOOK_PROTOCOL);
			this.node = null;
		}
	}

	/**
	 * Read the request, merge what verifies, answer with the local book. Every failure
	 * (cap, malformed or oversized frame, wrong strand, read timeout) answers an empty
	 * frame rather than hanging or dropping the stream, so the asker's exchange settles.
	 *
	 * NOTE: the concurrency cap bounds streams in flight, not frames per peer per unit
	 * time — the ten-minute throttle is the CLIENT's, so a connected peer can push a
	 * verified frame, and the persist it costs, as fast as it likes; see
	 * `backlog/debt-strand-peer-book-remote-write-bounds`.
	 */
	private async handleStream(stream: ControlStream, remotePeerId: string): Promise<void> {
		if (this.activeStreams >= this.maxConcurrent) {
			log('[%s] refusing swap from %s: %d streams at the cap', this.deps.strandId, remotePeerId, this.activeStreams);
			this.reply(stream, []);
			await closeQuietly(stream);
			return;
		}
		this.activeStreams++;
		try {
			const raw = await readBookFrame(stream, this.readTimeoutMs);
			const entries = await verifyStrandPeerBookFrame(this.deps.strandId, raw, this.deps.selfPeerId, this.now());
			log('[%s] swap from %s: %d verified entr(ies) received', this.deps.strandId, remotePeerId, entries.length);
			this.deps.onEntries(entries, remotePeerId);
			this.reply(stream, this.deps.localEntries(remotePeerId));
		} catch (error) {
			log('[%s] swap from %s failed: %o', this.deps.strandId, remotePeerId, error);
			this.reply(stream, []);
		} finally {
			this.activeStreams--;
			await closeQuietly(stream);
		}
	}

	private reply(stream: ControlStream, entries: SignedStrandPeerEntry[]): void {
		try {
			const frame: StrandPeerBookFrame = { strandId: this.deps.strandId, entries };
			assertBookFrameFits(frame);
			writeFrame(stream, frame);
		} catch (error) {
			log('[%s] swap reply failed: %o', this.deps.strandId, error);
		}
	}
}

async function closeQuietly(stream: ControlStream): Promise<void> {
	try {
		await stream.close();
	} catch (error) {
		log('stream close failed (ignored): %o', error);
	}
}

/** Options for {@link exchangeStrandPeerBook}. */
export interface ExchangeStrandPeerBookOptions {
	/** This strand node's own peer id: a returned entry naming it is dropped. */
	selfPeerId: string;
	/**
	 * Whole-exchange deadline (ms). Required, with no fallback here: the exchange crosses the
	 * link, so its deadline derives from the declared link round trip (`link-budget.ts`), and
	 * the caller is the one that knows the declaration. A default in this module would be a
	 * second number free to drift from that derivation.
	 */
	timeoutMs: number;
	/** Clock, for tests. Default `Date.now`. */
	now?: () => number;
}

/**
 * Client side: open one stream on `connection` — the live connection to the peer,
 * relayed or not — send `request`, and return the peer's VERIFIED entries. Throws on
 * any failure (the peer does not speak the protocol, a deadline, a refused frame);
 * the caller logs and moves on, never retrying before its throttle expires.
 */
export async function exchangeStrandPeerBook(
	connection: Connection,
	request: StrandPeerBookFrame,
	options: ExchangeStrandPeerBookOptions
): Promise<SignedStrandPeerEntry[]> {
	const { timeoutMs } = options;
	const remotePeerId = connection.remotePeer.toString();
	assertBookFrameFits(request);
	// One deadline for the stream open and the exchange together: its signal aborts the
	// negotiation and resets a live stream, so neither leaks on a timeout.
	const raw = await withDeadline(timeoutMs, `Strand peer book swap with ${remotePeerId}`, async (signal) => {
		const stream = await connection.newStream(STRAND_PEER_BOOK_PROTOCOL, { runOnLimitedConnection: true, signal });
		return exchangeFrame(
			stream as unknown as ControlStream,
			signal,
			request,
			(s) => readBookFrame(s, timeoutMs),
			'Strand peer book swap aborted by timeout'
		);
	});
	return verifyStrandPeerBookFrame(request.strandId, raw, options.selfPeerId, (options.now ?? Date.now)());
}
