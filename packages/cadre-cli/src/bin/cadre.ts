#!/usr/bin/env node

import { createRequire } from 'node:module';
import { Command } from 'commander';
import { startCommand } from '../commands/start.js';
import { statusCommand } from '../commands/status.js';
import { enrollCommand } from '../commands/enroll.js';
import { strandCommand } from '../commands/strands.js';
import { validationKeyCommand } from '../commands/validation-key.js';

// The version comes from this package's own package.json (dist/bin/ -> ../../), so a release
// bump can never leave it behind (gotchoices/sereus#35).
const { version } = createRequire(import.meta.url)('../../package.json') as { version: string };

const program = new Command();

program
  .name('cadre')
  .description('Sereus Cadre Node CLI - manage cadre node instances')
  .version(version);

program.addCommand(startCommand);
program.addCommand(statusCommand);
program.addCommand(enrollCommand);
program.addCommand(strandCommand);
program.addCommand(validationKeyCommand);

program.parse();

