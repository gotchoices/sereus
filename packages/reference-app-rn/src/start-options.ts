/**
 * start-options.ts — the node's last start options, as remembered between launches.
 *
 * One record, not party-scoped: it is what *selects* the party, so every other
 * node-local record is read through the `partyId` it carries. `cadre-phone.ts` writes
 * it after every successful start (`autoStart: true`) and on Disconnect
 * (`autoStart: false`); app launch (`use-cadre.ts`) and a push wake into a killed
 * process (`push-wake-native.ts`) read it to start the node unattended. The storage
 * key is in `node-local-names.ts`; the backend is opened in `cadre-phone.ts`.
 *
 * No native imports, so the parser is Node-tested (`test/start-options.spec.ts`).
 */

import { isNoiseCryptoMode, type PhoneNodeOptions } from './phone-node-config';

export interface SavedStartOptions {
	/** Exactly what the node was last successfully started with. */
	options: PhoneNodeOptions;
	/** True after a successful start, false after the user taps Disconnect. Gates every unattended start. */
	autoStart: boolean;
}

const RECORD_VERSION = 1;

/** The stored shape. Flat, so a record read by hand is legible. */
interface StartOptionsRecord {
	version: typeof RECORD_VERSION;
	partyId: string;
	bootstrapAddrs: string[];
	relayAddrs: string[];
	noiseCryptoMode?: PhoneNodeOptions['noiseCryptoMode'];
	autoStart: boolean;
}

export function serializeSavedStartOptions(saved: SavedStartOptions): string {
	const { partyId, bootstrapAddrs, relayAddrs, noiseCryptoMode } = saved.options;
	const record: StartOptionsRecord = {
		version: RECORD_VERSION,
		partyId,
		bootstrapAddrs,
		relayAddrs,
		noiseCryptoMode,
		autoStart: saved.autoStart,
	};
	return JSON.stringify(record);
}

/**
 * The saved record, or `undefined` when there is none or it is unusable (logged).
 *
 * Only the party id is worth discarding a record over. A malformed optional field
 * falls back to its default instead — `[]` for an address list, the build default for
 * the Noise mode, `false` for `autoStart` — so a damaged record still keeps the phone
 * in its party, at worst needing one Connect tap.
 */
export function parseSavedStartOptions(text: string | undefined): SavedStartOptions | undefined {
	if (text === undefined) return undefined;
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch (err) {
		console.warn('[start-options] ignoring saved start options that are not JSON:', err);
		return undefined;
	}
	if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
		console.warn('[start-options] ignoring saved start options that are not an object');
		return undefined;
	}
	const record = raw as Record<string, unknown>;
	if (record.version !== RECORD_VERSION) {
		console.warn(`[start-options] ignoring saved start options of unknown version ${String(record.version)}`);
		return undefined;
	}
	const { partyId } = record;
	if (typeof partyId !== 'string' || partyId.trim().length === 0) {
		console.warn('[start-options] ignoring saved start options with no party id');
		return undefined;
	}
	const options: PhoneNodeOptions = {
		partyId,
		bootstrapAddrs: stringArrayOrEmpty(record.bootstrapAddrs),
		relayAddrs: stringArrayOrEmpty(record.relayAddrs),
	};
	if (isNoiseCryptoMode(record.noiseCryptoMode)) options.noiseCryptoMode = record.noiseCryptoMode;
	return { options, autoStart: record.autoStart === true };
}

function stringArrayOrEmpty(value: unknown): string[] {
	return Array.isArray(value) && value.every((entry) => typeof entry === 'string') ? value : [];
}
