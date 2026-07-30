import { Command } from 'commander';
import debug from 'debug';
import type { CadreNode } from '@serfab/cadre-core';
import { withConnectedNode } from './node-session.js';

const log = debug('cadre:cli:validation-key');

/**
 * Operator surface for `CadreControl.ValidationKey` — the set of outside approver keys this
 * party trusts to sign off on people joining its networks.
 *
 * An invitation carrying a validation URL is only redeemable when the approval that comes
 * back from that URL is signed by one of these keys, so a party with none enrolled cannot
 * use validation-gated invitations at all.
 */

interface CommonOptions {
  config: string;
  json?: boolean;
  debug?: boolean;
}

/** Apply the shared `-c/--json/-d` options to a subcommand. */
function withCommonOptions(command: Command): Command {
  return command
    .option('-c, --config <path>', 'Path to config file (YAML or JSON)', 'cadre.yaml')
    .option('--json', 'Output in JSON format')
    .option('-d, --debug', 'Enable debug logging');
}

/**
 * Shared body for every subcommand: enable debug logging, run `action` against a connected
 * node, and turn any failure into a one-line stderr message plus a non-zero exit.
 *
 * The `failure` prefix names the attempted operation so the operator sees which half of an
 * add-then-remove rotation failed.
 */
async function runSubcommand(
  options: CommonOptions,
  failure: string,
  action: (node: CadreNode) => Promise<void>
): Promise<void> {
  if (options.debug) {
    debug.enable('cadre:*,sereus:*');
  }

  try {
    await withConnectedNode(options.config, action);
    process.exit(0);
  } catch (error) {
    console.error(`${failure}:`, error instanceof Error ? error.message : error);
    log('Error details: %o', error);
    process.exit(1);
  }
}

const addCommand = withCommonOptions(
  new Command('add')
    .description('Enroll an approver public key (base64url) allowed to sign off on invitation redemptions')
    .argument('<key>', 'Approver public key (base64url)')
).action(async (key: string, options: CommonOptions) => {
  await runSubcommand(options, 'Failed to enroll approver key', async (node) => {
    const target = key.trim();
    // Read first: `Key` is the primary key and `StampId` is unique, so a duplicate
    // enrollment fails on a constraint whose raw text means nothing to an operator.
    if ((await node.listValidationKeys()).includes(target)) {
      printResult(options, { key: target, enrolled: true, changed: false },
        `• Approver key already enrolled: ${target}`);
      return;
    }

    await node.enrollValidationKey(target);
    printResult(options, { key: target, enrolled: true, changed: true },
      `✓ Approver key enrolled: ${target}`);
  });
});

const removeCommand = withCommonOptions(
  new Command('remove')
    .description('Remove an approver public key')
    .argument('<key>', 'Approver public key (base64url)')
).action(async (key: string, options: CommonOptions) => {
  await runSubcommand(options, 'Failed to remove approver key', async (node) => {
    const target = key.trim();
    // Read first: removal of an absent key is a silent no-op in the database, and removing
    // the LAST key makes every outstanding validation-gated invitation unredeemable until a
    // new key is enrolled — the operator must be told which of the two just happened.
    const before = await node.listValidationKeys();
    if (!before.includes(target)) {
      printResult(options, { key: target, enrolled: false, changed: false },
        `• Approver key not enrolled — nothing to do: ${target}`);
      return;
    }

    await node.removeValidationKey(target);

    const lastKey = before.length === 1;
    printResult(options, { key: target, enrolled: false, changed: true, wasLastKey: lastKey },
      `✓ Approver key removed: ${target}`);
    if (lastKey && !options.json) {
      console.warn('⚠ That was the last enrolled approver key. Every outstanding invitation that');
      console.warn('  requires outside approval is now unredeemable until a key is enrolled.');
      console.warn('  Rotation is add-then-remove, in that order.');
    }
  });
});

const listCommand = withCommonOptions(
  new Command('list').description('List enrolled approver keys')
).action(async (options: CommonOptions) => {
  await runSubcommand(options, 'Failed to list approver keys', async (node) => {
    const keys = await node.listValidationKeys();

    if (options.json) {
      console.log(JSON.stringify(keys, null, 2));
      return;
    }
    if (keys.length === 0) {
      console.log('No approver keys enrolled.');
      return;
    }
    for (const key of keys) {
      console.log(key);
    }
  });
});

/** One-line human confirmation, or the same fact as JSON under `--json`. */
function printResult(options: CommonOptions, json: object, human: string): void {
  console.log(options.json ? JSON.stringify(json, null, 2) : human);
}

export const validationKeyCommand = new Command('validation-key')
  .description('Manage the approver keys allowed to sign off on invitation redemptions')
  .addCommand(addCommand)
  .addCommand(removeCommand)
  .addCommand(listCommand);
