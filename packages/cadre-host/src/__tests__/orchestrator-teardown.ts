/**
 * Shared teardown for the test files that drive a real HostProcessOrchestrator
 * against a stub child script.
 */
import type { HostProcessOrchestrator } from '../orchestrator/host-process-orchestrator.js';
import { isPidAlive } from '../orchestrator/pid-liveness.js';
import { decodeDockerId } from '../orchestrator/types.js';

interface StartedNode {
  containerId: string;
  pid: number;
}

/**
 * Stop and remove every node the given orchestrators hold, then fail if any of
 * their processes is still alive. Empties `orchestrators`.
 *
 * Nodes come from `listNodes()` rather than the state file: two orchestrators
 * over one rootDir each rewrite the whole file from their own memory, so the
 * file can omit a child that one of them still holds.
 */
export async function removeAllNodes(orchestrators: HostProcessOrchestrator[]): Promise<void> {
  try {
    const nodes: StartedNode[] = [];
    const errors: string[] = [];
    for (const orch of orchestrators) {
      await removeNodesOf(orch, nodes, errors);
    }
    const survivors = nodes.filter((n) => isPidAlive(n.pid));
    if (survivors.length === 0) return;
    survivors.forEach((n) => forceKill(n.pid));
    throw new Error(describeSurvivors(survivors, errors));
  } finally {
    orchestrators.length = 0;
  }
}

/** Keeps going past a failed removal so one failure does not strand the rest. */
async function removeNodesOf(orch: HostProcessOrchestrator, nodes: StartedNode[], errors: string[]): Promise<void> {
  for (const node of orch.listNodes()) {
    nodes.push({ containerId: node.id, pid: decodeDockerId(node.dockerId).pid });
    try {
      await orch.removeContainer(node.dockerId);
    } catch (err) {
      errors.push(`${node.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

function forceKill(pid: number): void {
  try {
    process.kill(pid, 'SIGKILL');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ESRCH') throw err;
  }
}

function describeSurvivors(survivors: StartedNode[], errors: string[]): string {
  const names = survivors.map((n) => `${n.containerId} (pid ${n.pid})`).join(', ');
  const causes = errors.length > 0 ? `; removeContainer errors: ${errors.join(' | ')}` : '';
  return `test teardown left child processes running (now force-killed): ${names}${causes}`;
}
