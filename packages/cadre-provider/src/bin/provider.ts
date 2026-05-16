#!/usr/bin/env node

/**
 * CLI entrypoint for the Cadre Provider service.
 */

import { Command } from 'commander';
import debug from 'debug';
import { loadConfig } from '../config/index.js';
import { createProviderServer } from '../server/server.js';

const log = debug('cadre:provider:cli');

const program = new Command();

program
  .name('cadre-provider')
  .description('Sereus Cadre Provider Service - host cadre nodes for users')
  .version('0.0.1');

program
  .command('start')
  .description('Start the provider server')
  .option('-c, --config <path>', 'Path to config file (YAML or JSON)')
  .option('-p, --port <port>', 'Server port (overrides config)')
  .option('-d, --debug', 'Enable debug logging')
  .action(async (options) => {
    if (options.debug) {
      debug.enable('cadre:*,sereus:*');
    }

    console.log('Starting Cadre Provider service...');
    log('Options: %O', options);

    try {
      // Load configuration
      const config = loadConfig({
        configFile: options.config,
        overrides: options.port
          ? { server: { port: parseInt(options.port, 10) } }
          : undefined,
      });

      // Create and start server
      const server = await createProviderServer({ config });

      // Handle graceful shutdown via the single sequence on the server
      process.on('SIGINT', () => server.requestShutdown('signal: SIGINT'));
      process.on('SIGTERM', () => server.requestShutdown('signal: SIGTERM'));

      await server.start();

    } catch (error) {
      console.error('Failed to start provider service:', error instanceof Error ? error.message : error);
      log('Error details: %O', error);
      process.exit(1);
    }
  });

program
  .command('check')
  .description('Validate configuration without starting')
  .option('-c, --config <path>', 'Path to config file (YAML or JSON)')
  .action(async (options) => {
    try {
      const config = loadConfig({ configFile: options.config });
      console.log('Configuration is valid:');
      console.log(JSON.stringify(config, null, 2));
    } catch (error) {
      console.error('Configuration error:', error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

program.parse();

