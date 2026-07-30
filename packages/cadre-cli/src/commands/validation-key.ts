import { Command } from 'commander';
import {
  withCommonOptions,
  runSubcommand,
  reportPlan,
  type CommonOptions,
  type PlanReport,
} from './subcommand.js';

/**
 * Operator surface for `CadreControl.ValidationKey` — the set of outside approver keys this
 * party trusts to sign off on people joining its networks.
 *
 * An invitation carrying a validation URL is only redeemable when the approval that comes
 * back from that URL is signed by one of these keys, so a party with none enrolled cannot
 * use validation-gated invitations at all.
 *
 * Each write subcommand READS the enrolled set first and decides what to do from it
 * ({@link planAdd} / {@link planRemove}), rather than writing blind and interpreting the
 * failure: a duplicate enrollment would otherwise surface as a raw primary-key constraint
 * whose text means nothing to an operator, and a removal has no way at all to distinguish
 * "was not enrolled" from "removed" — the database treats both as a silent no-op.
 */

/** What a read-then-write subcommand decided to do, and what to tell the operator. */
export interface ValidationKeyPlan extends PlanReport {
  /** The trimmed key the plan is about — what gets written, and what gets printed. */
  key: string;
  /** Whether the write still has to happen; false when the read already settled it. */
  write: boolean;
  json: { key: string; enrolled: boolean; changed: boolean; wasLastKey?: boolean };
}

/**
 * Decide what `add` does, given the currently enrolled set. Trims the key so the comparison
 * is against the same bytes `CadreNode.enrollValidationKey` would write.
 */
export function planAdd(enrolled: readonly string[], rawKey: string): ValidationKeyPlan {
  const key = rawKey.trim();
  if (enrolled.includes(key)) {
    return {
      key,
      write: false,
      json: { key, enrolled: true, changed: false },
      human: `• Approver key already enrolled: ${key}`,
      warnings: [],
    };
  }
  return {
    key,
    write: true,
    json: { key, enrolled: true, changed: true },
    human: `✓ Approver key enrolled: ${key}`,
    warnings: [],
  };
}

/**
 * Decide what `remove` does, given the currently enrolled set.
 *
 * Removing the LAST enrolled key makes every outstanding validation-gated invitation
 * unredeemable until a new one is enrolled, so that case carries a warning — rotation is
 * add-then-remove, in that order.
 */
export function planRemove(enrolled: readonly string[], rawKey: string): ValidationKeyPlan {
  const key = rawKey.trim();
  if (!enrolled.includes(key)) {
    return {
      key,
      write: false,
      json: { key, enrolled: false, changed: false },
      human: `• Approver key not enrolled — nothing to do: ${key}`,
      warnings: [],
    };
  }
  const wasLastKey = enrolled.length === 1;
  return {
    key,
    write: true,
    json: { key, enrolled: false, changed: true, wasLastKey },
    human: `✓ Approver key removed: ${key}`,
    warnings: wasLastKey
      ? [
        '⚠ That was the last enrolled approver key. Every outstanding invitation that',
        '  requires outside approval is now unredeemable until a key is enrolled.',
        '  Rotation is add-then-remove, in that order.',
      ]
      : [],
  };
}

/** The human rendering of `list` — one key per line, or a stated empty set. */
export function formatKeyList(keys: readonly string[]): string {
  return keys.length === 0 ? 'No approver keys enrolled.' : keys.join('\n');
}

/**
 * The slice of `CadreNode` these subcommands need. Narrower than the node so the
 * read→decide→write chain can be exercised without standing one up.
 */
export interface ValidationKeyStore {
  listValidationKeys(): Promise<string[]>;
  enrollValidationKey(key: string): Promise<void>;
  removeValidationKey(key: string): Promise<void>;
}

/**
 * Read the enrolled set, decide via {@link planAdd}, enroll only if the plan says to.
 *
 * NOTE: the read and the write are not atomic. A second enroller landing the same key in
 * between makes this one fail on the raw primary-key constraint instead of reporting
 * "already enrolled". Harmless for a human at a terminal; if enrollment ever gets driven
 * concurrently (a host UI, a provisioning script), catch that constraint and map it to the
 * already-enrolled outcome rather than widening the window.
 */
export async function applyAdd(store: ValidationKeyStore, key: string): Promise<ValidationKeyPlan> {
  const plan = planAdd(await store.listValidationKeys(), key);
  if (plan.write) {
    await store.enrollValidationKey(plan.key);
  }
  return plan;
}

/** Read the enrolled set, decide via {@link planRemove}, remove only if the plan says to. */
export async function applyRemove(store: ValidationKeyStore, key: string): Promise<ValidationKeyPlan> {
  const plan = planRemove(await store.listValidationKeys(), key);
  if (plan.write) {
    await store.removeValidationKey(plan.key);
  }
  return plan;
}

const addCommand = withCommonOptions(
  new Command('add')
    .description('Enroll an approver public key (base64url) allowed to sign off on invitation redemptions')
    .argument('<key>', 'Approver public key (base64url)')
).action(async (key: string, options: CommonOptions) => {
  await runSubcommand(options, 'Failed to enroll approver key', async (node) =>
    reportPlan(options, await applyAdd(node, key))
  );
});

const removeCommand = withCommonOptions(
  new Command('remove')
    .description('Remove an approver public key')
    .argument('<key>', 'Approver public key (base64url)')
).action(async (key: string, options: CommonOptions) => {
  await runSubcommand(options, 'Failed to remove approver key', async (node) =>
    reportPlan(options, await applyRemove(node, key))
  );
});

const listCommand = withCommonOptions(
  new Command('list').description('List enrolled approver keys')
).action(async (options: CommonOptions) => {
  await runSubcommand(options, 'Failed to list approver keys', async (node) => {
    const keys = await node.listValidationKeys();
    console.log(options.json ? JSON.stringify(keys, null, 2) : formatKeyList(keys));
  });
});

export const validationKeyCommand = new Command('validation-key')
  .description('Manage the approver keys allowed to sign off on invitation redemptions')
  .addCommand(addCommand)
  .addCommand(removeCommand)
  .addCommand(listCommand);
