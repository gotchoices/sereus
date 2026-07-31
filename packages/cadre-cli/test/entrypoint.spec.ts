/**
 * cadre-cli docker entrypoint identity wiring.
 *
 * Verifies the ordering + export fix from provider-container-durable-identity:
 * `create_identity` runs before `generate_config` (so the `identity:` block is
 * written on first start) and `CADRE_KEY_FILE`/`CADRE_NODE_STATE_DIR` are
 * `export`ed (POSIX `sh` never exposes a plain assignment to the `exec`'d
 * child). Runs the real entrypoint.sh under `sh` against a fake `node` stub on
 * PATH — skipped when `sh` is not runnable (e.g. a Windows box without Git
 * Bash).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const entrypointPath = join(dirname(fileURLToPath(import.meta.url)), '../docker/entrypoint.sh');

function shAvailable(): boolean {
  try {
    const result = spawnSync('sh', ['-c', 'echo ok'], { encoding: 'utf8' });
    return result.status === 0;
  } catch {
    return false;
  }
}

/** Windows path -> Git-Bash/MSYS posix form (`C:\foo\bar` -> `/c/foo/bar`). Passing a
 * Windows-style path through `sh -c` args mangles it; only the posix form survives. */
function toPosixPath(winPath: string): string {
  const normalized = winPath.replace(/\\/g, '/');
  const drive = normalized.match(/^([A-Za-z]):(\/.*)$/);
  return drive ? `/${drive[1]!.toLowerCase()}${drive[2]}` : normalized;
}

const NODE_STUB = `#!/bin/sh
# $1 = cadre.js path (ignored, this is a stub); $2 = subcommand.
shift
cmd="$1"
shift
case "$cmd" in
  enroll)
    shift # 'create'
    output=""
    name=""
    while [ $# -gt 0 ]; do
      case "$1" in
        --output) output="$2"; shift 2 ;;
        --name) name="$2"; shift 2 ;;
        *) shift ;;
      esac
    done
    echo "stub-key-material" > "$output/$name.key"
    ;;
  start)
    echo "CHILD_KEY_FILE=\${CADRE_KEY_FILE:-<UNSET>}"
    echo "CHILD_STATE_DIR=\${CADRE_NODE_STATE_DIR:-<UNSET>}"
    ;;
esac
`;

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'cadre-entrypoint-'));
  const binDir = join(tmpRoot, 'bin');
  mkdirSync(binDir, { recursive: true });
  const nodeStub = join(binDir, 'node');
  writeFileSync(nodeStub, NODE_STUB, 'utf8');
  chmodSync(nodeStub, 0o755);
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

/** Run the real entrypoint.sh's `start` branch against the fake node stub. */
function runEntrypointStart(): { status: number | null; stdout: string; stderr: string } {
  const tmpPosix = toPosixPath(tmpRoot);
  const entryPosix = toPosixPath(entrypointPath);
  const outerScript = [
    'set -e',
    'export PATH="$1/bin:$PATH"',
    'export DATA_DIR="$1/data"',
    'export CADRE_PARTY_ID="party-1"',
    'export CADRE_BOOTSTRAP_NODES="/ip4/127.0.0.1/tcp/4001"',
    'sh "$2" start',
  ].join('\n');
  const result = spawnSync('sh', ['-c', outerScript, 'sh', tmpPosix, entryPosix], {
    encoding: 'utf8',
    timeout: 15000,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

// NOTE: a runner without `sh` skips this suite silently rather than failing, so the
// entrypoint's identity wiring would go unguarded there. If CI ever moves to a shell-less
// (plain Windows) runner, make the skip loud — assert `sh` is present on Linux runners.
describe.skipIf(!shAvailable())('cadre-cli docker entrypoint identity wiring', () => {
  it('creates the identity before the config, exports it to the started child, and records it in cadre.yaml', () => {
    const result = runEntrypointStart();
    expect(result.status, `entrypoint failed: ${result.stderr}`).toBe(0);

    const dataDir = join(tmpRoot, 'data');
    const keyFile = join(dataDir, 'cadre-peer.key');
    expect(readFileSync(keyFile, 'utf8')).toBe('stub-key-material\n');

    const keyFilePosix = `${toPosixPath(dataDir)}/cadre-peer.key`;
    expect(result.stdout).toContain(`CHILD_KEY_FILE=${keyFilePosix}`);
    expect(result.stdout).toContain(`CHILD_STATE_DIR=${toPosixPath(dataDir)}`);

    const config = readFileSync(join(dataDir, 'cadre.yaml'), 'utf8');
    expect(config).toContain('identity:');
    expect(config).toContain(`keyFile: ${keyFilePosix}`);
  });

  it('reuses the same key byte-for-byte on a second start against the same data dir', () => {
    const first = runEntrypointStart();
    expect(first.status).toBe(0);

    const keyFile = join(tmpRoot, 'data', 'cadre-peer.key');
    const before = readFileSync(keyFile);

    const second = runEntrypointStart();
    expect(second.status, `entrypoint failed: ${second.stderr}`).toBe(0);
    expect(second.stdout).toContain('Using existing peer identity');
    // The export must survive the config-already-exists path too — generate_config
    // is skipped on every start after the first, so this is the steady state.
    expect(second.stdout).toContain(`CHILD_KEY_FILE=${toPosixPath(join(tmpRoot, 'data'))}/cadre-peer.key`);

    const after = readFileSync(keyFile);
    expect(after).toEqual(before);
  });

  // A container provisioned before the identity wiring landed has a cadre.yaml with
  // no `identity:` block, and generate_config never runs again to add one. The env
  // export is the whole repair: it must reach the child regardless of the config.
  it('exports the identity to the child even when a pre-fix cadre.yaml (no identity block) exists', () => {
    const dataDir = join(tmpRoot, 'data');
    mkdirSync(dataDir, { recursive: true });
    const staleConfig = 'controlNetwork:\n  partyId: "party-1"\n  bootstrapNodes: []\n';
    writeFileSync(join(dataDir, 'cadre.yaml'), staleConfig, 'utf8');

    const result = runEntrypointStart();
    expect(result.status, `entrypoint failed: ${result.stderr}`).toBe(0);

    const dataPosix = toPosixPath(dataDir);
    expect(result.stdout).toContain(`CHILD_KEY_FILE=${dataPosix}/cadre-peer.key`);
    expect(result.stdout).toContain(`CHILD_STATE_DIR=${dataPosix}`);
    // Key minted despite the config being present, and the stale config left as-is.
    expect(readFileSync(join(dataDir, 'cadre-peer.key'), 'utf8')).toBe('stub-key-material\n');
    expect(readFileSync(join(dataDir, 'cadre.yaml'), 'utf8')).toBe(staleConfig);
  });
});
