import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { marked } from 'marked';
import { Database, Parser, createScalarFunction, quoteIdentifier, registerPlugin } from '@quereus/quereus';
import type { TableSchema } from '@quereus/quereus';
import cryptoPlugin from '@optimystic/quereus-plugin-crypto/plugin';
import { applyAppSchema } from '../src/compose-strand.js';

/**
 * Executes the fenced SQL in `docs/schema-guide.md`, so an example the engine rejects fails
 * here instead of in an app author's hands. Every fence carries one marker in its info string:
 *   - `sql schema [<name>]` — an sApp schema body, what an app passes as the `schema` option.
 *                             Executed. The optional name lets query blocks refer to it.
 *   - `sql query <name>`    — statements planned (never run) against the `sql schema <name>`
 *                             block, with `App` on the search path.
 *   - `sql script`          — a complete statement sequence. Executed as-is.
 *   - `sql fragment`        — shown for reading only. Never executed.
 * Any other fence fails, so a new example forces its author to pick one.
 *
 * Applying a schema body is not enough: Quereus compiles a table's CHECK constraints when a
 * write is planned, not when the table is created, so a check that calls a missing function,
 * reads an undeclared context variable or names a missing column applies cleanly. Each table
 * therefore has an insert, an update and a delete planned (not run); `check on delete` is only
 * compiled by the delete.
 *
 * NOTE: planning proves a check or query compiles, not that it succeeds when run — a reversed
 * `like(author_email, '%@%')` passed here, and so would an insert omitting a NOT NULL column;
 * if the guide's checks grow subtler, insert one representative row per table (hand-written
 * per example) instead of only planning.
 */

const GUIDE_PATH = fileURLToPath(new URL('../../../docs/schema-guide.md', import.meta.url));

const SCHEMA_NAME = /^[a-z][a-z0-9-]*$/;

type Fence =
	| { marker: 'schema'; schemaName: string | undefined }
	| { marker: 'query'; schemaName: string }
	| { marker: 'script' }
	| { marker: 'fragment' };

type Plannable = Parameters<Database['getPlan']>[0];

interface GuideBlock {
	/** `<heading> #<n>`, n counting fences under that heading. */
	name: string;
	info: string;
	/** Undefined when the info string is none of the forms {@link fenceOf} accepts. */
	fence: Fence | undefined;
	text: string;
}

/** Functions the guide's examples call that the application, not Sereus, registers. */
const APP_SUPPLIED_FUNCTIONS = [
	// has_role(token, role) → 1/0, the Roles & Permissions example's authorization hook.
	// Must be deterministic, or the determinism gate rejects the CHECK that calls it.
	createScalarFunction({ name: 'has_role', numArgs: 2, deterministic: true }, () => 1),
];

function fenceOf(info: string): Fence | undefined {
	const [lang, marker, schemaName, ...rest] = info.trim().split(/\s+/);
	if (lang !== 'sql' || rest.length > 0 || (schemaName !== undefined && !SCHEMA_NAME.test(schemaName))) {
		return undefined;
	}
	switch (marker) {
		case 'schema':
			return { marker, schemaName };
		case 'query':
			return schemaName === undefined ? undefined : { marker, schemaName };
		case 'script':
		case 'fragment':
			return schemaName === undefined ? { marker } : undefined;
		default:
			return undefined;
	}
}

function extractBlocks(markdown: string): GuideBlock[] {
	let heading = '(before the first heading)';
	const countByHeading = new Map<string, number>();
	const blocks: GuideBlock[] = [];
	marked.walkTokens(marked.lexer(markdown), token => {
		if (token.type === 'heading') {
			heading = token.text;
		} else if (token.type === 'code') {
			const n = (countByHeading.get(heading) ?? 0) + 1;
			countByHeading.set(heading, n);
			const info = token.lang ?? '';
			blocks.push({ name: `${heading} #${n}`, info, fence: fenceOf(info), text: token.text });
		}
	});
	return blocks;
}

function schemaNames(blocks: GuideBlock[]): string[] {
	return blocks.flatMap(b => (b.fence?.marker === 'schema' && b.fence.schemaName !== undefined ? [b.fence.schemaName] : []));
}

async function guideDatabase(): Promise<Database> {
	const db = new Database();
	// Registered as the Node platform does (`src/connect.ts`): every strand has digest/verify.
	await registerPlugin(db, cryptoPlugin);
	for (const fn of APP_SUPPLIED_FUNCTIONS) {
		db.registerFunction(fn);
	}
	return db;
}

function withContextClause(table: TableSchema): string {
	const names = (table.mutationContext ?? []).map(v => `${quoteIdentifier(v.name)} = ?`);
	return names.length > 0 ? ` with context ${names.join(', ')}` : '';
}

function writeStatements(table: TableSchema): string[] {
	const target = `App.${quoteIdentifier(table.name)}`;
	const columns = table.columns.filter(c => !c.generated).map(c => quoteIdentifier(c.name));
	const context = withContextClause(table);
	return [
		`insert into ${target} (${columns.join(', ')})${context} values (${columns.map(() => '?').join(', ')})`,
		`update ${target} set ${columns[0]} = ?${context}`,
		`delete from ${target}${context}`,
	];
}

function planOrExplain(db: Database, label: string, statement: Plannable): void {
	try {
		db.getPlan(statement);
	} catch (err) {
		throw new Error(`planning ${label} failed: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
	}
}

function planSql(db: Database, sql: string): void {
	planOrExplain(db, `\`${sql}\``, sql);
}

async function checkSchemaBody(db: Database, body: string): Promise<void> {
	await applyAppSchema(db, body);
	// The diff is already applied, so this only inserts the seed rows — proving their literals
	// fit their tables. Sereus itself applies without `with seed`.
	await db.exec('apply schema App with seed');
	const app = db.schemaManager.getSchema('App');
	if (!app) {
		throw new Error('schema App missing after apply');
	}
	for (const table of app.getAllTables()) {
		for (const sql of writeStatements(table)) {
			planSql(db, sql);
		}
	}
	for (const view of app.getAllViews()) {
		planSql(db, `select * from App.${quoteIdentifier(view.name)}`);
	}
}

async function checkQueries(db: Database, schemaBody: string, queries: string): Promise<void> {
	await applyAppSchema(db, schemaBody);
	// `App` alone, so a guide table name can never resolve against `main`.
	db.setSchemaPath(['App']);
	// The parsed AST carries no source text, so failures name a statement by position.
	const statements = new Parser().parseAll(queries);
	if (statements.length === 0) {
		throw new Error('query block has no statements');
	}
	statements.forEach((statement, i) => planOrExplain(db, `statement ${i + 1} of ${statements.length}`, statement));
}

const blocks = extractBlocks(readFileSync(GUIDE_PATH, 'utf-8'));

function schemaBodyNamed(schemaName: string): string {
	const body = blocks.find(b => b.fence?.marker === 'schema' && b.fence.schemaName === schemaName)?.text;
	if (body === undefined) {
		throw new Error(`query refers to no \`sql schema ${schemaName}\` block`);
	}
	return body;
}

async function checkBlock(db: Database, fence: Exclude<Fence, { marker: 'fragment' }>, text: string): Promise<void> {
	switch (fence.marker) {
		case 'schema':
			return checkSchemaBody(db, text);
		case 'query':
			return checkQueries(db, schemaBodyNamed(fence.schemaName), text);
		case 'script':
			return db.exec(text);
	}
}

describe('docs/schema-guide.md examples', () => {
	it('marks every fence and contains schema examples', () => {
		const unmarked = blocks.filter(b => b.fence === undefined).map(b => `${b.name}: \`\`\`${b.info}`);
		expect(unmarked, 'fences need `sql schema [<name>]`, `sql query <name>`, `sql script` or `sql fragment`; names match /^[a-z][a-z0-9-]*$/').toEqual([]);
		const names = schemaNames(blocks);
		expect(names.filter((n, i) => names.indexOf(n) !== i), 'schema names must be unique across the guide').toEqual([]);
		expect(blocks.filter(b => b.fence?.marker === 'schema').length).toBeGreaterThan(0);
	});

	// A loop rather than `it.each`, whose `$name` interpolation truncates long headings.
	for (const { name, fence, text } of blocks) {
		if (fence === undefined || fence.marker === 'fragment') {
			continue;
		}
		it(fence.marker === 'query' ? `${name} (query → ${fence.schemaName})` : `${name} (${fence.marker})`, async () => {
			const db = await guideDatabase();
			try {
				await checkBlock(db, fence, text);
			} finally {
				await db.close();
			}
		});
	}
});
