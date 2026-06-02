const { execSync } = require('child_process');
const fs = require('fs');
const { join } = require('path');
const { pathToFileURL } = require('url');

const rootDir = join(__dirname, '..');
const packageName = process.argv[2];

if (!packageName) {
	console.error('Usage: node scripts/publish-package.js <package-name>');
	process.exit(1);
}

const packageDir = join(rootDir, 'packages', packageName);

/**
 * Read PROD_KEY_BASE64 straight from source and decide placeholder-ness — the
 * fallback when the built export isn't available. Honors CADRE_HOST_UPDATE_DEV_KEY
 * with the same precedence as the runtime `isPlaceholderReleaseKey`.
 */
function sourceKeyIsPlaceholder(dir) {
	const srcPath = join(dir, 'src', 'update', 'release-key.ts');
	const src = fs.readFileSync(srcPath, 'utf8');
	const match = /const PROD_KEY_BASE64 = '([^']*)';/.exec(src);
	if (!match) {
		throw new Error(`Could not locate PROD_KEY_BASE64 in ${srcPath} to verify the release key`);
	}
	const override = (process.env.CADRE_HOST_UPDATE_DEV_KEY || '').trim();
	const effective = override.length > 0 ? override : match[1];
	const raw = Buffer.from(effective, 'base64');
	return raw.length === 32 && raw.every((b) => b === 0);
}

/** Prefer the built export; fall back to a source read if dist isn't present. */
async function embeddedKeyIsPlaceholder(dir) {
	const distEntry = join(dir, 'dist', 'index.js');
	if (fs.existsSync(distEntry)) {
		const mod = await import(pathToFileURL(distEntry).href);
		if (typeof mod.isPlaceholderReleaseKey === 'function') {
			return mod.isPlaceholderReleaseKey();
		}
	}
	return sourceKeyIsPlaceholder(dir);
}

/**
 * Refuse to ship a cadre-host build whose embedded release key is still the
 * all-zeros placeholder — such a binary rejects every authentic manifest as
 * signature_invalid, making the update flow dead on arrival. The escape hatch
 * CADRE_HOST_ALLOW_PLACEHOLDER_KEY=1 is for internal/test publishes only.
 */
async function assertReleaseKeyEmbedded(dir) {
	if (process.env.CADRE_HOST_ALLOW_PLACEHOLDER_KEY === '1') {
		console.warn('CADRE_HOST_ALLOW_PLACEHOLDER_KEY=1 — skipping release-key placeholder guard.');
		return;
	}
	if (await embeddedKeyIsPlaceholder(dir)) {
		throw new Error(
			'the embedded Ed25519 release key is the all-zeros placeholder.\n' +
			'  Generate a real keypair offline: node packages/cadre-host/scripts/release-keygen.mjs --write-source\n' +
			'  Commit the new PROD_KEY_BASE64, re-sign latest.json, then publish.\n' +
			'  To publish anyway (internal/test only), set CADRE_HOST_ALLOW_PLACEHOLDER_KEY=1.',
		);
	}
}

async function main() {
	process.chdir(packageDir);

	console.log(`Publishing ${packageName}`);

	execSync('yarn clean', { stdio: 'inherit' });
	execSync('yarn build', { stdio: 'inherit' });

	if (packageName === 'cadre-host') {
		await assertReleaseKeyEmbedded(packageDir);
	}

	execSync('yarn npm publish --access public', { stdio: 'inherit' });
}

main().catch((error) => {
	console.error(`Failed to publish ${packageName}:`, error.message);
	process.exit(1);
});
