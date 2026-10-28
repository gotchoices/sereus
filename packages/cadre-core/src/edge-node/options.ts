/**
 * What one edge-node start is made with, and the record that remembers it between launches.
 *
 * The record is one per app, not party-scoped: it is what *selects* the party, so every other
 * node-local record is read through the `partyId` it carries. `EdgeNode.start` writes it after
 * every successful start and `joinCadre` once a member admitted the app (`autoStart: true`),
 * `stop` rewrites it with `autoStart: false`, and a removal from the party replaces it
 * ({@link startAfterRemoval}); an app's launch and a push wake into a killed process read it to
 * start the node unattended.
 */

import type { StrandOfflineMode } from '../strand-offline.js';

/**
 * How much of Noise's crypto the platform replaces (`EdgeNodePlatform.noiseCrypto`): none, the
 * per-frame hash and cipher, or those and the handshake's key exchange too. Named here, apart from
 * any implementation, so a stored mode can be validated without loading a native module; the
 * React Native kit's `/noise-crypto` builds the implementation for each.
 */
export type NoiseCryptoMode = 'off' | 'symmetric' | 'full';

export interface EdgeNodeOptions {
	/** Party ID — identifies this cadre. The app mints one on first run. */
	partyId: string;
	/** Bootstrap multiaddrs (the party's always-on machines). */
	bootstrapAddrs: string[];
	/**
	 * Circuit-relay multiaddrs this node reserves a slot on. An edge device accepts no inbound
	 * connection, so a relay reservation is the only address anyone can dial it at. Empty is
	 * allowed: the node starts and dials out, but cannot be invited to or joined.
	 */
	relayAddrs: string[];
	/** How much of Noise's crypto the platform replaces; read only when the node is built. */
	noiseCryptoMode?: NoiseCryptoMode;
	/**
	 * How this app came to `partyId`. A `'founded'` party runs owner genesis on every start; a
	 * `'joined'` one never does, because genesis on a party whose control store has not arrived
	 * would seat this app as a second founder. Absent means `'founded'`.
	 */
	origin?: EdgeNodeOrigin;
	/**
	 * The name the founding owner key gets on its `OwnerKey` row when this start founds the party
	 * ("phone", "Ann's iPhone"). Read only by genesis; default `'phone'`. Trimmed, at most 64
	 * characters (`OWNER_KEY_MAX_LABEL`); a longer one fails the start.
	 */
	ownerKeyLabel?: string;
	/**
	 * The party this app founded and left by joining another (`EdgeNode.joinCadre`). Its data
	 * stays on disk under its own names, for moving its strands and dissolving the old cadre.
	 */
	formerPartyId?: string;
	/**
	 * The offline mode every strand starts in (`CadreNodeConfig.strandOffline.initialMode`); default
	 * `'online'`. Read only on a platform with an offline journal (`EdgeNodeStorage.offlineJournal`).
	 * `CadreNode.setStrandOfflineMode` changes one strand's mode until the process exits.
	 */
	strandOfflineMode?: StrandOfflineMode;
}

/** Whether this app founded its party, or joined it by invitation. */
export type EdgeNodeOrigin = 'founded' | 'joined';

/** The last start, as `EdgeNode.loadSavedStart` reports it. */
export interface SavedStart {
	/** Exactly what the node was last successfully started with. */
	options: EdgeNodeOptions;
	/** True after a successful start, false after `stop`. Gates every unattended start. */
	autoStart: boolean;
	/**
	 * The `EdgeNodePlatform.dataVersion` of the build that last started over this device's data,
	 * or `undefined` when that build named none. The app compares it with its own to decide whether
	 * the stored data is usable.
	 */
	writtenBy?: string;
}

/**
 * The saved start once an owner of its party removed this app: the party this app founded and
 * left (`formerPartyId`), which it may go back to, not started unattended; `undefined` when it
 * left none. No bootstrap addresses: the former party's machines are in its own bootstrap-peer
 * store, which every start reads.
 */
export function startAfterRemoval(saved: SavedStart): SavedStart | undefined {
	const { partyId, formerPartyId, relayAddrs, noiseCryptoMode, strandOfflineMode } = saved.options;
	if (formerPartyId === undefined || formerPartyId === partyId) return undefined;
	const options: EdgeNodeOptions = { partyId: formerPartyId, bootstrapAddrs: [], relayAddrs, origin: 'founded' };
	if (noiseCryptoMode !== undefined) options.noiseCryptoMode = noiseCryptoMode;
	if (strandOfflineMode !== undefined) options.strandOfflineMode = strandOfflineMode;
	return { options, autoStart: false, ...(saved.writtenBy !== undefined && { writtenBy: saved.writtenBy }) };
}

/** Every Noise crypto mode, so a stored mode can be validated without loading the native module. */
export const NOISE_CRYPTO_MODES: readonly NoiseCryptoMode[] = ['symmetric', 'full', 'off'];

export function isNoiseCryptoMode(value: unknown): value is NoiseCryptoMode {
	return (NOISE_CRYPTO_MODES as readonly unknown[]).includes(value);
}

const RECORD_VERSION = 1;

/** The stored shape. Flat, so a record read by hand is legible. */
interface StartRecord {
	version: typeof RECORD_VERSION;
	partyId: string;
	bootstrapAddrs: string[];
	relayAddrs: string[];
	noiseCryptoMode?: NoiseCryptoMode;
	origin?: EdgeNodeOrigin;
	formerPartyId?: string;
	ownerKeyLabel?: string;
	strandOfflineMode?: StrandOfflineMode;
	autoStart: boolean;
	writtenBy?: string;
}

export function serializeSavedStart(saved: SavedStart): string {
	const { partyId, bootstrapAddrs, relayAddrs, noiseCryptoMode, origin, formerPartyId, ownerKeyLabel, strandOfflineMode } = saved.options;
	const record: StartRecord = {
		version: RECORD_VERSION,
		partyId,
		bootstrapAddrs,
		relayAddrs,
		noiseCryptoMode,
		origin,
		formerPartyId,
		ownerKeyLabel,
		strandOfflineMode,
		autoStart: saved.autoStart,
		writtenBy: saved.writtenBy,
	};
	return JSON.stringify(record);
}

/**
 * The saved record, or `undefined` when there is none or it is unusable (logged).
 *
 * Only the party id is worth discarding a record over. A malformed optional field falls back to
 * its default — `[]` for an address list, the build default for the Noise mode, absent for
 * `origin`, `formerPartyId`, `ownerKeyLabel` and `strandOfflineMode` (which is `'online'`), `false`
 * for `autoStart` — so a damaged record still keeps the app in its party, at worst needing the
 * user to start the node by hand.
 */
export function parseSavedStart(text: string | undefined): SavedStart | undefined {
	if (text === undefined) return undefined;
	const record = parseRecord(text);
	if (!record) return undefined;
	const { partyId } = record;
	if (typeof partyId !== 'string' || partyId.trim().length === 0) {
		console.warn('[cadre-core/edge-node] ignoring saved start options with no party id');
		return undefined;
	}
	const options: EdgeNodeOptions = {
		partyId,
		bootstrapAddrs: stringArrayOrEmpty(record.bootstrapAddrs),
		relayAddrs: stringArrayOrEmpty(record.relayAddrs),
	};
	if (isNoiseCryptoMode(record.noiseCryptoMode)) options.noiseCryptoMode = record.noiseCryptoMode;
	if (record.origin === 'founded' || record.origin === 'joined') options.origin = record.origin;
	if (typeof record.formerPartyId === 'string' && record.formerPartyId.trim().length > 0) {
		options.formerPartyId = record.formerPartyId;
	}
	if (typeof record.ownerKeyLabel === 'string') options.ownerKeyLabel = record.ownerKeyLabel;
	if (record.strandOfflineMode === 'online' || record.strandOfflineMode === 'offline') {
		options.strandOfflineMode = record.strandOfflineMode;
	}
	const saved: SavedStart = { options, autoStart: record.autoStart === true };
	if (typeof record.writtenBy === 'string') saved.writtenBy = record.writtenBy;
	return saved;
}

/** The record's fields, or `undefined` (logged) when the text is not a record of this version. */
function parseRecord(text: string): Record<string, unknown> | undefined {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch (err) {
		console.warn('[cadre-core/edge-node] ignoring saved start options that are not JSON:', err);
		return undefined;
	}
	if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
		console.warn('[cadre-core/edge-node] ignoring saved start options that are not an object');
		return undefined;
	}
	const record = raw as Record<string, unknown>;
	if (record.version !== RECORD_VERSION) {
		console.warn(`[cadre-core/edge-node] ignoring saved start options of unknown version ${String(record.version)}`);
		return undefined;
	}
	return record;
}

function stringArrayOrEmpty(value: unknown): string[] {
	return Array.isArray(value) && value.every((entry) => typeof entry === 'string') ? value : [];
}
