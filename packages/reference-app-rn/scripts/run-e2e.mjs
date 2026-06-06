#!/usr/bin/env node

/**
 * run-e2e.mjs — Single-command orchestrator for the Maestro e2e suite.
 *
 *   yarn workspace @serfab/reference-app-rn test:e2e
 *
 * Responsibilities:
 *   1. Spawn the drone test fixture (test-fixture/start.mjs)
 *   2. Wait for the fixture's HTTP sidecar to report /health
 *   3. Read test-data.json (written by start.mjs)
 *   4. adb reverse: tunnel emulator localhost ports → host
 *   5. maestro test maestro/flows with env vars from test-data.json
 *   6. Tear down everything on exit (fixture child + adb reverse rules)
 *
 * Env overrides (all optional):
 *   DRONE_WS_PORT    (default 4002)
 *   DRONE_HTTP_PORT  (default 4080)
 *   MAESTRO_APP_ID   (default org.gotchoices.sereus.chat — matches app.json)
 *   MAESTRO_BIN      (default 'maestro' on PATH)
 */

import { spawn } from 'node:child_process';
import { readFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { createWriteStream } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(__dirname, '..');

const DRONE_WS_PORT = process.env.DRONE_WS_PORT ?? '4002';
const DRONE_HTTP_PORT = process.env.DRONE_HTTP_PORT ?? '4080';
const MAESTRO_APP_ID = process.env.MAESTRO_APP_ID ?? 'org.gotchoices.sereus.chat';
const MAESTRO_BIN = process.env.MAESTRO_BIN ?? 'maestro';
const SIDECAR_URL = `http://127.0.0.1:${DRONE_HTTP_PORT}`;
const TEST_DATA_PATH = join(pkgRoot, 'test-fixture', 'test-data.json');
const FIXTURE_LOG_PATH = join(pkgRoot, 'maestro', '.fixture.log');
const JUNIT_PATH = join(pkgRoot, 'maestro', '.maestro-junit.xml');
const FLOWS_DIR = join(pkgRoot, 'maestro', 'flows');

let fixtureProc = null;
let fixtureLogStream = null;
let adbReversed = false;
let shuttingDown = false;

// ── Lifecycle helpers ─────────────────────────────────────────────────────

async function ensureDir(p) {
	await mkdir(p, { recursive: true });
}

function spawnLogged(cmd, args, opts = {}) {
	const proc = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts });
	proc.stdout.on('data', (d) => process.stdout.write(d));
	proc.stderr.on('data', (d) => process.stderr.write(d));
	return proc;
}

function spawnTeed(cmd, args, logPath, opts = {}) {
	const proc = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts });
	const logStream = createWriteStream(logPath);
	proc.stdout.on('data', (d) => {
		process.stdout.write(d);
		logStream.write(d);
	});
	proc.stderr.on('data', (d) => {
		process.stderr.write(d);
		logStream.write(d);
	});
	return { proc, logStream };
}

async function waitForHealth(url, timeoutMs) {
	const start = Date.now();
	let lastErr = null;
	while (Date.now() - start < timeoutMs) {
		try {
			const res = await fetch(`${url}/health`);
			if (res.ok) return;
			lastErr = new Error(`status ${res.status}`);
		} catch (err) {
			lastErr = err;
		}
		await sleep(500);
	}
	throw new Error(
		`Fixture /health did not become ready within ${timeoutMs}ms: ${lastErr?.message ?? 'unknown'}`,
	);
}

function runAdb(args) {
	return new Promise((resolveP) => {
		const p = spawn('adb', args, { stdio: ['ignore', 'pipe', 'pipe'] });
		let stderr = '';
		p.stderr.on('data', (d) => { stderr += d.toString(); });
		p.on('error', (err) => resolveP({ ok: false, error: err.message }));
		p.on('exit', (code) => resolveP({
			ok: code === 0,
			error: code === 0 ? null : (stderr.trim() || `exit ${code}`),
		}));
	});
}

async function setupAdbReverse() {
	const ports = [DRONE_WS_PORT, DRONE_HTTP_PORT];
	for (const port of ports) {
		const r = await runAdb(['reverse', `tcp:${port}`, `tcp:${port}`]);
		if (!r.ok) {
			console.warn(`⚠ adb reverse tcp:${port}: ${r.error}`);
			console.warn('  → continuing without adb reverse (iOS sim or non-emulator?).');
			console.warn(`  → if Android emulator: ensure an emulator is running.`);
			return false;
		}
	}
	console.log(`✓ adb reverse tcp:${DRONE_WS_PORT}, tcp:${DRONE_HTTP_PORT}`);
	return true;
}

async function teardownAdbReverse() {
	if (!adbReversed) return;
	await runAdb(['reverse', '--remove-all']);
}

async function shutdown(exitCode) {
	if (shuttingDown) return;
	shuttingDown = true;
	console.log('\n→ Tearing down…');

	if (fixtureProc) {
		try {
			fixtureProc.kill('SIGTERM');
			await Promise.race([
				new Promise((r) => fixtureProc.once('exit', r)),
				sleep(3000),
			]);
			if (fixtureProc.exitCode === null) {
				console.warn('  fixture did not exit after SIGTERM; sending SIGKILL');
				fixtureProc.kill('SIGKILL');
			}
		} catch (err) {
			console.warn('  fixture teardown error:', err);
		}
	}
	if (fixtureLogStream) {
		try { fixtureLogStream.end(); } catch { /* swallow */ }
	}
	await teardownAdbReverse();

	process.exit(exitCode);
}

process.on('SIGINT', () => void shutdown(130));
process.on('SIGTERM', () => void shutdown(143));
process.on('uncaughtException', (err) => {
	console.error('Uncaught exception:', err);
	void shutdown(1);
});

// ── Main ──────────────────────────────────────────────────────────────────

async function main() {
	await ensureDir(dirname(FIXTURE_LOG_PATH));

	console.log('→ Starting drone fixture…');
	const teed = spawnTeed(
		process.execPath,
		[join(pkgRoot, 'test-fixture', 'start.mjs')],
		FIXTURE_LOG_PATH,
		{
			env: {
				...process.env,
				DRONE_WS_PORT,
				DRONE_HTTP_PORT,
			},
			cwd: pkgRoot,
		},
	);
	fixtureProc = teed.proc;
	fixtureLogStream = teed.logStream;

	fixtureProc.on('exit', (code) => {
		if (!shuttingDown) {
			console.error(`Fixture exited unexpectedly (code ${code}). Aborting.`);
			void shutdown(1);
		}
	});

	console.log(`→ Waiting for fixture /health at ${SIDECAR_URL}…`);
	try {
		await waitForHealth(SIDECAR_URL, 30000);
	} catch (err) {
		console.error('Fixture never became healthy:', err.message);
		await shutdown(1);
		return;
	}
	console.log('✓ Fixture healthy.');

	if (!existsSync(TEST_DATA_PATH)) {
		console.error(`Missing ${TEST_DATA_PATH}. start.mjs failed to write it?`);
		await shutdown(1);
		return;
	}
	const testData = JSON.parse(await readFile(TEST_DATA_PATH, 'utf8'));
	console.log(`✓ Read test-data.json (strandId=${testData.strandId.slice(0, 8)}…)`);

	console.log('→ Setting up adb reverse for emulator…');
	adbReversed = await setupAdbReverse();

	console.log('→ Launching maestro…');
	const maestroEnv = {
		PARTY_ID: testData.partyId,
		BOOTSTRAP_ADDR: testData.droneBootstrapAddr,
		SEED: testData.seed,
		ENROLL_INVITE: testData.enrollInvite,
		STRAND_ID: testData.strandId,
		SIDECAR_URL,
		MAESTRO_APP_ID,
	};

	const envArgs = Object.entries(maestroEnv).flatMap(([k, v]) => ['-e', `${k}=${v}`]);

	const maestroProc = spawnLogged(
		MAESTRO_BIN,
		['test', ...envArgs, '--format', 'junit', '--output', JUNIT_PATH, FLOWS_DIR],
		{ cwd: pkgRoot, env: { ...process.env, ...maestroEnv } },
	);

	maestroProc.on('error', (err) => {
		console.error(`Failed to launch maestro: ${err.message}`);
		console.error('  Install Maestro: https://maestro.mobile.dev/getting-started/installing-maestro');
		void shutdown(1);
	});

	maestroProc.on('exit', (code) => {
		console.log(`\nmaestro exited with code ${code ?? 'null'}`);
		void shutdown(code ?? 1);
	});
}

main().catch(async (err) => {
	console.error('run-e2e failed:', err);
	await shutdown(1);
});
