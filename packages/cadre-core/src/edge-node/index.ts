/**
 * `@serfab/cadre-core/edge-node` — build and run an edge device's cadre node the prescribed way:
 * `createEdgeNode(platform)` over the app's key store and storage. A subpath rather than the root
 * export, so cadre-host and the CLI never load it; the React Native kit's `createPhoneNode`
 * (`@serfab/cadre-rn/phone-node`) is this over the secure store and rn-leveldb, and the browser
 * and NativeScript reference apps run it over IndexedDB and SQLite.
 */
export {
	createEdgeNode,
	type EdgeJoinProgress,
	type EdgeNode,
	type EdgeNodeStatus,
	type JoinCadreOptions,
	type JoinCadreResult,
	type UnfinishedRemoval,
} from './edge-node.js';
export {
	DEFAULT_EDGE_NODE_NAMES,
	type EdgeNodeNames,
	type EdgeNodePlatform,
	type EdgeNodeStorage,
	type RemovableSlot,
} from './platform.js';
export {
	isNoiseCryptoMode,
	NOISE_CRYPTO_MODES,
	parseSavedStart,
	serializeSavedStart,
	type EdgeNodeOptions,
	type EdgeNodeOrigin,
	type NoiseCryptoMode,
	type SavedStart,
} from './options.js';
export {
	buildEdgeNodeConfig,
	DEFAULT_OWNER_GENESIS_TIMEOUT_MS,
	DEFAULT_OWNER_KEY_LABEL,
	runOwnerGenesis,
	wireJoinedOwnerKey,
	type EdgeNodeConfigInputs,
	type JoinedOwnerKeyOptions,
	type OwnerGenesisOptions,
	type OwnerGenesisResult,
} from './config.js';
export { attachStrandWhenWritable, DEFAULT_STRAND_PATIENCE_MS, retryAfterRestart } from './strands.js';
export { StrandsNeedOwnerJoinError, type PendingStrandMove, type StrandMoveOutcome } from './strand-move.js';
export { FormerPartyNotEmptyError, StrandMovePendingError, type DissolveFormerPartyOptions } from './dissolve.js';
export {
	bootstrapPeersKvKey,
	enrolledMachinesKvKey,
	kvStoreSlot,
	strandNetworkKvKey,
	trustedOwnersKvKey,
	type KvStoreApi,
	type NodeLocalKv,
} from './node-local.js';
export { lazyRawStorage } from './lazy-raw-storage.js';
