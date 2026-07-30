import { Command } from 'commander';
import debug from 'debug';
import { type StrandInstance } from '@serfab/cadre-core';
import { withConnectedNode } from './node-session.js';

const log = debug('cadre:cli:strands');

export const strandsCommand = new Command('strands')
  .description('List active strands')
  .option('-c, --config <path>', 'Path to config file (YAML or JSON)', 'cadre.yaml')
  .option('--json', 'Output in JSON format')
  .option('-d, --debug', 'Enable debug logging')
  .action(async (options) => {
    if (options.debug) {
      debug.enable('cadre:*,sereus:*');
    }

    try {
      console.log('Connecting to control network...');
      await withConnectedNode(options.config, async (node) => {
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
      process.exit(0);

    } catch (error) {
      console.error('Failed to list strands:', error instanceof Error ? error.message : error);
      log('Error details: %o', error);
      process.exit(1);
    }
  });

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

