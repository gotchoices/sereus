import { existsSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export type DetectResult =
	| { available: true; cliPath: string }
	| { available: false; reason: string };

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, '..', '..');

/**
 * Resolves the reference-peer CLI bundle from the sibling optimystic repo.
 * From this file (packages/reference-app-web/e2e/fixtures/) the sibling lives
 * at ../../../../optimystic/packages/reference-peer/...
 */
export function detectOptimysticCli(): DetectResult {
	const repoRoot = resolve(packageRoot, '..', '..');
	const siblingRoot = resolve(repoRoot, '..', 'optimystic');
	if (!existsSync(siblingRoot)) {
		return {
			available: false,
			reason: `optimystic sibling checkout not found at ${siblingRoot}`,
		};
	}
	const pkgRoot = resolve(siblingRoot, 'packages', 'reference-peer');
	if (!existsSync(pkgRoot)) {
		return {
			available: false,
			reason: `optimystic reference-peer package not found at ${pkgRoot}`,
		};
	}
	const cliPath = resolve(pkgRoot, 'dist', 'src', 'cli.js');
	if (!existsSync(cliPath)) {
		return {
			available: false,
			reason: `reference-peer not built (missing ${cliPath}); run \`yarn workspace @optimystic/reference-peer build\``,
		};
	}
	try {
		const stats = statSync(cliPath);
		if (!stats.isFile()) {
			return { available: false, reason: `${cliPath} is not a regular file` };
		}
	} catch (err) {
		return {
			available: false,
			reason: `cannot stat ${cliPath}: ${err instanceof Error ? err.message : String(err)}`,
		};
	}
	return { available: true, cliPath };
}
