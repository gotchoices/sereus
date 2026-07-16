import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { STRAND_SCHEMA } from '../src/strand-schema.js';

/**
 * Drift guard for the security-critical `Strand` membership/RBAC schema.
 *
 * The schema exists as two hand-maintained copies:
 *   - `schemas/strand.qsql`                       — the on-disk canonical artifact
 *     (a full `declare schema Strand { ... }` block, preceded by a comment header,
 *     with NO `apply schema Strand;` line — `apply` is added only at runtime).
 *   - `STRAND_SCHEMA` in `src/strand-schema.ts`   — the embedded runtime copy that
 *     actually runs in React Native / filesystem-less environments. `composeStrand`
 *     wraps it in `declare schema Strand { ... } apply schema Strand;` at runtime.
 *
 * Because this schema gates strand membership, invites, and RBAC writes (the
 * `verify(...)` checks across Header / Invite / ConsumedInvite / Member / MemberPeer /
 * Manager), a one-sided edit is a silent security regression. This test fails the
 * build whenever the two copies drift.
 *
 * This is a deliberate COPY of the shape of `cadre-core`'s
 * `control-schema-drift.spec.ts`, NOT a shared cross-package helper: there are
 * exactly two embedded-schema copies and they live in different packages
 * (`cadre-core` vs. `quereus-plugin-sereus`), which does not justify a shared
 * test-util home. If a THIRD embedded-schema copy ever appears, that tips the
 * balance toward extracting a shared parameterized helper — do that then, not now.
 *
 * Unlike the control guard (which compares whole-file == whole-constant because
 * `CONTROL_SCHEMA` embeds the full `declare ... apply ...`), `STRAND_SCHEMA` holds
 * only the inner table-declaration BODY. So this guard extracts the body strictly
 * inside `declare schema Strand { ... }` from the `.qsql` file — with a real
 * comment/string-aware, brace-matched scanner — and compares that (normalized)
 * against `STRAND_SCHEMA`. A scanner (not a regex) is required because the file's
 * OWN comment header literally contains the text `declare schema Strand { ... }`,
 * which a naive `indexOf`/regex would anchor on, extracting garbage.
 */

// Resolve the repo-root `.qsql` relative to this source file. vitest runs the `.ts`
// under packages/quereus-plugin-sereus/test/, so three levels up reaches the repo
// root (test/ -> quereus-plugin-sereus/ -> packages/ -> root).
const QSQL_URL = new URL('../../../schemas/strand.qsql', import.meta.url);

/**
 * Normalization mirrors the control guard's, tolerating ONLY end-of-line,
 * trailing-horizontal-whitespace, and trailing-newline differences. It deliberately
 * does NOT collapse interior whitespace or strip comments, so any real content change
 * — an altered `verify(...)` arg, a tab-vs-space reindent — still trips the guard.
 *
 * The one delta vs. the control guard is the `^\n+` rule: the body extracted from the
 * `.qsql` file begins with the newline that follows the opening `{`, whereas
 * `STRAND_SCHEMA` begins directly at `    table Header (`. Stripping leading blank
 * LINES (not leading whitespace) lines the two up while preserving the 4-space indent
 * of the first content line — so a real reindent of `table Header` still trips it.
 */
const normalize = (s: string): string =>
	s.replace(/\r\n/g, '\n')      // CRLF -> LF (repo uses core.autocrlf)
		.replace(/[ \t]+$/gm, '') // strip trailing horizontal whitespace per line
		.replace(/^\n+/, '')      // drop leading blank lines (body starts with the \n after `{`)
		.replace(/\n+$/g, '')     // drop trailing blank lines / final newline
		.trimEnd();

/** First 1-based line where the two normalized texts differ, or null if identical. */
function firstDiffLine(
	a: string,
	b: string
): { line: number; a: string; b: string } | null {
	const al = a.split('\n');
	const bl = b.split('\n');
	const max = Math.max(al.length, bl.length);
	for (let i = 0; i < max; i++) {
		if (al[i] !== bl[i]) {
			return { line: i + 1, a: al[i] ?? '<missing line>', b: bl[i] ?? '<missing line>' };
		}
	}
	return null;
}

// ---------------------------------------------------------------------------
// Comment/string-aware extraction of a `declare schema <name> { ... }` body.
//
// Implemented as a tiny tokenizer state machine (decomposed single-purpose
// helpers, NOT one mega-regex) so it cannot be fooled by the `.qsql` file's own
// comment header — which contains the literal text `declare schema Strand { ... }`
// — nor by any future `{`/`}`/anchor that appears inside a comment or string.
// ---------------------------------------------------------------------------

const isWordChar = (c: string): boolean =>
	(c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c === '_';
const isWhitespace = (c: string): boolean => c === ' ' || c === '\t' || c === '\n' || c === '\r';

/** `i` points at `--`; return the index of the terminating newline (or EOF). */
function skipLineComment(src: string, i: number): number {
	let j = i + 2;
	while (j < src.length && src[j] !== '\n') j++;
	return j;
}

/** `i` points at an opening block-comment marker; return the index just past its close (or EOF). */
function skipBlockComment(src: string, i: number): number {
	let j = i + 2;
	while (j < src.length && !src.startsWith('*/', j)) j++;
	return j < src.length ? j + 2 : src.length;
}

/** `i` points at the opening `'`; return the index just past the closing `'`, honoring `''` escapes. */
function skipStringLiteral(src: string, i: number): number {
	let j = i + 1;
	while (j < src.length) {
		if (src[j] === "'") {
			if (src[j + 1] === "'") { j += 2; continue; } // `''` is an escaped quote, stay in string
			return j + 1;
		}
		j++;
	}
	return src.length; // unterminated literal: consume to EOF rather than mis-reading the rest as code
}

/**
 * If a comment or string literal begins at `i`, return the index just past it;
 * otherwise return `i` unchanged. Callers only ever advance over whole comments /
 * strings, so the scan position never lands inside one.
 */
function skipNonCode(src: string, i: number): number {
	if (src.startsWith('--', i)) return skipLineComment(src, i);
	if (src.startsWith('/*', i)) return skipBlockComment(src, i);
	if (src[i] === "'") return skipStringLiteral(src, i);
	return i;
}

/** If `kw` matches at `i`, return the index just past it; else -1. */
function matchKeyword(src: string, i: number, kw: string): number {
	return src.startsWith(kw, i) ? i + kw.length : -1;
}

/** Consume one-or-more whitespace chars from `i`; -1 if there is none. */
function skipRequiredWhitespace(src: string, i: number): number {
	let j = i;
	while (j < src.length && isWhitespace(src[j])) j++;
	return j > i ? j : -1;
}

/** Consume zero-or-more whitespace chars from `i`. */
function skipOptionalWhitespace(src: string, i: number): number {
	let j = i;
	while (j < src.length && isWhitespace(src[j])) j++;
	return j;
}

/**
 * Try to match `declare <ws> schema <ws> <name> <ws?> {` as code tokens starting at
 * `start`. `name` is matched as a complete, case-sensitive identifier (so `Strand`
 * does not match `StrandX`). Returns the index of the `{`, or -1 if no match.
 */
function matchSchemaAnchor(src: string, start: number, name: string): number {
	if (start > 0 && isWordChar(src[start - 1])) return -1; // `declare` must start at a token boundary
	let i = matchKeyword(src, start, 'declare');
	if (i === -1) return -1;
	i = skipRequiredWhitespace(src, i);
	if (i === -1) return -1;
	i = matchKeyword(src, i, 'schema');
	if (i === -1) return -1;
	i = skipRequiredWhitespace(src, i);
	if (i === -1) return -1;
	i = matchKeyword(src, i, name);
	if (i === -1) return -1;
	if (i < src.length && isWordChar(src[i])) return -1; // `name` must be a whole identifier
	i = skipOptionalWhitespace(src, i);
	return src[i] === '{' ? i : -1;
}

/** Index of the first real (non-comment, non-string) `declare schema <name> {`'s `{`, or -1. */
function findSchemaOpenBrace(src: string, name: string): number {
	let i = 0;
	while (i < src.length) {
		const skipped = skipNonCode(src, i);
		if (skipped !== i) { i = skipped; continue; }
		const brace = matchSchemaAnchor(src, i, name);
		if (brace !== -1) return brace;
		i++;
	}
	return -1;
}

/** Given the index of an opening `{`, return the index of its matching `}`, or -1. */
function findMatchingBrace(src: string, openIdx: number): number {
	let depth = 0;
	let i = openIdx;
	while (i < src.length) {
		const skipped = skipNonCode(src, i);
		if (skipped !== i) { i = skipped; continue; }
		const c = src[i];
		if (c === '{') {
			depth++;
		} else if (c === '}') {
			depth--;
			if (depth === 0) return i;
		}
		i++;
	}
	return -1;
}

/**
 * Return the text strictly inside the matching braces of the first real
 * `declare schema <schemaName> { ... }` block. Throws (rather than returning '' and
 * silently "passing" an empty-to-empty compare) if the block is absent or unbalanced.
 */
function extractDeclareSchemaBody(source: string, schemaName: string): string {
	const openIdx = findSchemaOpenBrace(source, schemaName);
	if (openIdx === -1) {
		throw new Error(
			`extractDeclareSchemaBody: could not find a 'declare schema ${schemaName} { ... }' ` +
			`block (outside comments and string literals) in the source`
		);
	}
	const closeIdx = findMatchingBrace(source, openIdx);
	if (closeIdx === -1) {
		throw new Error(
			`extractDeclareSchemaBody: found 'declare schema ${schemaName} {' but no matching '}' (unbalanced braces)`
		);
	}
	return source.slice(openIdx + 1, closeIdx);
}

describe('strand schema drift guard', () => {
	it('embedded STRAND_SCHEMA matches the body of schemas/strand.qsql', async () => {
		const fileContents = await readFile(fileURLToPath(QSQL_URL), 'utf-8');
		const fileBodyNorm = normalize(extractDeclareSchemaBody(fileContents, 'Strand'));
		const embeddedNorm = normalize(STRAND_SCHEMA);

		const diff = firstDiffLine(fileBodyNorm, embeddedNorm);
		const message = diff
			? 'Strand schema drift detected: the embedded STRAND_SCHEMA and the body of ' +
				'schemas/strand.qsql have diverged. Mirror your edit in BOTH ' +
				'packages/quereus-plugin-sereus/src/strand-schema.ts and schemas/strand.qsql.\n' +
				`First difference at line ${diff.line}:\n` +
				`  schemas/strand.qsql (body): ${JSON.stringify(diff.a)}\n` +
				`  strand-schema.ts          : ${JSON.stringify(diff.b)}`
			: 'schemas match';

		expect(embeddedNorm, message).toBe(fileBodyNorm);
	});

	// The remaining tests exercise the extractor against synthetic inputs so the guard
	// can never be silently fooled into comparing the wrong text.

	it('anchors on the real block, not a `declare schema` that only appears in a `--` comment', () => {
		const src = [
			'-- declare schema X { fake body }',
			'declare schema X {',
			'\treal body',
			'}',
		].join('\n');
		const body = extractDeclareSchemaBody(src, 'X');
		expect(body).toContain('real body');
		expect(body).not.toContain('fake');
	});

	it('anchors on the real block, not a `declare schema` inside a `/* */` block comment', () => {
		const src = [
			'/* declare schema X { fake body } */',
			'declare schema X {',
			'\treal body',
			'}',
		].join('\n');
		const body = extractDeclareSchemaBody(src, 'X');
		expect(body).toContain('real body');
		expect(body).not.toContain('fake');
	});

	it('does not treat a `}` inside a `--` line comment as the closing brace', () => {
		const src = [
			'declare schema X {',
			'\t-- a } b',
			'\tbody',
			'}',
		].join('\n');
		const body = extractDeclareSchemaBody(src, 'X');
		expect(body).toContain('-- a } b'); // proves the comment `}` was not the closer
		expect(body).toContain('body');
	});

	it('does not treat a `}` inside a `/* */` block comment as the closing brace', () => {
		const src = [
			'declare schema X {',
			'\ta /* } */ b',
			'\tbody',
			'}',
		].join('\n');
		const body = extractDeclareSchemaBody(src, 'X');
		expect(body).toContain('/* } */');
		expect(body).toContain('body');
	});

	it('does not treat a `}` inside a string literal as the closing brace', () => {
		const src = [
			'declare schema X {',
			"\tv '}'",
			'\tafter',
			'}',
		].join('\n');
		const body = extractDeclareSchemaBody(src, 'X');
		expect(body).toContain("v '}'");
		expect(body).toContain('after');
	});

	it("handles `''` escaping so a brace inside an escaped string literal is not the closer", () => {
		const src = [
			'declare schema X {',
			"\tv 'a''b}c'",
			'\tafter',
			'}',
		].join('\n');
		const body = extractDeclareSchemaBody(src, 'X');
		expect(body).toContain("v 'a''b}c'"); // the `}` lives inside the single `'a''b}c'` literal
		expect(body).toContain('after');
	});

	it('brace-matches nested `{ }` rather than stopping at the first inner `}`', () => {
		const src = [
			'declare schema X {',
			'\ta { nested } b',
			'\tafter',
			'}',
		].join('\n');
		const body = extractDeclareSchemaBody(src, 'X');
		expect(body).toContain('a { nested } b');
		expect(body).toContain('after');
	});

	it('tolerates runs of spaces/newlines between anchor tokens', () => {
		const src = 'declare   schema\n\tX   {\n\tbody\n}';
		const body = extractDeclareSchemaBody(src, 'X');
		expect(body).toContain('body');
	});

	it('matches the schema name as a whole identifier (does not match a longer name)', () => {
		const src = 'declare schema XY {\n\tbody\n}';
		expect(() => extractDeclareSchemaBody(src, 'X')).toThrow(/could not find/);
	});

	it('stops at the matching `}` and never depends on a trailing `apply schema` line', () => {
		const src = [
			'declare schema X {',
			'\tbody',
			'}',
			'apply schema X;',
		].join('\n');
		const body = extractDeclareSchemaBody(src, 'X');
		expect(body).toContain('body');
		expect(body).not.toContain('apply');
	});

	it('throws when the named block is absent rather than returning an empty body', () => {
		const src = 'declare schema Y {\n\tbody\n}';
		expect(() => extractDeclareSchemaBody(src, 'X')).toThrow(/could not find/);
	});

	it('throws when the name appears only inside a comment (no real block)', () => {
		const src = '-- declare schema X { body }\nselect 1;';
		expect(() => extractDeclareSchemaBody(src, 'X')).toThrow(/could not find/);
	});

	it('throws on an unbalanced (never-closed) block', () => {
		const src = 'declare schema X {\n\tbody';
		expect(() => extractDeclareSchemaBody(src, 'X')).toThrow(/unbalanced/);
	});

	it('normalize strips leading blank LINES but preserves the first content line indentation', () => {
		// A reindent of the first content line must still trip the guard, so `^\n+`
		// must drop only blank lines — never the leading spaces of `table Header`.
		expect(normalize('\n\n    table Header (\n')).toBe('    table Header (');
	});
});
