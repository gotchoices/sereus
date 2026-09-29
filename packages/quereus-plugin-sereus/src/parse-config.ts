import type { SqlValue } from '@quereus/quereus';
import type { StrandConnectionOptions, StrandTransactor } from './types.js';

type FretProfile = NonNullable<StrandConnectionOptions['fretProfile']>;

export interface ParsedPluginConfig {
	options: StrandConnectionOptions;
	/**
	 * Node-only: resolved to a `FileRawStorage` by `plugin.ts`, rejected by
	 * `plugin-browser.ts`. It travels beside the options rather than in them
	 * because `StrandConnectionOptions.storage` is an `IRawStorage`, which no
	 * `SqlValue` can carry.
	 */
	storagePath?: string;
}

/** What each setting reads to once it is supplied and accepted. */
interface SettingTypes {
	strand_id: string;
	bootstrap_nodes: string[];
	schema: string;
	sapp_id: string;
	sapp_version: string;
	port: number;
	enable_cache: boolean;
	fret_profile: FretProfile;
	transactor: StrandTransactor;
	storage_path: string;
}

type SettingKey = keyof SettingTypes;

interface Setting<T> {
	/** What the setting accepts, as a problem line states it. */
	readonly expected: string;
	/** The value as typed, or undefined when `raw` is not acceptable. */
	readonly read: (raw: NonNullable<SqlValue>) => T | undefined;
	/** `''` means "not set" — Quoomb Web's text inputs send it for a cleared field. */
	readonly emptyIsAbsent?: boolean;
	readonly required?: boolean;
}

const TEXT: Setting<string> = {
	expected: 'a string',
	read: raw => (typeof raw === 'string' ? raw : undefined),
	emptyIsAbsent: true,
};

const COMMA_LIST: Setting<string[]> = {
	...TEXT,
	expected: 'a comma-separated string',
	read: raw => (typeof raw === 'string' ? raw.split(',').map(s => s.trim()).filter(Boolean) : undefined),
};

const PORT: Setting<number> = {
	expected: 'an integer from 0 to 65535',
	read: raw => (typeof raw === 'number' && Number.isInteger(raw) && raw >= 0 && raw <= 65535 ? raw : undefined),
};

/** 0 and 1 are accepted because SQL has no boolean type. */
const FLAG: Setting<boolean> = {
	expected: 'true, false, 1 or 0',
	read: raw => {
		if (raw === true || raw === 1) return true;
		if (raw === false || raw === 0) return false;
		return undefined;
	},
};

/**
 * One of a closed set of strings. The set is written as an object with every
 * member as a key so it is checked against the union: `oneOf<StrandTransactor>`
 * stops compiling when the union gains or loses a member.
 */
function oneOf<T extends string>(members: Record<T, true>): Setting<T> {
	const values = Object.keys(members) as T[];
	return {
		expected: `one of ${values.join(', ')}`,
		read: raw => values.find(v => v === raw),
		emptyIsAbsent: true,
	};
}

const SETTINGS: { readonly [K in SettingKey]: Setting<SettingTypes[K]> } = {
	strand_id: { ...TEXT, required: true },
	bootstrap_nodes: COMMA_LIST,
	schema: TEXT,
	sapp_id: TEXT,
	sapp_version: TEXT,
	port: PORT,
	enable_cache: FLAG,
	fret_profile: oneOf<FretProfile>({ edge: true, core: true }),
	transactor: oneOf<StrandTransactor>({ local: true, network: true, test: true }),
	storage_path: TEXT,
};

/** Every key the plugin accepts; the package manifest's `quereus.settings` must list the same. */
export const PLUGIN_SETTING_KEYS = Object.keys(SETTINGS) as readonly SettingKey[];

const PROBLEM_HEADER = 'quereus-plugin-sereus: invalid plugin settings';

/** A string echoed in a problem is cut here: enough to recognise a typo, not a pasted schema. */
const MAX_ECHOED_CHARS = 120;

/**
 * Parse the plugin-loader SqlValue config into typed StrandConnectionOptions.
 * Shared by the Node (`plugin.ts`) and browser (`plugin-browser.ts`) entries.
 *
 * Strict: an unknown key or a value of the wrong type throws one error listing
 * every problem, rather than falling back to a default the user never chose.
 */
export function parseConfig(config: Record<string, SqlValue>): ParsedPluginConfig {
	const problems: string[] = [];
	const values = readSettings(config, problems);
	problems.push(...unknownKeyProblems(config));
	// `strand_id` is undefined only alongside its own "required" problem.
	const strandId = values.strand_id;
	if (problems.length > 0 || strandId === undefined) {
		throw new Error([PROBLEM_HEADER, ...problems.map(p => `  - ${p}`)].join('\n'));
	}
	return toParsedConfig(strandId, values);
}

function readSettings(config: Record<string, SqlValue>, problems: string[]): Partial<SettingTypes> {
	const values: Partial<SettingTypes> = {};
	for (const key of PLUGIN_SETTING_KEYS) readSettingInto(values, key, config[key], problems);
	return values;
}

function readSettingInto<K extends SettingKey>(
	values: Partial<SettingTypes>,
	key: K,
	raw: SqlValue | undefined,
	problems: string[],
): void {
	const setting: Setting<SettingTypes[K]> = SETTINGS[key];
	if (raw === undefined || raw === null || (raw === '' && setting.emptyIsAbsent)) {
		if (setting.required) problems.push(`${key} is required`);
		return;
	}
	const value = setting.read(raw);
	if (value === undefined) {
		problems.push(`${key} must be ${setting.expected} (got ${describeValue(raw)})`);
		return;
	}
	values[key] = value;
}

function unknownKeyProblems(config: Record<string, SqlValue>): string[] {
	return Object.keys(config)
		.filter(key => !Object.hasOwn(SETTINGS, key))
		.map(key => key === 'mode'
			? 'mode was removed: a lone node now coordinates for itself, and transactor selects the storage engine'
			: `unknown setting ${JSON.stringify(key)}; accepted settings are ${PLUGIN_SETTING_KEYS.join(', ')}`);
}

function describeValue(raw: NonNullable<SqlValue>): string {
	if (typeof raw === 'string') {
		return raw.length > MAX_ECHOED_CHARS
			? `${JSON.stringify(raw.slice(0, MAX_ECHOED_CHARS))}… (${raw.length} characters)`
			: JSON.stringify(raw);
	}
	if (typeof raw === 'bigint') return `${raw}n`;
	if (typeof raw === 'number' || typeof raw === 'boolean') return String(raw);
	if (raw instanceof Uint8Array) return `a blob of ${raw.length} bytes`;
	return 'a JSON value';
}

function toParsedConfig(strandId: string, values: Partial<SettingTypes>): ParsedPluginConfig {
	const { transactor } = values;
	return {
		options: {
			strandId,
			bootstrapNodes: values.bootstrap_nodes ?? [],
			schema: values.schema,
			sAppId: values.sapp_id ?? 'unknown',
			sAppVersion: values.sapp_version ?? '1.0.0',
			port: values.port ?? 0,
			enableCache: values.enable_cache ?? true,
			fretProfile: values.fret_profile ?? 'edge',
			// Left out entirely when unset so `composeStrand` applies its own default.
			...(transactor && { transactor }),
		},
		storagePath: values.storage_path,
	};
}
