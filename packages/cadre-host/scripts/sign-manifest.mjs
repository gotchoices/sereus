#!/usr/bin/env node
/**
 * Sign a cadre-host update manifest with the offline release private key.
 *
 * OFFLINE OPERATOR TOOL — run from a checkout where the package is built
 * (`yarn build:server`). Imports the typed signing core from the built package
 * so manifest construction + field validation + the sign/self-verify round-trip
 * all share the exact rules `verifyManifest` enforces at runtime. See `--help`.
 *
 * Emits the `{ manifest, sig }` envelope ready to publish as
 *   https://releases.serfab.io/cadre-host/latest.json
 */

import { createPrivateKey } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { buildManifest, signAndSelfVerify } from '@serfab/cadre-host';

const USAGE = `Sign a cadre-host update manifest with the offline release private key.

  node scripts/sign-manifest.mjs --key <pkcs8.pem> [fields...] [--out <file>]

  --key <path>                 PKCS#8 PEM Ed25519 private key (required).
  --out <file>                 Write the envelope here (default: stdout).

  Manifest source — either a file or individual flags:
  --manifest <file.json>       JSON with manifest fields (flat or full manifest).
  --version <semver>           Released version (e.g. 0.7.0).
  --package <name>             npm package (e.g. @serfab/cadre-host).
  --tag <tag>                  npm dist-tag (default: latest).
  --published-at <iso>         ISO-8601 timestamp (must round-trip exactly).
  --release-notes-url <url>    Optional release-notes URL.
  --min-previous-version <v>   Optional minimum version that can step here.
  --help                       Show this message.`;

function parse() {
  return parseArgs({
    options: {
      key: { type: 'string' },
      manifest: { type: 'string' },
      version: { type: 'string' },
      package: { type: 'string' },
      tag: { type: 'string', default: 'latest' },
      'published-at': { type: 'string' },
      'release-notes-url': { type: 'string' },
      'min-previous-version': { type: 'string' },
      out: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  }).values;
}

function die(message) {
  console.error(message);
  process.exit(1);
}

function loadPrivateKey(path) {
  let pem;
  try {
    pem = readFileSync(resolve(path), 'utf8');
  } catch (err) {
    die(`Cannot read key file ${path}: ${err.message}`);
  }
  try {
    return createPrivateKey({ key: pem, format: 'pem', type: 'pkcs8' });
  } catch (err) {
    die(`Key file is not a valid PKCS#8 PEM private key: ${err.message}`);
  }
}

/** Read manifest fields from a JSON file — accepts flat fields or a full manifest. */
function fieldsFromFile(path) {
  let raw;
  try {
    raw = JSON.parse(readFileSync(resolve(path), 'utf8'));
  } catch (err) {
    die(`Cannot read/parse manifest file ${path}: ${err.message}`);
  }
  const npm = raw.channels?.npm;
  return {
    version: raw.version,
    package: raw.package ?? npm?.package,
    tag: raw.tag ?? npm?.tag ?? 'latest',
    publishedAt: raw.publishedAt,
    releaseNotesUrl: raw.releaseNotesUrl,
    minPreviousVersion: raw.minPreviousVersion,
  };
}

function fieldsFromFlags(values) {
  const missing = [];
  if (!values.version) missing.push('--version');
  if (!values.package) missing.push('--package');
  if (!values['published-at']) missing.push('--published-at');
  if (missing.length) {
    die(`Missing required flag(s): ${missing.join(', ')} (or pass --manifest <file.json>)`);
  }
  return {
    version: values.version,
    package: values.package,
    tag: values.tag ?? 'latest',
    publishedAt: values['published-at'],
    ...(values['release-notes-url'] ? { releaseNotesUrl: values['release-notes-url'] } : {}),
    ...(values['min-previous-version'] ? { minPreviousVersion: values['min-previous-version'] } : {}),
  };
}

function main() {
  const values = parse();
  if (values.help) {
    console.log(USAGE);
    return;
  }
  if (!values.key) {
    die('--key <pkcs8-pem-path> is required (see --help).');
  }

  const privateKey = loadPrivateKey(values.key);
  const fields = values.manifest ? fieldsFromFile(values.manifest) : fieldsFromFlags(values);

  let envelope;
  try {
    // buildManifest validates fields; signAndSelfVerify signs then verifies the
    // signature against the key derived from this private key — both throw loudly.
    const manifest = buildManifest(fields);
    envelope = signAndSelfVerify(manifest, privateKey);
  } catch (err) {
    die(`Failed to sign manifest: ${err.message}`);
  }

  const json = JSON.stringify(envelope, null, 2) + '\n';
  if (values.out) {
    const outPath = resolve(values.out);
    writeFileSync(outPath, json, 'utf8');
    console.error(`Signed manifest written to ${outPath}`);
  } else {
    process.stdout.write(json);
  }
}

main();
