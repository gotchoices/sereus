export { connectToStrand } from './connect.js';
export { offlineControllerOf } from './offline-controllers.js';
export { applyAppSchema, checkAppSchema, type VersionedAppSchema } from './app-schema.js';
export { AppSchemaRefusedError, AppSchemaOutdatedError, appSchemaRefusalOf } from './app-schema-errors.js';
export { cohortOutOfSpaceOf } from './write-errors.js';
// Re-exported for the same reason the offline queue's error types below are: an app that depends on
// this package and not on `@optimystic/db-core` cannot otherwise name what `cohortOutOfSpaceOf`
// hands back. A type, not the class — apps ask the finder, never `instanceof`, since the error
// arrives wrapped.
export type { CohortOutOfSpaceError } from '@optimystic/db-core';
export { createEmptyCollections, type CollectionRegistrySource } from './empty-collections.js';
export {
	MIN_CLUSTER_SIZE,
	COHORT_READ_DEADLINE_MS,
	CONTROL_REPLICATION_BREADTH,
	CONTROL_CLUSTER_POLICY,
	DEFAULT_STRAND_CLUSTER_SIZE,
	STRAND_CLUSTER_POLICY,
	resolveStrandClusterSize,
	resolveRepairYardstick,
	controlClusterPolicy,
	strandClusterPolicy
} from './cluster-size.js';
export type {
	StrandConnectionOptions, StrandAppSchemaOptions, SereusPluginResult, StrandTransactor, StrandOfflineOptions, StrandOfflineController, AppSchemaOutcome, AppSchemaWait,
} from './types.js';
export type { SqlCommitDurability, CommitFullyHeld } from '@optimystic/quereus-plugin-optimystic/plugin';
export {
	OfflineCommitTimeoutError,
	QueuedEntriesBlockSchemaChangeError,
	EntryNotDiscardableError,
	UnknownEntryError,
	QueueDisposedError,
	OfflineJournalError,
} from '@optimystic/quereus-plugin-optimystic/plugin';
export type { QueuedTransactionStatus, OfflineModeState, CommitOutlook } from '@optimystic/quereus-plugin-optimystic/plugin';
