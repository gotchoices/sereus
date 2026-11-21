import { registerPlugin, type Database } from '@quereus/quereus';
import cryptoPlugin from '@optimystic/quereus-plugin-crypto/plugin';
import { STRAND_SCHEMA } from '../../src/strand-schema.js';

/**
 * Declare and apply the `Strand` schema as `composeStrand` does, for a spec that calls
 * `applyAppSchema` on a database it composed itself: the apply gates on `Strand.AppSchemaVersion`.
 * The crypto plugin is registered first, as the Node platform does (`src/connect.ts`): the
 * schema's CHECKs call `digest` and `verify`, which Quereus resolves when it creates the table.
 */
export async function applyStrandSchema(db: Database): Promise<void> {
	await registerPlugin(db, cryptoPlugin);
	await db.exec(`
		declare schema Strand {
			${STRAND_SCHEMA}
		}
		apply schema Strand;
	`);
}
