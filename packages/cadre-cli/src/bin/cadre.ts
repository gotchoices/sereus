#!/usr/bin/env node

import { Command } from 'commander';
import { startCommand } from '../commands/start.js';
import { statusCommand } from '../commands/status.js';
import { enrollCommand } from '../commands/enroll.js';
import { strandCommand } from '../commands/strands.js';
import { validationKeyCommand } from '../commands/validation-key.js';

const program = new Command();

program
  .name('cadre')
  .description('Sereus Cadre Node CLI - manage cadre node instances')
  .version('0.7.1');

program.addCommand(startCommand);
program.addCommand(statusCommand);
program.addCommand(enrollCommand);
program.addCommand(strandCommand);
program.addCommand(validationKeyCommand);

program.parse();

