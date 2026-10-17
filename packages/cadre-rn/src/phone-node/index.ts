/**
 * `@serfab/cadre-rn/phone-node` — build and run a phone's cadre node the prescribed way:
 * `@serfab/cadre-core/edge-node`'s `createEdgeNode` over the secure store and rn-leveldb. See the
 * kit README's "Phone node" section; `reference-app-rn/src/cadre-phone.ts` is the worked example.
 *
 * The edge node's names are re-exported under the phone names apps already import (`PhoneNode`,
 * `PhoneNodeOptions`, ...): the kit is published and used outside this repo.
 */
export {
	createPhoneNode,
	DEFAULT_PHONE_NODE_NAMES,
	type PhoneNode,
	type PhoneNodeNames,
	type PhoneNodePlatform,
} from './node.js';
export { type LevelDBNative } from './leveldb-storage.js';
export {
	attachStrandWhenWritable,
	buildEdgeNodeConfig as buildPhoneNodeConfig,
	DEFAULT_OWNER_GENESIS_TIMEOUT_MS,
	DEFAULT_OWNER_KEY_LABEL,
	DEFAULT_STRAND_PATIENCE_MS,
	FormerPartyNotEmptyError,
	isNoiseCryptoMode,
	NOISE_CRYPTO_MODES,
	parseSavedStart,
	retryAfterRestart,
	runOwnerGenesis,
	serializeSavedStart,
	StrandMovePendingError,
	StrandsNeedOwnerJoinError,
	wireJoinedOwnerKey,
	type DissolveFormerPartyOptions,
	type EdgeJoinProgress as PhoneJoinProgress,
	type EdgeNodeConfigInputs as PhoneNodeConfigInputs,
	type EdgeNodeOptions as PhoneNodeOptions,
	type EdgeNodeOrigin as PhoneNodeOrigin,
	type EdgeNodeStatus as PhoneNodeStatus,
	type JoinCadreOptions,
	type JoinCadreResult,
	type JoinCredential,
	type JoinedOwnerKeyOptions,
	type OwnerGenesisOptions,
	type OwnerGenesisResult,
	type PendingStrandMove,
	type RedeemedOwnerGrant,
	type SavedStart,
	type StrandMoveOutcome,
	type UnfinishedRemoval,
} from '@serfab/cadre-core/edge-node';
