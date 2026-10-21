import { describe, it, expect } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import { Database, Parser, expressionToString } from '@quereus/quereus';
import type { CreateTableStmt, Expression, FunctionExpr } from '@quereus/quereus/parser';
import {
	CONTROL_SCHEMA_BASELINE_VERSION,
	CONTROL_SCHEMA_DECLARATION,
	CONTROL_SCHEMA_NAME,
	CONTROL_SCHEMA_VERSION,
	controlSchemaFileDeclaration
} from '../src/control-schema.js';
import { declaredSchemaVersion, pendingControlSchemaChanges, type PendingControlSchemaChange } from '../src/control-schema-version.js';
import { replaceOnce, withItems, withLegacyTable } from '../../../test-harness/control-schema-releases.js';

/**
 * Every control schema version from CONTROL_SCHEMA_BASELINE_VERSION on is kept as a fixture,
 * `fixtures/control-schema/v<N>.qsql` (the whole schema file of that version), and each differs
 * from the one before only in ways a running party can apply to the control store it already has.
 *
 * Runs on Quereus's in-memory tables, with no optimystic: `diff schema` is computed from the
 * catalog alone, so it lists the same statements it does over the optimystic module.
 */

const DOCS_SECTION = 'docs/architecture.md → "Control schema versions and migrations"';
const FIXTURE_DIR = new URL('./fixtures/control-schema/', import.meta.url);
const FIXTURE_NAME = /^v(\d+)\.qsql$/;

/**
 * Digests whose argument list a version changed, as `{ version, table, action }` with `version` the
 * version that changed it. A stored row's signature was made over the old form, so each entry's
 * comment names where the old form is still verified for rows written before the change.
 */
const CHANGED_DIGESTS: ReadonlyArray<{ readonly version: number; readonly table: string; readonly action: string }> = [];

/** Every fixture's text by version, line endings as LF so the variants below can anchor on them. */
async function readFixtures(): Promise<Map<number, string>> {
	const fixtures = new Map<number, string>();
	for (const name of await readdir(FIXTURE_DIR)) {
		const version = FIXTURE_NAME.exec(name)?.[1];
		if (version === undefined) {
			throw new Error(`fixtures/control-schema/${name} is not named v<version>.qsql`);
		}
		fixtures.set(Number(version), (await readFile(new URL(name, FIXTURE_DIR), 'utf-8')).replace(/\r\n/g, '\n'));
	}
	return fixtures;
}

function fixtureOf(fixtures: ReadonlyMap<number, string>, version: number): string {
	const schema = fixtures.get(version);
	if (schema === undefined) {
		throw new Error(`no fixture for control schema version ${version}`);
	}
	return schema;
}

/** Run `read` on a fresh in-memory database after executing `sql` in it. */
async function withDatabase<T>(sql: readonly string[], read: (db: Database) => Promise<T> | T): Promise<T> {
	const db = new Database();
	try {
		for (const statement of sql) {
			await db.exec(statement);
		}
		return await read(db);
	} finally {
		await db.close();
	}
}

const schemaHash = (declaration: string): Promise<unknown> =>
	withDatabase([declaration], async (db) => (await db.get(`explain schema ${CONTROL_SCHEMA_NAME}`))?.info);

/** What applying `next` to a store created under `store` would run, classified against that store's catalog. */
const changesBetween = (store: string, next: string): Promise<PendingControlSchemaChange[]> =>
	withDatabase([store, controlSchemaFileDeclaration(next)], pendingControlSchemaChanges);

/** A change's statement, as `alter table addColumn`, `drop index`, `createTable`. */
function shapeOf(change: PendingControlSchemaChange): string {
	return new Parser().parseAll(change.ddl).map((statement) => {
		switch (statement.type) {
			case 'alterTable':
				return `alter table ${statement.action.type}`;
			case 'drop':
				return `drop ${statement.objectType}`;
			default:
				return statement.type;
		}
	}).join('; ');
}

/** One `digest('CadreControl.<table>', '<action>', …)` call, its remaining arguments rendered. */
interface SignedDigest {
	readonly table: string;
	readonly action: string;
	readonly args: string;
}

/** Every digest call in the CHECK constraints of the tables `schema` declares, from the parsed schema. */
function signedDigests(schema: string): SignedDigest[] {
	const [declaration] = new Parser().parseAll(schema);
	if (declaration.type !== 'declareSchema') {
		throw new Error('a control schema file starts with its declaration');
	}
	const digests: SignedDigest[] = [];
	for (const item of declaration.items) {
		if (item.type === 'declaredTable') {
			visitObjects(checkExpressions(item.tableStmt), (node) => {
				if (isDigestCall(node)) {
					digests.push(signedDigestOf(node));
				}
			});
		}
	}
	return digests;
}

function checkExpressions(table: CreateTableStmt): Expression[] {
	return [...table.constraints, ...table.columns.flatMap((column) => column.constraints)]
		.flatMap((constraint) => (constraint.type === 'check' && constraint.expr !== undefined ? [constraint.expr] : []));
}

/** Every object reachable from `value` through its fields and array elements; the parser's AST holds no cycles. */
function visitObjects(value: unknown, visit: (node: object) => void): void {
	if (Array.isArray(value)) {
		value.forEach((element) => visitObjects(element, visit));
	} else if (typeof value === 'object' && value !== null) {
		visit(value);
		Object.values(value).forEach((field) => visitObjects(field, visit));
	}
}

function isDigestCall(node: object): node is FunctionExpr {
	return 'type' in node && node.type === 'function' && (node as FunctionExpr).name.toLowerCase() === 'digest';
}

function signedDigestOf(call: FunctionExpr): SignedDigest {
	const [domain, action, ...args] = call.args;
	const prefix = `${CONTROL_SCHEMA_NAME}.`;
	const domainTag = stringLiteral(domain);
	const actionTag = stringLiteral(action);
	if (domainTag?.startsWith(prefix) !== true || actionTag === undefined) {
		throw new Error(`${expressionToString(call)} does not lead with a '${prefix}<Table>' domain tag and an action tag`);
	}
	return { table: domainTag.slice(prefix.length), action: actionTag, args: args.map((arg) => expressionToString(arg)).join(', ') };
}

const stringLiteral = (expression: Expression | undefined): string | undefined =>
	(expression?.type === 'literal' && typeof expression.value === 'string' ? expression.value : undefined);

const digestKey = (table: string, action: string): string => `${table} '${action}'`;

/** The argument lists each digest is computed over, by {@link digestKey}. */
function digestForms(schema: string): Map<string, string[]> {
	const forms = new Map<string, Set<string>>();
	for (const { table, action, args } of signedDigests(schema)) {
		const key = digestKey(table, action);
		forms.set(key, (forms.get(key) ?? new Set()).add(args));
	}
	return new Map([...forms].map(([key, lists]) => [key, [...lists].sort()]));
}

describe('control schema versions', () => {
	it('keeps a fixture for every version from the baseline to this build, the last one being this build', async () => {
		const fixtures = await readFixtures();
		const expected = Array.from({ length: CONTROL_SCHEMA_VERSION - CONTROL_SCHEMA_BASELINE_VERSION + 1 }, (_, i) => CONTROL_SCHEMA_BASELINE_VERSION + i);
		expect([...fixtures.keys()].sort((a, b) => a - b), `one fixture per control schema version; see ${DOCS_SECTION}`).toEqual(expected);
		for (const [version, schema] of fixtures) {
			const tagged = await withDatabase([controlSchemaFileDeclaration(schema)], declaredSchemaVersion);
			expect(tagged, `v${version}.qsql: the OwnerKey version tag`).toBe(version);
		}

		// Quereus hashes the declaration with comments and tags stripped, so a comment-only edit
		// moves neither side, and a Quereus upgrade that renders schemas differently moves both.
		// NOTE: an edit to schemas/control.qsql copied into the last fixture in place, with no new
		// version, passes here; only review catches it. If that slips through, pin the text hash
		// of each fixture once its version ships.
		const latest = await schemaHash(controlSchemaFileDeclaration(fixtureOf(fixtures, CONTROL_SCHEMA_VERSION)));
		expect(latest, 'The declared control schema differs from the fixture of CONTROL_SCHEMA_VERSION. A version that has ' +
			'shipped in a release is never edited: bump CONTROL_SCHEMA_VERSION and add its fixture, a copy of ' +
			`schemas/control.qsql (${DOCS_SECTION}).`).toBe(await schemaHash(CONTROL_SCHEMA_DECLARATION));
	});

	it('lets each version differ from the one before only by changes a store can be migrated across', async () => {
		// With only the baseline fixture this loops zero times; the synthetic case below exercises the classifier meanwhile.
		const fixtures = await readFixtures();
		for (let version = CONTROL_SCHEMA_BASELINE_VERSION + 1; version <= CONTROL_SCHEMA_VERSION; version++) {
			const changes = await changesBetween(fixtureOf(fixtures, version - 1), fixtureOf(fixtures, version));
			const unmigratable = changes.filter((change) => change.kind === 'unmigratable').map((change) => change.ddl);
			expect(unmigratable, `v${version - 1} → v${version} makes changes no control store can be migrated across; see ${DOCS_SECTION}`).toEqual([]);
		}
	});

	it('classifies the changes of a synthetic next version', async () => {
		const baseline = fixtureOf(await readFixtures(), CONTROL_SCHEMA_BASELINE_VERSION);
		const variants = [
			{
				name: 'migratable',
				store: withItems(
					replaceOnce(baseline, '    table ValidationKey (\n        Key text primary key,\n', '    table ValidationKey (\n        Key text primary key,\n        Retired text null,\n'),
					'    index ValidationKeyByStamp on ValidationKey (StampId);\n'
				),
				next: withItems(
					replaceOnce(
						replaceOnce(baseline, '        Reason text,', '        Note text null,\n        Reason text,'),
						"R.TableName = 'ValidationKey' and R.StampId = new.StampId)",
						"R.TableName = 'ValidationKey' and R.StampId = new.StampId and new.Key is not null)"
					),
					'    table Annotation (Id text primary key, Body text null);\n    index JoinFailureByCode on JoinFailure (Code);\n'
				),
				expected: [
					'createTable → additive',
					'createIndex → additive',
					'alter table addColumn → catalog-only',
					'alter table dropColumn → catalog-only',
					'alter table dropConstraint → catalog-only',
					'alter table addConstraint → catalog-only',
					'drop index → catalog-only'
				]
			},
			{
				name: 'unmigratable',
				store: withLegacyTable(baseline),
				next: replaceOnce(baseline, '        RequestedAt integer,', '        RequestedAt text,\n        Attempts integer not null,'),
				expected: [
					'drop table → unmigratable',
					'alter table addColumn → unmigratable',
					'alter table alterColumn → unmigratable'
				]
			}
		];
		for (const { name, store, next, expected } of variants) {
			const classified = (await changesBetween(store, next)).map((change) => `${shapeOf(change)} → ${change.kind}`);
			expect(classified.sort(), name).toEqual([...expected].sort());
		}
	});

	it('changes no signed digest between versions without recording it', async () => {
		// The anchor's chain check, `verifyOwnerKeyVoucher` and the other readers verify a stored row
		// against the digest form they know; a row signed over a form they no longer know stops being trusted.
		const fixtures = await readFixtures();
		for (const [version, schema] of fixtures) {
			// Anti-vacuity: the walk finds every tag pair control-schema-drift.spec.ts counts in the text.
			const tagPairs = schema.match(/'CadreControl\.\w+', '\w+',/g) ?? [];
			expect(signedDigests(schema).length, `v${version}.qsql digest calls`).toBeGreaterThanOrEqual(tagPairs.length);
		}
		for (let version = CONTROL_SCHEMA_BASELINE_VERSION + 1; version <= CONTROL_SCHEMA_VERSION; version++) {
			const before = digestForms(fixtureOf(fixtures, version - 1));
			const after = digestForms(fixtureOf(fixtures, version));
			const changed = [...after]
				.filter(([key, lists]) => before.has(key) && JSON.stringify(before.get(key)) !== JSON.stringify(lists))
				.map(([key]) => key);
			const recorded = CHANGED_DIGESTS.filter((entry) => entry.version === version).map(({ table, action }) => digestKey(table, action));
			expect(changed.sort(), `v${version - 1} → v${version}: digests whose arguments changed, against CHANGED_DIGESTS; see ${DOCS_SECTION}`)
				.toEqual(recorded.sort());
		}
	});
});
