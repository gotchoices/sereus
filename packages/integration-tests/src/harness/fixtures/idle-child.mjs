#!/usr/bin/env node
/**
 * Test fixture: stands in for a real cadre-cli node process spawned by
 * HostProcessOrchestrator. Reads the orchestrator's startup token from
 * CADRE_STARTUP_TOKEN, writes it to the --startup-token-file path so the
 * orchestrator's tokenMatches() liveness check passes, and then sleeps
 * indefinitely until it receives SIGTERM / SIGINT.
 */
import { writeFileSync } from 'node:fs';

const argv = process.argv;
const idx = argv.indexOf('--startup-token-file');
const tokenPath = idx >= 0 ? argv[idx + 1] : undefined;
const token = process.env.CADRE_STARTUP_TOKEN;

if (tokenPath && token) {
  try {
    writeFileSync(tokenPath, token, 'utf8');
  } catch (err) {
    process.stderr.write(`idle-child: failed to write startup token: ${err.message}\n`);
  }
}

const onExit = () => process.exit(0);
process.on('SIGTERM', onExit);
process.on('SIGINT', onExit);

setInterval(() => { /* keep alive */ }, 60_000);
