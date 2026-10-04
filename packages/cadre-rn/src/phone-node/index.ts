/**
 * `@serfab/cadre-rn/phone-node` — build and run a phone's cadre node the prescribed way. See the
 * kit README's "Phone node" section; `reference-app-rn/src/cadre-phone.ts` is the worked example.
 */
export {
	createPhoneNode,
	DEFAULT_PHONE_NODE_NAMES,
	type LevelDBNative,
	type PhoneNode,
	type PhoneNodeNames,
	type PhoneNodePlatform,
	type PhoneNodeStatus,
} from './node.js';
export {
	isNoiseCryptoMode,
	NOISE_CRYPTO_MODES,
	parseSavedStart,
	serializeSavedStart,
	type PhoneNodeOptions,
	type SavedStart,
} from './options.js';
export {
	buildPhoneNodeConfig,
	DEFAULT_OWNER_GENESIS_TIMEOUT_MS,
	runOwnerGenesis,
	type OwnerGenesisResult,
	type PhoneNodeConfigInputs,
} from './config.js';
export { attachStrandWhenWritable, DEFAULT_STRAND_PATIENCE_MS, retryAfterRestart } from './strands.js';
