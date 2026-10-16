/**
 * `cadre owner-key show|export|import`: the owner key this server holds in its owner key file
 * (`owner-key-file.ts`), as text a person can back up or carry to another device
 * (`docs/architecture.md` → Owner Keys → Exporting and importing an owner key).
 *
 * The file comes from the node's config (`owner.keyFile`, default `<nodeStateDir>/owner.key`), so
 * these commands find the key `cadre start --owner` signs with, and the loader's refusal of an
 * owner key file that is the identity file holds here too.
 *
 * Passphrases come from a file or `CADRE_OWNER_KEY_PASSPHRASE`, never an argument: an argument
 * lands in shell history and the process list.
 */
import fs from 'node:fs';
import { Command } from 'commander';
import debug from 'debug';
import { decodeOwnerKeyExport, encodeOwnerKeyExport, unlockOwnerKeyExport, type OwnerKeyExportContents } from '@serfab/cadre-core';
import { specifiedEnv } from '@serfab/config-check';
import { resolveConfig } from '../config/index.js';
import { commandEnv } from '../config/env.js';
import { importOwnerKeyFile, loadOwnerKeyFile, ownerKeyFingerprint, readOwnerKeyFilePrivateKey } from './owner-key-file.js';
import { modeOpenToOtherAccounts } from './private-file.js';

const log = debug('cadre:cli:owner-key');

interface OwnerKeyFileOptions {
  config: string;
  ownerKeyFile?: string;
}

interface PassphraseOptions {
  passphraseFile?: string;
}

/** The owner key file the config names, with `--owner-key-file` over `owner.keyFile` and `CADRE_OWNER_KEY_FILE`, as for `cadre start`. */
async function ownerKeyFileFor(options: OwnerKeyFileOptions): Promise<string> {
  const env = options.ownerKeyFile ? { ...process.env, CADRE_OWNER_KEY_FILE: options.ownerKeyFile } : process.env;
  return (await resolveConfig(options.config, env)).ownerKeyFile;
}

function noOwnerKey(file: string): Error {
  return new Error(`No owner key file at ${file}: this machine holds no owner key. \`cadre start --owner\` creates one; \`cadre owner-key import\` imports one.`);
}

/**
 * The passphrase from `--passphrase-file` (its text less one trailing line break) or
 * `CADRE_OWNER_KEY_PASSPHRASE`, or `undefined` when neither is given. Both at once is refused,
 * as for the claim secret: each names the passphrase, and a silent choice would hide a stale one.
 */
function resolvePassphrase(passphraseFile: string | undefined, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const fromEnv = specifiedEnv(commandEnv('CADRE_OWNER_KEY_PASSPHRASE', env));
  if (passphraseFile !== undefined && fromEnv !== undefined) {
    throw new Error('--passphrase-file and CADRE_OWNER_KEY_PASSPHRASE are both set: each names the passphrase. Pass one of them.');
  }
  if (passphraseFile === undefined) return fromEnv;
  let text: string;
  try {
    text = fs.readFileSync(passphraseFile, 'utf-8');
  } catch (err) {
    throw new Error(`Cannot read the passphrase from ${passphraseFile}: ${errorMessage(err)}`, { cause: err });
  }
  const passphrase = text.replace(/\r?\n$/, '');
  if (passphrase.length === 0) throw new Error(`${passphraseFile} holds no passphrase`);
  const mode = modeOpenToOtherAccounts(passphraseFile);
  if (mode !== undefined) {
    console.warn(`⚠ ${passphraseFile} is readable by other accounts (mode ${mode.toString(8)}); anyone who reads it can unlock the export. Run: chmod 600 ${passphraseFile}`);
  }
  return passphrase;
}

/** Owner-key text as given: the argument, or stdin when there is none or it is `-`. */
async function exportTextFrom(arg: string | undefined): Promise<string> {
  if (arg !== undefined && arg !== '-') return arg;
  if (process.stdin.isTTY) {
    process.stderr.write('Paste the owner key text, then end input (Ctrl-D; on Windows Ctrl-Z, Enter):\n');
  }
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks).toString('utf-8');
}

/** Read owner-key text, unlocking it when it is locked. */
async function readExport(text: string, passphrase: string | undefined): Promise<OwnerKeyExportContents> {
  const decoded = decodeOwnerKeyExport(text);
  if (!decoded.locked) return decoded;
  if (passphrase === undefined) {
    throw new Error('This owner key is locked with a passphrase: pass --passphrase-file <path> or set CADRE_OWNER_KEY_PASSPHRASE.');
  }
  return await unlockOwnerKeyExport(text, passphrase);
}

async function show(options: OwnerKeyFileOptions & { json?: boolean }): Promise<void> {
  const file = await ownerKeyFileFor(options);
  const signer = await loadOwnerKeyFile(file);
  if (!signer) throw noOwnerKey(file);
  const report = { publicKey: signer.publicKey, fingerprint: ownerKeyFingerprint(signer.publicKey), file };
  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  process.stdout.write([
    `Owner key:    ${report.publicKey}`,
    `Fingerprint:  ${report.fingerprint}`,
    `File:         ${report.file}`,
  ].join('\n') + '\n');
}

/**
 * The export text alone on stdout, so `> file` captures exactly what `import` takes; the warning on
 * stderr. Written with `process.stdout.write` and never followed by `process.exit`, as
 * `enroll add` writes its seed.
 */
async function exportKey(options: OwnerKeyFileOptions & PassphraseOptions & { label?: string }): Promise<void> {
  const passphrase = resolvePassphrase(options.passphraseFile);
  const file = await ownerKeyFileFor(options);
  const privateKeyB64 = await readOwnerKeyFilePrivateKey(file);
  if (privateKeyB64 === undefined) throw noOwnerKey(file);
  const text = await encodeOwnerKeyExport({ privateKeyB64, ...(options.label !== undefined ? { label: options.label } : {}), ...(passphrase !== undefined ? { passphrase } : {}) });
  process.stdout.write(`${text}\n`);
  process.stderr.write([
    '⚠ This text is the owner key: whoever holds it is an owner of every cadre that lists the key.',
    passphrase === undefined
      ? '  It is not locked; keep it where only you can read it, or export again with --passphrase-file.'
      : '  It is locked with the passphrase; keep the two apart.',
  ].join('\n') + '\n');
}

async function importKey(textArg: string | undefined, options: OwnerKeyFileOptions & PassphraseOptions): Promise<void> {
  const passphrase = resolvePassphrase(options.passphraseFile);
  const file = await ownerKeyFileFor(options);
  const contents = await readExport(await exportTextFrom(textArg), passphrase);
  const { signer, changed } = await importOwnerKeyFile(file, contents.privateKeyB64);
  const fingerprint = ownerKeyFingerprint(signer.publicKey);
  if (!changed) {
    console.log(`• ${file} already holds owner key ${fingerprint}; nothing changed`);
    return;
  }
  console.log(`✓ Imported owner key ${fingerprint}${contents.label ? ` ("${contents.label}")` : ''} into ${file}`);
  console.warn('⚠ This machine is now an owner of every cadre that lists this key, and anyone who can read that file is too.');
  console.warn('  `cadre start --owner` signs with it.');
}

function fail(err: unknown): void {
  console.error(`✗ ${errorMessage(err)}`);
  log('Error details: %o', err);
  process.exitCode = 1;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The options every `owner-key` subcommand carries. */
function withOwnerKeyFileOptions(command: Command): Command {
  return command
    .option('-c, --config <path>', 'Path to the node\'s config file (YAML or JSON): where owner.keyFile is read', 'cadre.yaml')
    .option('--owner-key-file <path>', 'The owner key file, over the config\'s owner.keyFile and CADRE_OWNER_KEY_FILE');
}

const PASSPHRASE_FILE_HELP = 'File holding the passphrase (env: CADRE_OWNER_KEY_PASSPHRASE); never pass one as an argument';

export const ownerKeyCommand = new Command('owner-key')
  .description('Show, export or import the owner key this server holds (the owner key file, never the node identity)')
  .addCommand(
    withOwnerKeyFileOptions(new Command('show'))
      .description('Print the owner key\'s public key and the 8-character fingerprint the apps show')
      .option('--json', 'Print { publicKey, fingerprint, file }')
      .action(async (options: OwnerKeyFileOptions & { json?: boolean }) => {
        await show(options).catch(fail);
      })
  )
  .addCommand(
    withOwnerKeyFileOptions(new Command('export'))
      .description('Print the owner key as text to back up or import on another device (stdout); whoever holds the text is an owner')
      .option('--passphrase-file <path>', `Lock the export with a passphrase. ${PASSPHRASE_FILE_HELP}`)
      .option('--label <text>', 'Name carried in the export (at most 64 characters), e.g. "paper backup"')
      .action(async (options: OwnerKeyFileOptions & PassphraseOptions & { label?: string }) => {
        await exportKey(options).catch(fail);
      })
  )
  .addCommand(
    withOwnerKeyFileOptions(new Command('import'))
      .description('Store an exported owner key in the owner key file. Refused when the file holds a different key; importing the same key changes nothing')
      .argument('[text]', 'The export text, or - (the default) to read it from stdin, which keeps an unlocked key out of shell history')
      .option('--passphrase-file <path>', `Unlock a locked export. ${PASSPHRASE_FILE_HELP}`)
      .action(async (text: string | undefined, options: OwnerKeyFileOptions & PassphraseOptions) => {
        await importKey(text, options).catch(fail);
      })
  );
