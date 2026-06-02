const { execSync } = require('child_process');
const fs = require('fs');
const { join } = require('path');

const rootDir = join(__dirname, '..');
const packageName = process.argv[2];

if (!packageName) {
	console.error('Usage: node scripts/publish-package.js <package-name>');
	process.exit(1);
}

const packageDir = join(rootDir, 'packages', packageName);

/**
 * Decide whether the embedded release key is still the all-zeros placeholder by
 * reading PROD_KEY_BASE64 straight from source. This is the byte string the
 * build compiles verbatim into `dist`, so it is exactly what ships.
 *
 * Deliberately ignores `CADRE_HOST_UPDATE_DEV_KEY`: that override is a *runtime*
 * dev/CI affordance that never ships in the package, so it has no bearing on
 * what the published binary will trust. (Reusing the runtime
 * `isPlaceholderReleaseKey`, which honors the override, would let a dev key set
 * on the publish/CI machine silently wave the placeholder through.)
 */
function embeddedKeyIsPlaceholder(dir) {
	const srcPath = join(dir, 'src', 'update', 'release-key.ts');
	const src = fs.readFileSync(srcPath, 'utf8');
	const match = /const PROD_KEY_BASE64 = '([^']*)';/.exec(src);
	if (!match) {
		throw new Error(`Could not locate PROD_KEY_BASE64 in ${srcPath} to verify the release key`);
	}
	const raw = Buffer.from(match[1], 'base64');
	return raw.length === 32 && raw.every((b) => b === 0);
}

/**
 * Refuse to ship a cadre-host build whose embedded release key is still the
 * all-zeros placeholder — such a binary rejects every authentic manifest as
 * signature_invalid, making the update flow dead on arrival. The escape hatch
 * CADRE_HOST_ALLOW_PLACEHOLDER_KEY=1 is for internal/test publishes only.
 */
function assertReleaseKeyEmbedded(dir) {
	if (process.env.CADRE_HOST_ALLOW_PLACEHOLDER_KEY === '1') {
		console.warn('CADRE_HOST_ALLOW_PLACEHOLDER_KEY=1 — skipping release-key placeholder guard.');
		return;
	}
	if (embeddedKeyIsPlaceholder(dir)) {
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
		assertReleaseKeyEmbedded(packageDir);
	}

	execSync('yarn npm publish --access public', { stdio: 'inherit' });
}

main().catch((error) => {
	console.error(`Failed to publish ${packageName}:`, error.message);
	process.exit(1);
});
