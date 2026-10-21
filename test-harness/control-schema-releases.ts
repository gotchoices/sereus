/**
 * Two "releases" of the control schema, built from the baseline fixture
 * `packages/cadre-core/test/fixtures/control-schema/v<baseline>.qsql`, for the suites that start a
 * control store under one release and restart it under another:
 *
 *   - `packages/cadre-core/test/control-store-migration.spec.ts` (one storage, one node at a time);
 *   - `packages/integration-tests/src/scenarios/control-schema-migration-mixed-releases.integration.ts`
 *     (two machines of one party, each on its own release).
 *
 * `packages/cadre-core/test/control-schema-versions.spec.ts` uses its variant helpers only.
 *
 * Both "releases" run the same cadre-core code, so a variant changes nothing a TypeScript writer or
 * reader names: the added column sits on `ValidationKey`, whose only writer lists its columns, the
 * dropped column on `CadrePeer`, which no writer or reader names either, and the CHECK that changes
 * is `OwnerKey.LabelLength`, widened so every label a test writes still passes it.
 *
 * Imported by relative path (see ./package.json). The fixture is read with CRLF normalized to LF
 * so the variants' anchors hold on a CRLF checkout.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const FIXTURE_DIR = new URL('../packages/cadre-core/test/fixtures/control-schema/', import.meta.url);

/** The `OwnerKey` table tag that carries the control schema version (`CONTROL_SCHEMA_VERSION_TAG` in cadre-core). */
const VERSION_TAG = 'sereus.controlSchemaVersion';

const versionClause = (version: number): string => `with tags ("${VERSION_TAG}" = ${version}) `;

/** The whole control schema file of `version`, line endings as LF. */
async function readControlSchemaFixture(version: number): Promise<string> {
	return (await readFile(new URL(`v${version}.qsql`, FIXTURE_DIR), 'utf-8')).replace(/\r\n/g, '\n');
}

/** `text` with the one occurrence of `from` replaced; throws rather than build a variant that changed nothing. */
export function replaceOnce(text: string, from: string, to: string): string {
	const parts = text.split(from);
	if (parts.length !== 2) {
		throw new Error(`variant anchor ${JSON.stringify(from)} occurs ${parts.length - 1} times in the control schema`);
	}
	return parts.join(to);
}

/** `schema`, whose version tag reads `from`, with it at `to`. */
export const atVersion = (schema: string, from: number, to: number): string =>
	replaceOnce(schema, versionClause(from), versionClause(to));

/** `schema`, whose version tag reads `version`, as a release before schema versions wrote it: no tag. */
export const withoutVersion = (schema: string, version: number): string =>
	replaceOnce(schema, versionClause(version), '');

/** `schema` with `items` declared after its last item. */
export const withItems = (schema: string, items: string): string =>
	replaceOnce(schema, '\n}\n\napply schema CadreControl;', `\n${items}}\n\napply schema CadreControl;`);

/** `schema` with one more table, `Legacy`, which no release of the control schema declares. */
export const withLegacyTable = (schema: string): string =>
	withItems(schema, '    table Legacy (Id text primary key);\n');

export interface ControlSchemaReleases {
	/** The baseline fixture: `schemas/control.qsql` as it was at `baselineVersion`. */
	readonly baseline: string;
	readonly baselineVersion: number;
	/**
	 * The release a store under test was written by: the baseline, at the baseline version, plus one
	 * nullable column (`CadrePeer.Obsolete`) that `next` drops.
	 */
	readonly previous: string;
	/**
	 * The next release, at `nextVersion`: `ValidationKey.Note` added (nullable), `OwnerKey.LabelLength`
	 * widened to 96 characters, the `Annotation` table added, and `previous`'s column dropped. Every
	 * change is one the optimystic module applies to the catalog alone.
	 */
	readonly next: string;
	readonly nextVersion: number;
}

/** The releases above, built from the fixture of `baselineVersion`. */
export async function controlSchemaReleases(baselineVersion: number): Promise<ControlSchemaReleases> {
	const baseline = await readControlSchemaFixture(baselineVersion);
	const nextVersion = baselineVersion + 1;
	const previous = replaceOnce(
		baseline,
		'    table CadrePeer (\n        PeerId text primary key,\n',
		'    table CadrePeer (\n        PeerId text primary key,\n        Obsolete text null,\n'
	);
	const withNote = replaceOnce(
		atVersion(baseline, baselineVersion, nextVersion),
		'    table ValidationKey (\n        Key text primary key,\n        StampId text unique,\n',
		'    table ValidationKey (\n        Key text primary key,\n        StampId text unique,\n        Note text null,\n'
	);
	const withWiderLabel = replaceOnce(
		withNote,
		"        -- Never empty: the add digest binds coalesce(Label, ''), so an empty label would sign as none.\n" +
		'        constraint LabelLength check (\n            Label is null or length(Label) between 1 and 64\n',
		"        -- Never empty: the add digest binds coalesce(Label, ''), so an empty label would sign as none.\n" +
		'        constraint LabelLength check (\n            Label is null or length(Label) between 1 and 96\n'
	);
	const next = withItems(withWiderLabel, '    table Annotation (Id text primary key, Body text null);\n');
	return { baseline, baselineVersion, previous, next, nextVersion };
}

/** Write `schema` as `<dir>/<name>.qsql` and return the path, for a node's `schemaPath`. */
export async function writeSchemaFile(dir: string, name: string, schema: string): Promise<string> {
	const path = join(dir, `${name}.qsql`);
	await writeFile(path, schema, 'utf-8');
	return path;
}
