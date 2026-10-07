<script lang="ts">
	import { onDestroy, onMount } from 'svelte';

	import { apiDelete, apiPost, ApiError } from '../lib/api.js';
	import {
		appState,
		refreshNodeDetail,
		refreshNodes,
		pushToast,
	} from '../lib/state.svelte.js';
	import { hrefFor, navigate } from '../lib/router.js';
	import { formatBytes, formatRelativeTime, shortPeerId } from '../lib/format.js';

	import ConfirmDialog from '../components/ConfirmDialog.svelte';
	import LogTail from '../components/LogTail.svelte';
	import NodeReachabilityCard from '../components/NodeReachabilityCard.svelte';

	interface Props { id: string }
	const { id }: Props = $props();

	const app = appState();

	let confirmStop = $state(false);
	let confirmTerminate = $state(false);
	let busyAction: string | null = $state(null);
	let pollTimer: ReturnType<typeof setInterval> | undefined;
	// A terminate outlives the page if the user leaves mid-request; its
	// follow-ups (restart the poll, navigate) must not act on a page that is gone.
	let destroyed = false;

	const node = $derived(app.nodes.find((n) => n.id === id) ?? null);
	const stats = $derived(app.nodeStats[id] ?? null);
	const reachability = $derived(app.connectivity?.nodes.find((n) => n.nodeId === id) ?? null);

	onMount(() => {
		void refreshNodeDetail(id);
		startPolling();
	});

	onDestroy(() => {
		destroyed = true;
		stopPolling();
	});

	function startPolling(): void {
		pollTimer = setInterval(() => void refreshNodeDetail(id), 5_000);
	}

	function stopPolling(): void {
		if (pollTimer) clearInterval(pollTimer);
		pollTimer = undefined;
	}

	function reportActionFailure(action: string, err: unknown): void {
		const code = err instanceof ApiError ? err.code : 'error';
		const msg = err instanceof Error ? err.message : String(err);
		pushToast('error', `${action} failed: ${msg} (${code})`);
	}

	async function postAction(action: 'start' | 'stop' | 'restart'): Promise<void> {
		busyAction = action;
		try {
			await apiPost(`/api/nodes/${encodeURIComponent(id)}/${action}`);
			pushToast('success', `${action} requested`);
			await refreshNodeDetail(id);
		} catch (err) {
			reportActionFailure(action, err);
		} finally {
			busyAction = null;
		}
	}

	/**
	 * End a donated node through the same loopback admin surface as
	 * `cadre-host grant terminate`. A terminated node leaves `/api/nodes`, so the
	 * poll is paused for the request — a tick landing after the teardown would
	 * toast "not found" — and the page leaves for the list on success.
	 */
	async function terminate(): Promise<void> {
		busyAction = 'terminate';
		stopPolling();
		try {
			await apiDelete(`/grants-admin/donations/${encodeURIComponent(id)}`);
		} catch (err) {
			reportActionFailure('terminate', err);
			if (!destroyed) startPolling();
			busyAction = null;
			return;
		}
		pushToast('success', `Terminated donated node ${id}`);
		await refreshNodes();
		if (!destroyed) navigate(hrefFor('nodes'));
	}
</script>

<section class="stack">
	<header class="row">
		<a href={hrefFor('nodes')} class="back">← Back to nodes</a>
	</header>

	{#if !node}
		<div class="card">
			<p class="muted">Loading node {id}…</p>
		</div>
	{:else}
		<div class="card">
			<div class="page-header">
				<div>
					<h2><code>{node.id}</code></h2>
					<p class="muted">{node.profile} · party <code title={node.partyId}>{shortPeerId(node.partyId)}</code></p>
				</div>
				<span class={`badge ${node.status === 'running' ? 'ok' : 'err'}`}>
					{node.status}
				</span>
			</div>

			<dl class="kv">
				<div><dt>Workdir</dt><dd><code>{node.workdir || '—'}</code></dd></div>
				<div><dt>Spawned</dt><dd>{formatRelativeTime(node.spawnedAt)}</dd></div>
				<div><dt>Ports</dt><dd>health {node.ports.health} · metrics {node.ports.metrics} · p2p {node.ports.p2p} · ws {node.ports.ws}</dd></div>
				<div><dt>CPU</dt><dd>{stats ? stats.cpuPercent.toFixed(1) + '%' : '—'}</dd></div>
				<div><dt>Memory (RSS)</dt><dd>{formatBytes(stats?.memoryBytes)}</dd></div>
			</dl>

			<!-- Only the owner node has a lifecycle here; a donated node's belongs to its grant. -->
			{#if node.owner && app.role === 'founder'}
				<div class="actions">
					<button
						disabled={busyAction !== null || node.status === 'running'}
						onclick={() => postAction('start')}
					>
						{busyAction === 'start' ? 'Starting…' : 'Start'}
					</button>
					<button
						disabled={busyAction !== null || node.status === 'running'}
						onclick={() => postAction('restart')}
					>
						{busyAction === 'restart' ? 'Restarting…' : 'Restart'}
					</button>
					<button
						class="danger"
						disabled={busyAction !== null || node.status !== 'running'}
						onclick={() => (confirmStop = true)}
					>
						Stop
					</button>
				</div>
			{:else if node.owner}
				{#if app.role === 'donor'}
					<p class="muted">Your own cadre is turned off on this machine, so this node is not run here.</p>
				{/if}
			{:else}
				<div class="actions">
					<!-- Enabled even while stopped: a crashed node awaiting respawn is ended the same way. -->
					<button
						class="danger"
						disabled={busyAction !== null}
						onclick={() => (confirmTerminate = true)}
					>
						{busyAction === 'terminate' ? 'Terminating…' : 'Terminate'}
					</button>
				</div>
			{/if}
		</div>

		<div class="card stack">
			<h3>Reachable from outside</h3>
			{#if !app.connectivity}
				<p class="muted">Loading…</p>
			{:else if !reachability}
				<p class="muted">The port mapping table has no entry for this node yet.</p>
			{:else}
				<NodeReachabilityCard node={reachability} connectivity={app.connectivity} />
			{/if}
		</div>

		<LogTail nodeId={node.id} />
	{/if}
</section>

<ConfirmDialog
	open={confirmStop}
	title="Stop node"
	message={`Stop node ${id}? In-flight requests will be terminated.`}
	confirmLabel="Stop"
	danger
	onConfirm={async () => {
		confirmStop = false;
		await postAction('stop');
	}}
	onCancel={() => (confirmStop = false)}
/>

<ConfirmDialog
	open={confirmTerminate}
	title="Terminate donated node"
	message={`Shut down donated node ${id}? It leaves the borrower's cadre and frees one node slot on their grant; they can ask for another while the grant is valid.`}
	note="The grant itself is untouched; revoke it with: cadre-host grant revoke"
	confirmLabel="Terminate"
	danger
	onConfirm={async () => {
		confirmTerminate = false;
		await terminate();
	}}
	onCancel={() => (confirmTerminate = false)}
/>

<style>
	.back { font-size: 0.92rem; }
	.page-header {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		flex-wrap: wrap;
		gap: var(--space-3);
	}
	.kv {
		margin: var(--space-3) 0;
		display: grid;
		grid-template-columns: max-content 1fr;
		gap: var(--space-1) var(--space-3);
		font-size: 0.92rem;
	}
	.kv > div { display: contents; }
	.kv dt { color: var(--color-text-muted); }
	.kv dd { margin: 0; }
	.actions { display: flex; gap: 0.5rem; flex-wrap: wrap; }
</style>
