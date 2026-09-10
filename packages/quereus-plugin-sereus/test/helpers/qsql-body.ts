/**
 * Comment/string-aware extraction of a `declare schema <name> { ... }` body from a
 * `.qsql` artifact.
 *
 * Implemented as a tiny tokenizer state machine (decomposed single-purpose helpers,
 * NOT one mega-regex) so it cannot be fooled by a file's own comment header — which
 * routinely contains the literal text `declare schema Strand { ... }` — nor by any
 * `{`/`}`/anchor that appears inside a comment or string literal.
 *
 * Two callers share it: the `strand-schema-drift` guard (which compares the extracted
 * body against the embedded `STRAND_SCHEMA` constant) and the `chat-schema` e2e suite
 * (which feeds the extracted body to `connectToStrand` as the sApp schema, since
 * `composeStrand` supplies its own `declare schema App { ... }` wrapper).
 */

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
export function extractDeclareSchemaBody(source: string, schemaName: string): string {
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
