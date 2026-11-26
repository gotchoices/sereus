import { causeOf } from './cause-chain.js';

/**
 * An sApp schema refused for a reason that does not pass: the schema itself (a seed item, an item the
 * parser skipped, a syntax error, an invalid version), the schema against the tables and rows this node
 * holds, such as a `not null` column with no default added to a table that has rows, or a version below
 * the one the strand records ({@link AppSchemaOutdatedError}). Applying the same schema here again
 * fails the same way, so a host should not retry it until the app supplies a different one. A storage
 * or network fault is never this error.
 *
 * `cause` is the error Quereus raised, when it raised one.
 */
export class AppSchemaRefusedError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = 'AppSchemaRefusedError';
	}
}

/**
 * The strand records a higher App schema version than this app declares: a member has applied a newer
 * schema, and this app's would remove what it added. Not retryable: the app must update. A subclass of
 * {@link AppSchemaRefusedError}, so every host that stops retrying a refused schema stops retrying this.
 */
export class AppSchemaOutdatedError extends AppSchemaRefusedError {
	/** The version this app declares (`schemaVersion`). */
	readonly appSchemaVersion: number;
	/** The version the strand records, the highest any member has applied. */
	readonly strandSchemaVersion: number;

	constructor(appSchemaVersion: number, strandSchemaVersion: number) {
		super(`This app's schema is version ${appSchemaVersion}, and a member of this strand has applied version ${strandSchemaVersion}: update the app to open the strand`);
		this.name = 'AppSchemaOutdatedError';
		this.appSchemaVersion = appSchemaVersion;
		this.strandSchemaVersion = strandSchemaVersion;
	}
}

/** The {@link AppSchemaRefusedError} `err` is or wraps, walking `cause`, so a wrapper added between the apply and the catch cannot hide it. */
export function appSchemaRefusalOf(err: unknown): AppSchemaRefusedError | undefined {
	return causeOf(err, AppSchemaRefusedError);
}
