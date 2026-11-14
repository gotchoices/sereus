import type { Database } from '@quereus/quereus';
import { STRAND_SCHEMA } from '../../src/strand-schema.js';

/**
 * Declare and apply the `Strand` schema as `composeStrand` does, for a spec that calls
 * `applyAppSchema` on a database it composed itself: the apply gates on `Strand.AppSchemaVersion`.
 */
export async function applyStrandSchema(db: Database): Promise<void> {
	await db.exec(`
		declare schema Strand {
			${STRAND_SCHEMA}
		}
		apply schema Strand;
	`);
}
