/**
 * start-options.ts — the node's last start options, as remembered between launches.
 *
 * One record, not party-scoped: it is what *selects* the party, so every other
 * node-local record is read through the `partyId` it carries. `cadre-phone.ts` writes
 * it after every successful start (`autoStart: true`) and on Disconnect
 * (`autoStart: false`); app launch (`CadreViewModel.restore` in `cadre-vm.ts`) reads it
 * to start the node unattended. The storage key and backend are in
 * `node-local-slots.ts`.
 *
 * A separate copy of reference-app-rn's `start-options.ts`, minus the two options this
 * app does not have (relays, Noise crypto mode): the two apps share no app-level
 * package, and the parse tests live with the RN copy. No NativeScript or SQLite
 * imports, so the view-model tests can import it under plain Node.
 */

export interface PhoneNodeOptions {
	/** Party ID — identifies this cadre. Generated on first run. */
	partyId: string;
	/** Bootstrap multiaddrs for the drone (WebSocket). Empty for solo/forming. */
	bootstrapAddrs: string[];
}

export interface SavedStartOptions {
	/** Exactly what the node was last successfully started with. */
	options: PhoneNodeOptions;
	/** True after a successful start, false after the user taps Disconnect. Gates the launch auto-start. */
	autoStart: boolean;
}

const RECORD_VERSION = 1;

/** The stored shape. Flat, so a record read by hand is legible. */
interface StartOptionsRecord {
	version: typeof RECORD_VERSION;
	partyId: string;
	bootstrapAddrs: string[];
	autoStart: boolean;
}

export function serializeSavedStartOptions(saved: SavedStartOptions): string {
	const record: StartOptionsRecord = {
		version: RECORD_VERSION,
		partyId: saved.options.partyId,
		bootstrapAddrs: saved.options.bootstrapAddrs,
		autoStart: saved.autoStart,
	};
	return JSON.stringify(record);
}

/**
 * The saved record, or `undefined` when there is none or it is unusable (logged).
 *
 * Only the party id is worth discarding a record over. A malformed optional field
 * falls back to its default instead — `[]` for the bootstrap list, `false` for
 * `autoStart` — so a damaged record still keeps the phone in its party, at worst
 * needing one Connect tap.
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
	return {
		options: { partyId, bootstrapAddrs: stringArrayOrEmpty(record.bootstrapAddrs) },
		autoStart: record.autoStart === true,
	};
}

function stringArrayOrEmpty(value: unknown): string[] {
	return Array.isArray(value) && value.every((entry) => typeof entry === 'string') ? value : [];
}
