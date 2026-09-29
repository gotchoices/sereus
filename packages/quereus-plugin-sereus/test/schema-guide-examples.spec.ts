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
 *   - `sql schema`   — an sApp schema body, what an app passes as the `schema` option. Executed.
 *   - `sql script`   — a complete statement sequence. Executed as-is.
 *   - `sql fragment` — shown for reading only. Never executed.
 * Any other fence fails, so a new example forces its author to pick one.
 *
 * Applying a schema body is not enough: Quereus compiles a table's CHECK constraints when a
 * write is planned, not when the table is created, so a check that calls a missing function,
 * reads an undeclared context variable or names a missing column applies cleanly. Each table
 * therefore has an insert, an update and a delete planned (not run); `check on delete` is only
 * compiled by the delete.
 */

const GUIDE_PATH = fileURLToPath(new URL('../../../docs/schema-guide.md', import.meta.url));

const MARKERS = ['schema', 'script', 'fragment'] as const;
type Marker = typeof MARKERS[number];

interface GuideBlock {
	/** `<heading> #<n>`, n counting fences under that heading. */
	name: string;
	info: string;
	marker: Marker | undefined;
	text: string;
}

/** Functions the guide's examples call that the application, not Sereus, registers. */
const APP_SUPPLIED_FUNCTIONS = [
	// has_role(token, role) → 1/0, the Roles & Permissions example's authorization hook.
	// Must be deterministic, or the determinism gate rejects the CHECK that calls it.
	createScalarFunction({ name: 'has_role', numArgs: 2, deterministic: true }, () => 1),
];

function markerOf(info: string): Marker | undefined {
	const [lang, marker, ...rest] = info.trim().split(/\s+/);
	const known = MARKERS.find(m => m === marker);
	return lang === 'sql' && rest.length === 0 ? known : undefined;
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
			blocks.push({ name: `${heading} #${n}`, info, marker: markerOf(info), text: token.text });
		}
	});
	return blocks;
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

/**
 * Counts declaration items the parser skipped without meaning anything — `create unique index …`
 * parses as an ignored `create` followed by `unique index …`, and a misspelled item keyword
 * vanishes the same way. Only a count: Quereus leaves an ignored item's `text` empty. The
 * wrapper is a second copy of the one in `applyAppSchema`.
 */
function ignoredItemCount(body: string): number {
	return new Parser().parseAll(`declare schema App {\n${body}\n}`)
		.flatMap(statement => statement.type === 'declareSchema' ? statement.items : [])
		.filter(item => item.type === 'declareIgnored')
		.length;
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

function planOrExplain(db: Database, sql: string): void {
	try {
		db.getPlan(sql);
	} catch (err) {
		throw new Error(`planning \`${sql}\` failed: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
	}
}

async function checkSchemaBody(db: Database, body: string): Promise<void> {
	expect(ignoredItemCount(body), 'items the parser ignored (a `create …` prefix or a misspelled item keyword)').toBe(0);
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
			planOrExplain(db, sql);
		}
	}
	for (const view of app.getAllViews()) {
		planOrExplain(db, `select * from App.${quoteIdentifier(view.name)}`);
	}
}

const blocks = extractBlocks(readFileSync(GUIDE_PATH, 'utf-8'));
const executable = blocks.filter(b => b.marker === 'schema' || b.marker === 'script');

describe('docs/schema-guide.md examples', () => {
	it('marks every fence and contains schema examples', () => {
		const unmarked = blocks.filter(b => b.marker === undefined).map(b => `${b.name}: \`\`\`${b.info}`);
		expect(unmarked, 'fences need `sql schema`, `sql script` or `sql fragment`').toEqual([]);
		expect(blocks.filter(b => b.marker === 'schema').length).toBeGreaterThan(0);
	});

	// A loop rather than `it.each`, whose `$name` interpolation truncates long headings.
	for (const { name, marker, text } of executable) {
		it(`${name} (${marker})`, async () => {
			const db = await guideDatabase();
			try {
				if (marker === 'script') {
					await db.exec(text);
				} else {
					await checkSchemaBody(db, text);
				}
			} finally {
				await db.close();
			}
		});
	}
});
