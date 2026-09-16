import { Parser } from '@quereus/quereus';
import type { DeclareSchemaStmt, DeclaredTable, DeclareItem } from '@quereus/quereus/parser';
import { STRAND_SCHEMA } from './strand-schema.js';

/**
 * Raised when an sApp schema declares a table whose name a strand's own `Strand`
 * schema already uses.
 *
 * Why this is refused rather than tolerated: a table declared without an explicit
 * `using optimystic('<uri>')` is stored at optimystic's default location,
 * `tree://default/<TableName>`, which carries no engine-schema name. So `App.Member`
 * and `Strand.Member` open the SAME collection and each decodes the other's rows
 * through its own columns — phantom null rows, and writes that report success yet
 * never read back. Nothing below this layer refuses the pairing while both tables
 * are still empty, which is exactly the state at strand bring-up.
 *
 * NOTE: the root cause is optimystic's default location omitting the schema name
 * (and its schema catalog being keyed by bare table name). If that becomes
 * schema-qualified, this refusal stops being load-bearing — keep it only if the
 * legible error is still wanted.
 */
export class ReservedTableNameError extends Error {
	constructor(
		/** The sApp's offending table names, as the schema spells them. */
		public readonly tables: readonly string[],
		/** Every table name the strand schema reserves. */
		public readonly reserved: readonly string[],
	) {
		super(
			`sApp schema declares table(s) ${tables.join(', ')} whose name is reserved by the strand's ` +
			`own schema (reserved, compared case-insensitively: ${reserved.join(', ')}). An app table ` +
			'sharing a strand table\'s name shares its storage; rename the app table.',
		);
		this.name = 'ReservedTableNameError';
	}
}

let reservedNames: readonly string[] | undefined;

/**
 * The table names `STRAND_SCHEMA` declares, read by Quereus's own parser so a table
 * added to the strand schema is reserved without anyone updating a list. Parsed once,
 * on first use, rather than at import.
 */
export function strandReservedTableNames(): readonly string[] {
	reservedNames ??= Object.freeze(declaredTableNames(STRAND_SCHEMA));
	return reservedNames;
}

/**
 * Refuse an sApp schema body that declares a table named like a strand table.
 * `schema` is the body `composeStrand` wraps in `declare schema App { ... }`; an
 * absent or empty body declares nothing and passes. A body that does not parse throws
 * the parser's own error — the apply would have failed on it anyway.
 *
 * @throws ReservedTableNameError naming each colliding table.
 */
export function assertNoReservedTableNames(schema: string | undefined): void {
	if (!schema) {
		return;
	}
	const reserved = strandReservedTableNames();
	const reservedLower = new Set(reserved.map((name) => name.toLowerCase()));
	const colliding = declaredTableNames(schema).filter((name) => reservedLower.has(name.toLowerCase()));
	if (colliding.length > 0) {
		throw new ReservedTableNameError(colliding, reserved);
	}
}

/**
 * Every table name a declarative schema body declares, as spelled. Wrapped in a
 * `declare schema` block the same way `composeStrand` wraps it for apply, so the
 * parser sees exactly the item grammar the apply will.
 */
function declaredTableNames(schemaBody: string): string[] {
	return new Parser()
		.parseAll(`declare schema App {\n${schemaBody}\n}`)
		.filter((stmt): stmt is DeclareSchemaStmt => stmt.type === 'declareSchema')
		.flatMap((stmt) => stmt.items.filter(isDeclaredTable))
		.map((item) => item.tableStmt.table.name);
}

function isDeclaredTable(item: DeclareItem): item is DeclaredTable {
	return item.type === 'declaredTable';
}
