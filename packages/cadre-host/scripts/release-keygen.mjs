#!/usr/bin/env node
/**
 * Generate an Ed25519 release keypair for the cadre-host update manifest.
 *
 * OFFLINE OPERATOR TOOL — run from a checkout on an air-gapped / trusted machine.
 * See `--help` (USAGE below) for flags. The private key is the release-signing
 * secret: custody it offline, never commit it. Only the public key is embedded.
 */

import { generateKeyPairSync } from 'node:crypto';
import { existsSync, writeFileSync, readFileSync, renameSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const HERE = dirname(fileURLToPath(import.meta.url));
const RELEASE_KEY_SOURCE = resolve(HERE, '../src/update/release-key.ts');

const USAGE = `Generate an Ed25519 release keypair for the cadre-host update manifest.

  node scripts/release-keygen.mjs [--out <path>] [--write-source]

  --out <path>      Where to write the PKCS#8 PEM private key.
                    Default ./cadre-host-release.key. Refuses to overwrite.
  --write-source    Also embed the new public key into
                    src/update/release-key.ts (PROD_KEY_BASE64), atomically.
  --help            Show this message.

The private key is the release-signing secret: custody it offline, never commit it.
Only the 32-byte public key is embedded in source (safe — it is public).`;

function parse() {
  return parseArgs({
    options: {
      out: { type: 'string', default: './cadre-host-release.key' },
      'write-source': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  }).values;
}

/** Atomically replace the embedded PROD_KEY_BASE64 with a new public key. */
function rewriteSourceKey(publicRawB64) {
  const src = readFileSync(RELEASE_KEY_SOURCE, 'utf8');
  const re = /const PROD_KEY_BASE64 = '[^']*';/;
  if (!re.test(src)) {
    console.error(`Could not find PROD_KEY_BASE64 declaration in ${RELEASE_KEY_SOURCE}`);
    process.exit(1);
  }
  const next = src.replace(re, `const PROD_KEY_BASE64 = '${publicRawB64}';`);
  const tmp = `${RELEASE_KEY_SOURCE}.tmp`;
  writeFileSync(tmp, next, 'utf8');
  renameSync(tmp, RELEASE_KEY_SOURCE);
}

function main() {
  const values = parse();
  if (values.help) {
    console.log(USAGE);
    return;
  }

  const outPath = resolve(values.out);
  if (existsSync(outPath)) {
    console.error(`Refusing to overwrite existing key file: ${outPath}`);
    console.error('Move or delete it first, or pass a different --out path.');
    process.exit(1);
  }

  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pem = privateKey.export({ format: 'pem', type: 'pkcs8' });
  // Strip the 12-byte SPKI DER header to get the raw 32-byte public key.
  const spki = publicKey.export({ format: 'der', type: 'spki' });
  const publicRawB64 = Buffer.from(spki.subarray(12)).toString('base64');

  // `flag: 'wx'` fails if the file exists — a second guard beyond the check above.
  writeFileSync(outPath, pem, { mode: 0o600, flag: 'wx' });

  console.log('Ed25519 release keypair generated.\n');
  console.log(`Public key (raw 32 bytes, base64): ${publicRawB64}`);
  console.log(`Private key (PKCS#8 PEM) written to: ${outPath} (mode 0600)`);

  if (values['write-source']) {
    rewriteSourceKey(publicRawB64);
    console.log(`\nEmbedded the public key into ${RELEASE_KEY_SOURCE} (PROD_KEY_BASE64).`);
    console.log('Review the diff, commit it, then rebuild & publish.');
  } else {
    console.log('\nTo embed this public key, set PROD_KEY_BASE64 in');
    console.log(`  ${RELEASE_KEY_SOURCE}`);
    console.log('or re-run with --write-source.');
  }

  console.log('\n⚠  CUSTODY THE PRIVATE KEY OFFLINE — never commit it, never paste it.');
  console.log('   Anyone holding it can sign releases your nodes will auto-trust.');
  console.log('   Only the public key above is safe to commit.');
}

main();
