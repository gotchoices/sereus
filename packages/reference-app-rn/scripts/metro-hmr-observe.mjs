#!/usr/bin/env node

/**
 * metro-hmr-observe.mjs — prints every Metro update that changes code on the phone.
 *
 *   yarn workspace @serfab/reference-app-rn metro:observe [--port 8081] [--host 127.0.0.1]
 *     [--platform android] [--bundle-url <url>]
 *
 * Attaches to an already-running Metro (`yarn start`) as a second HMR client on the
 * same bundle the dev client loads, and prints one timestamped block per update that
 * adds, modifies or deletes modules, listing each module. Empty updates (a watched file
 * changed that is not in the bundle: ticket logs, index databases, docs) print nothing;
 * on the phone they only flash "Refreshing..." and clear LogBox. A modified module that
 * is not a React Refresh boundary (any library or `dist` module) makes the phone reload,
 * logging `[reload] (no reason given)` with `performFullRefresh` as the caller, so a
 * block printed here at the same moment as a reload names the file that caused it.
 * See docs/reference-app-rn.md § Device test runs.
 *
 * The bundle URL comes from the dev server's manifest (what the dev client itself
 * requests), so it matches the phone's graph and joins the phone's HMR group. Joining
 * sends that group one "initial" update: empty unless a change was already in flight,
 * in which case the phone receives the change it was about to receive anyway.
 *
 * If no client has built that bundle yet, Metro answers GraphNotFoundError; the script
 * then fetches the bundle once to create the graph and registers again. It never
 * fetches a bundle whose graph already exists: a bundle request computes the graph's
 * pending changes, and a concurrent one could take a change before the HMR server
 * delivers it to the phone.
 *
 * Under `yarn start:frozen` Metro does not watch files, so nothing is ever printed.
 * Uses Node's global WebSocket (Node 22+).
 */

import { parseArgs } from 'node:util';

const { values: options } = parseArgs({
	options: {
		port: { type: 'string', default: '8081' },
		host: { type: 'string', default: '127.0.0.1' },
		platform: { type: 'string', default: 'android' },
		'bundle-url': { type: 'string' },
	},
});

const origin = `http://${options.host}:${options.port}`;

// ── Output ────────────────────────────────────────────────────────────────

/** Local wall-clock time, formatted like logcat's `MM-DD HH:MM:SS.mmm`, for lining up with it. */
function timestamp() {
	const now = new Date();
	const two = (n) => String(n).padStart(2, '0');
	return `${two(now.getMonth() + 1)}-${two(now.getDate())} ${two(now.getHours())}:${two(now.getMinutes())}:${two(now.getSeconds())}.${String(now.getMilliseconds()).padStart(3, '0')}`;
}

function log(message) {
	console.log(`${timestamp()} ${message}`);
}

/**
 * Module path relative to Metro's server root, from an update entry's `sourceURL`
 * (`http://host:port/<path>.bundle?...`, or with the query JSC-safe-encoded as `//&...`).
 * The source file's extension is replaced by `.bundle` in that URL and cannot be
 * recovered. Parsed as text rather than with `URL`, which would normalize away the
 * leading `../` of a module in a sibling repo such as optimystic. Metro builds the path
 * with the host's separator, so backslashes on Windows are printed as `/`.
 */
function modulePath(sourceURL) {
	const withoutOrigin = sourceURL.replace(/^[a-z]+:\/\/[^/]+\//i, '');
	return withoutOrigin.split(/\/\/&|\?/)[0].replaceAll('\\', '/');
}

function printUpdate(body) {
	const { added, modified, deleted, isInitialUpdate } = body;
	if (added.length + modified.length + deleted.length === 0) return;
	const when = isInitialUpdate ? ' (delivered on attach)' : '';
	log(`update${when}: ${modified.length} modified, ${added.length} added, ${deleted.length} deleted`);
	for (const entry of modified) console.log(`    modified ${modulePath(entry.sourceURL)}`);
	for (const entry of added) console.log(`    added    ${modulePath(entry.sourceURL)}`);
	if (deleted.length > 0) console.log(`    deleted module ids ${deleted.join(', ')}`);
}

// ── Metro ─────────────────────────────────────────────────────────────────

/** The bundle URL the dev client loads, read from the manifest Expo serves at `/`. */
async function resolveBundleUrl() {
	if (options['bundle-url']) return options['bundle-url'];
	const response = await fetch(`${origin}/`, {
		headers: { 'expo-platform': options.platform, accept: 'application/expo+json' },
	});
	if (!response.ok) {
		throw new Error(`manifest request to ${origin}/ failed: HTTP ${response.status}`);
	}
	const manifest = await response.json();
	const url = manifest?.launchAsset?.url;
	if (typeof url !== 'string') {
		throw new Error(`manifest from ${origin}/ has no launchAsset.url`);
	}
	return url;
}

/** Fetches and discards the bundle, which makes Metro build its graph. */
async function buildGraph(bundleUrl) {
	const response = await fetch(bundleUrl);
	await response.arrayBuffer();
	if (!response.ok) {
		throw new Error(`bundle request failed: HTTP ${response.status}`);
	}
}

function register(socket, bundleUrl) {
	socket.send(JSON.stringify({ type: 'register-entrypoints', entryPoints: [bundleUrl] }));
}

/** Handles one HMR server message; returns a promise only while rebuilding a missing graph. */
function handleMessage(socket, bundleUrl, state, message) {
	switch (message.type) {
		case 'bundle-registered':
			log(`attached to ${origin}; printing non-empty updates (Ctrl+C to stop)`);
			return undefined;
		case 'update':
			printUpdate(message.body);
			return undefined;
		case 'error':
			return handleError(socket, bundleUrl, state, message.body);
		default:
			// update-start / update-done bracket every update, empty ones included.
			return undefined;
	}
}

async function handleError(socket, bundleUrl, state, body) {
	if (body?.type === 'GraphNotFoundError' && !state.builtGraph) {
		state.builtGraph = true;
		log('no client has built this bundle yet; building it once, then attaching');
		await buildGraph(bundleUrl);
		register(socket, bundleUrl);
		return;
	}
	log(`Metro reported ${body?.type ?? 'an error'}: ${body?.message ?? JSON.stringify(body)}`);
}

async function main() {
	const bundleUrl = await resolveBundleUrl();
	log(`bundle ${bundleUrl}`);
	const socket = new WebSocket(`ws://${options.host}:${options.port}/hot`);
	const state = { builtGraph: false };
	socket.addEventListener('open', () => register(socket, bundleUrl));
	socket.addEventListener('message', (event) => {
		const pending = handleMessage(socket, bundleUrl, state, JSON.parse(String(event.data)));
		pending?.catch((error) => {
			console.error(error);
			process.exitCode = 1;
			socket.close();
		});
	});
	socket.addEventListener('error', () => {
		log(`HMR socket error (is Metro running on ${origin}?)`);
	});
	socket.addEventListener('close', () => {
		log('Metro closed the HMR socket');
		process.exitCode = process.exitCode || 1;
	});
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
