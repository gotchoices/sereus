#!/usr/bin/env node

/**
 * CLI entrypoint for cadre-host — the self-hosted cadre node manager.
 *
 * Subcommands are stubs at this stage. Real implementations land in the
 * sibling tickets (cadre-host-process-orchestrator, cadre-host-trust-circle,
 * cadre-host-nat, cadre-host-installer, cadre-host-local-ui).
 */

import { Command } from 'commander';

const program = new Command();

program
  .name('cadre-host')
  .description('Sereus cadre node manager for self-hosted basement-PC deployments')
  .version('0.6.0');

const subcommands: ReadonlyArray<readonly [string, string]> = [
  ['install', 'Install cadre-host as a system service and run first-run setup'],
  ['start', 'Start cadre-host in the foreground'],
  ['status', 'Show running status of cadre-host and the cadre nodes it manages'],
  ['invite', 'Generate an invite to add a member to the trust circle'],
  ['uninstall', 'Stop and uninstall the cadre-host service'],
];

for (const [name, summary] of subcommands) {
  program
    .command(name)
    .description(summary)
    .action(() => {
      console.log(`cadre-host ${name}: not yet implemented`);
      process.exit(0);
    });
}

program.parse();
