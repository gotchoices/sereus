import type { Command } from 'commander';
import debug from 'debug';
import type { CadreNode } from '@serfab/cadre-core';
import { withConnectedNode } from './node-session.js';

const log = debug('cadre:cli:subcommand');

/**
 * The scaffolding every one-shot command group shares — option wiring, the connect-act-exit
 * body, and plan reporting. Lives here rather than in one command's file so `validation-key`
 * and `strand` cannot drift apart on how `--json` prints or how a failure exits.
 */

/** The options every one-shot subcommand carries. */
export interface CommonOptions {
  config: string;
  json?: boolean;
  debug?: boolean;
}

/**
 * The reportable part of a read-then-decide plan: what the operator sees, in either format.
 *
 * Command-specific plan types extend this with whatever they need to carry out the write
 * (`ValidationKeyPlan.key`, `StrandRemovalPlan.strandId`, both with a `write` flag).
 */
export interface PlanReport {
  /** Machine-readable outcome, printed verbatim under `--json`. */
  json: unknown;
  /** One-line (or short multi-line) human confirmation. */
  human: string;
  /** Operator warnings that accompany the confirmation in human output only. */
  warnings: string[];
  /**
   * The plan declined to act and the command must exit non-zero. Distinct from a thrown
   * error: a refusal is a considered outcome with a structured `json` body, not a failure to
   * report on.
   */
  refuse?: boolean;
}

/** Apply the shared `-c/--json/-d` options to a subcommand. */
export function withCommonOptions(command: Command): Command {
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
 *
 * `action` may return an exit code to leave with; anything falsy means success. That is how a
 * refusal (`PlanReport.refuse`) exits non-zero while still printing its structured body,
 * rather than being thrown and rendered as a `failure:` line.
 *
 * NOTE: `process.exit` does not flush a pipe, so output written just before it can be lost
 * when stdout is piped. Fine at these sizes (a line or two, or a short JSON array, which the
 * write completes synchronously); if a subcommand ever prints a large listing, drain stdout
 * before exiting. Every one-shot command in this package exits the same way — `strand`,
 * `status`, `start` — so a fix belongs across all of them, not here alone.
 */
export async function runSubcommand(
  options: CommonOptions,
  failure: string,
  action: (node: CadreNode) => Promise<number | void>
): Promise<void> {
  if (options.debug) {
    debug.enable('cadre:*,sereus:*');
  }

  try {
    let code = 0;
    await withConnectedNode(options.config, async (node) => {
      code = (await action(node)) ?? 0;
    });
    process.exit(code);
  } catch (error) {
    console.error(`${failure}:`, error instanceof Error ? error.message : error);
    log('Error details: %o', error);
    process.exit(1);
  }
}

/**
 * Report a plan: the JSON outcome under `--json`, otherwise the confirmation + warnings.
 *
 * A refusal's human text goes to stderr — it is the reason for a non-zero exit, not a result.
 * The JSON body always goes to stdout, so a `--json` consumer parses the refusal rather than
 * having to scrape it out of the error stream.
 *
 * @returns the exit code the plan implies, for {@link runSubcommand} to leave with.
 */
export function reportPlan(options: CommonOptions, plan: PlanReport): number {
  if (options.json) {
    console.log(JSON.stringify(plan.json, null, 2));
  } else if (plan.refuse) {
    console.error(plan.human);
  } else {
    console.log(plan.human);
    for (const warning of plan.warnings) {
      console.warn(warning);
    }
  }
  return plan.refuse ? 1 : 0;
}
