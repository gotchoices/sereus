/**
 * What one phone-node start is made with, and the record that remembers it between launches.
 *
 * The record is one per app, not party-scoped: it is what *selects* the party, so every other
 * node-local record is read through the `partyId` it carries. `PhoneNode.start` writes it after
 * every successful start and `joinCadre` once a member admitted the app (`autoStart: true`), and
 * `stop` rewrites it with `autoStart: false`; an app's launch and a push wake into a killed
 * process read it to start the node unattended.
 */

// Type-only: the noise-crypto module loads react-native-quick-crypto at runtime.
import type { NoiseCryptoMode } from '../noise-crypto.js';

export interface PhoneNodeOptions {
	/** Party ID — identifies this cadre. The app mints one on first run. */
	partyId: string;
	/** Bootstrap multiaddrs (the party's always-on machines). */
	bootstrapAddrs: string[];
	/**
	 * Circuit-relay multiaddrs this phone reserves a slot on. A phone never listens, so a relay
	 * reservation is the only address anyone can dial it at. Empty is allowed: the node starts and
	 * dials out, but cannot be invited to or joined.
	 */
	relayAddrs: string[];
	/** How much of Noise's crypto runs natively; read only when the node is built. */
	noiseCryptoMode?: NoiseCryptoMode;
	/**
	 * How this app came to `partyId`. A `'founded'` party runs owner genesis on every start; a
	 * `'joined'` one never does, because genesis on a party whose control store has not arrived
	 * would seat this app as a second founder. Absent means `'founded'`.
	 */
	origin?: PhoneNodeOrigin;
	/**
	 * The party this app founded and left by joining another (`PhoneNode.joinCadre`). Its data
	 * stays on disk under its own names, for moving its strands and dissolving the old cadre.
	 */
	formerPartyId?: string;
}

/** Whether this app founded its party, or joined it by invitation. */
export type PhoneNodeOrigin = 'founded' | 'joined';

/** The last start, as `PhoneNode.loadSavedStart` reports it. */
export interface SavedStart {
	/** Exactly what the node was last successfully started with. */
	options: PhoneNodeOptions;
	/** True after a successful start, false after `stop`. Gates every unattended start. */
	autoStart: boolean;
	/**
	 * The `PhoneNodePlatform.dataVersion` of the build that last started over this device's data,
	 * or `undefined` when that build named none. The app compares it with its own to decide whether
	 * the stored data is usable.
	 */
	writtenBy?: string;
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
	origin?: PhoneNodeOrigin;
	formerPartyId?: string;
	autoStart: boolean;
	writtenBy?: string;
}

export function serializeSavedStart(saved: SavedStart): string {
	const { partyId, bootstrapAddrs, relayAddrs, noiseCryptoMode, origin, formerPartyId } = saved.options;
	const record: StartRecord = {
		version: RECORD_VERSION,
		partyId,
		bootstrapAddrs,
		relayAddrs,
		noiseCryptoMode,
		origin,
		formerPartyId,
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
 * `origin` and `formerPartyId`, `false` for `autoStart` — so a damaged record still keeps the
 * phone in its party, at worst needing the user to start the node by hand.
 */
export function parseSavedStart(text: string | undefined): SavedStart | undefined {
	if (text === undefined) return undefined;
	const record = parseRecord(text);
	if (!record) return undefined;
	const { partyId } = record;
	if (typeof partyId !== 'string' || partyId.trim().length === 0) {
		console.warn('[cadre-rn/phone-node] ignoring saved start options with no party id');
		return undefined;
	}
	const options: PhoneNodeOptions = {
		partyId,
		bootstrapAddrs: stringArrayOrEmpty(record.bootstrapAddrs),
		relayAddrs: stringArrayOrEmpty(record.relayAddrs),
	};
	if (isNoiseCryptoMode(record.noiseCryptoMode)) options.noiseCryptoMode = record.noiseCryptoMode;
	if (record.origin === 'founded' || record.origin === 'joined') options.origin = record.origin;
	if (typeof record.formerPartyId === 'string' && record.formerPartyId.trim().length > 0) {
		options.formerPartyId = record.formerPartyId;
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
		console.warn('[cadre-rn/phone-node] ignoring saved start options that are not JSON:', err);
		return undefined;
	}
	if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
		console.warn('[cadre-rn/phone-node] ignoring saved start options that are not an object');
		return undefined;
	}
	const record = raw as Record<string, unknown>;
	if (record.version !== RECORD_VERSION) {
		console.warn(`[cadre-rn/phone-node] ignoring saved start options of unknown version ${String(record.version)}`);
		return undefined;
	}
	return record;
}

function stringArrayOrEmpty(value: unknown): string[] {
	return Array.isArray(value) && value.every((entry) => typeof entry === 'string') ? value : [];
}
