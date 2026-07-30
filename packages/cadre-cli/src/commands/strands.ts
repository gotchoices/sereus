import { Command } from 'commander';
import { type CadreNode, type StrandInstance, type StrandRow } from '@serfab/cadre-core';
import {
  withCommonOptions,
  runSubcommand,
  reportPlan,
  type CommonOptions,
  type PlanReport,
} from './subcommand.js';

/**
 * Operator surface for `CadreControl.Strand` — the shared networks this party belongs to.
 *
 * `list` reports what this node is currently running; `remove` deletes the party's row, which
 * every cadre node in the party observes and stops its own instance for. Removal is
 * owner-signed, so it needs a config whose identity key is an enrolled `OwnerKey`.
 *
 * Like `validation-key`, `remove` READS the row before writing: the write itself cannot tell
 * "was not published" from "removed" (the database treats both as a silent no-op), and the
 * consequence of removing a CLOSED strand — the membership key in that row is destroyed and
 * exists nowhere else — has to be stated before it happens, not after.
 */

interface RemoveOptions extends CommonOptions {
  yes?: boolean;
}

/** What `remove` decided to do, and what to tell the operator. */
export interface StrandRemovalPlan extends PlanReport {
  /** The trimmed strand id the plan is about — what gets removed, and what gets printed. */
  strandId: string;
  /** Whether the removal still has to happen; false when the read already settled it. */
  write: boolean;
  json: {
    strandId: string;
    published: boolean;
    type?: 'o' | 'c';
    changed: boolean;
    refused?: boolean;
    reason?: string;
  };
}

/**
 * The caveat on "not published". Control reads are pull-on-read against this node's own
 * replica with no wait, so a one-shot command that has only just connected can legitimately
 * not see a row that exists in the party. Saying so keeps "nothing to do" from reading as
 * "the strand does not exist".
 */
const NOT_PUBLISHED_WARNINGS = [
  "⚠ That is this node's view of the control database, read without waiting for sync. A node",
  '  that has only just connected may not have replicated a row that does exist in the party.',
];

/** Warnings that accompany every successful removal, whatever the strand's type. */
const REMOVAL_WARNINGS = [
  '⚠ Removal is party-wide: every cadre node in this party stops running this strand.',
  '  Other parties in the strand are unaffected — this removes our participation only.',
  '⚠ If this node currently has no control-network connections, the deletion is local-only',
  '  and may not reach sibling nodes when they come back (see "Delete-while-alone',
  '  durability" in docs/architecture.md).',
];

/** The extra warning a closed strand earns: the removal destroyed a secret. */
const CLOSED_STRAND_WARNINGS = [
  '⚠ This was a closed strand. Its membership key is gone and unrecoverable, so this party',
  '  can never admit another member to that strand.',
];

/**
 * Decide what `remove` does, given the row as read (or null when the strand is not published).
 *
 * A closed strand without `--yes` is REFUSED rather than removed: the row carries this party's
 * membership key for that network and it is stored nowhere else, so the operator has to say
 * out loud that destroying it is the intent. `--yes` is not a prompt substitute — these
 * commands run non-interactively in scripts and under agents, where a prompt reading EOF would
 * either hang or silently proceed.
 */
export function planRemove(
  row: StrandRow | null,
  strandId: string,
  options: { yes?: boolean }
): StrandRemovalPlan {
  if (!row) {
    return {
      strandId,
      write: false,
      json: { strandId, published: false, changed: false },
      human: `• Strand not published — nothing to do: ${strandId}`,
      warnings: NOT_PUBLISHED_WARNINGS,
    };
  }

  if (row.Type === 'c' && !options.yes) {
    return {
      strandId,
      write: false,
      refuse: true,
      json: {
        strandId,
        published: true,
        type: 'c',
        changed: false,
        refused: true,
        reason: 'closed-strand-requires-yes',
      },
      human: [
        `✗ Refusing to remove closed strand without --yes: ${strandId}`,
        "  Its row carries this party's membership key for that closed network, and the key is",
        '  stored nowhere else. Removing the row destroys it: this party could never admit',
        '  another member to that strand.',
        '  Re-run with --yes if that is what you intend.',
      ].join('\n'),
      warnings: [],
    };
  }

  return {
    strandId,
    write: true,
    json: { strandId, published: true, type: row.Type, changed: true },
    human: `✓ Strand removed: ${strandId}`,
    warnings: row.Type === 'c'
      ? [...REMOVAL_WARNINGS, ...CLOSED_STRAND_WARNINGS]
      : REMOVAL_WARNINGS,
  };
}

/**
 * The slice of {@link CadreNode} `remove` needs. Narrower than the node so the
 * read→decide→write chain can be exercised without standing one up.
 */
export interface StrandStore {
  queryStrand(strandId: string): Promise<StrandRow | null>;
  unpublishStrand(strandId: string): Promise<void>;
}

/**
 * Read the row, decide via {@link planRemove}, unpublish only if the plan says to.
 *
 * The id is trimmed and rejected when blank BEFORE the read: a blank id would otherwise find
 * no row and report the reassuring "nothing to do", when what actually happened is that the
 * operator passed nothing.
 *
 * NOTE: the read and the write are not atomic. A concurrent removal landing in between makes
 * this one a silent no-op — harmless, because the outcome the operator asked for is the
 * outcome they get; the only cost is a "removed" line for a row someone else removed. Don't
 * widen the window trying to close it.
 */
export async function applyRemove(
  store: StrandStore,
  rawStrandId: string,
  options: { yes?: boolean }
): Promise<StrandRemovalPlan> {
  const strandId = rawStrandId.trim();
  if (!strandId) {
    throw new Error('A strand id is required');
  }
  const plan = planRemove(await store.queryStrand(strandId), strandId, options);
  if (plan.write) {
    await store.unpublishStrand(strandId);
  }
  return plan;
}

/**
 * A {@link StrandStore} over a connected node. `getControlDatabase` returns null on a node
 * that never started; that cannot happen inside `withConnectedNode`, but reporting it names
 * the state instead of throwing on a null property access.
 */
function nodeStore(node: CadreNode): StrandStore {
  return {
    queryStrand: async (strandId: string) => {
      const db = node.getControlDatabase();
      if (!db) {
        throw new Error('Node has no control database — it is not started');
      }
      return await db.queryStrand(strandId);
    },
    unpublishStrand: (strandId: string) => node.unpublishStrand(strandId),
  };
}

const listCommand = withCommonOptions(
  new Command('list').description('List active strands')
).action(async (options: CommonOptions) => {
  // NOTE: printed to stdout even under `--json`, so `cadre strand list --json` is not directly
  // pipeable into a JSON parser. Pre-existing behaviour, kept verbatim on purpose; route it to
  // stderr (or suppress it under `--json`) if a caller ever needs to pipe the output.
  console.log('Connecting to control network...');
  await runSubcommand(options, 'Failed to list strands', async (node) => {
    // Force a poll to get current strands
    await node.forceStrandPoll();

    const strands = node.getStrands();

    if (options.json) {
      const data = Array.from(strands.values()).map(formatStrandJson);
      console.log(JSON.stringify(data, null, 2));
    } else {
      console.log('\nActive Strands');
      console.log('─────────────────────────────────────────');

      if (strands.size === 0) {
        console.log('No active strands.');
      } else {
        for (const [strandId, instance] of strands) {
          printStrand(strandId, instance);
        }
      }

      console.log(`\nTotal: ${strands.size} strand(s)`);
    }
  });
});

const removeCommand = withCommonOptions(
  new Command('remove')
    .description("Remove a strand party-wide: delete this party's Strand row (owner-signed)")
    .argument('<strandId>', 'Strand id to remove')
    .option('--yes', 'Confirm removal of a closed strand, destroying its membership key')
).action(async (strandId: string, options: RemoveOptions) => {
  await runSubcommand(options, 'Failed to remove strand', async (node) =>
    reportPlan(options, await applyRemove(nodeStore(node), strandId, options))
  );
});

export const strandCommand = new Command('strand')
  .alias('strands')
  .description('Inspect and remove the strands this party belongs to')
  .addCommand(listCommand)
  .addCommand(removeCommand);

function printStrand(strandId: string, instance: StrandInstance): void {
  const statusIcon = {
    starting: '⋯',
    active: '●',
    idle: '○',
    hibernating: '◦',
    stopping: '⋯',
    stopped: '○',
    error: '✗',
  }[instance.status] ?? '?';

  console.log(`\n${statusIcon} ${strandId}`);
  console.log(`  Status:       ${instance.status}`);
  console.log(`  Latency Hint: ${instance.latencyHint}`);
  console.log(`  Peers:        ${instance.connectedPeers}`);
  console.log(`  Last Activity: ${instance.lastActivity.toISOString()}`);

  if (instance.sAppInfo) {
    console.log(`  sApp ID:      ${instance.sAppInfo.id}`);
    console.log(`  sApp Version: ${instance.sAppInfo.version}`);
  }

  if (instance.error) {
    console.log(`  Error:        ${instance.error}`);
  }
}

function formatStrandJson(instance: StrandInstance): object {
  return {
    strandId: instance.strandId,
    status: instance.status,
    latencyHint: instance.latencyHint,
    connectedPeers: instance.connectedPeers,
    lastActivity: instance.lastActivity.toISOString(),
    sAppInfo: instance.sAppInfo,
    error: instance.error,
  };
}
