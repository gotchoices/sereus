<script lang="ts">
	import { onDestroy, onMount } from 'svelte';

	import { apiPost, ApiError } from '../lib/api.js';
	import {
		appState,
		refreshNodeDetail,
		pushToast,
	} from '../lib/state.svelte.js';
	import { hrefFor } from '../lib/router.js';
	import { formatBytes, formatRelativeTime, shortPeerId } from '../lib/format.js';

	import ConfirmDialog from '../components/ConfirmDialog.svelte';
	import LogTail from '../components/LogTail.svelte';

	interface Props { id: string }
	let { id }: Props = $props();

	const app = appState();

	let confirmStop = $state(false);
	let busyAction: string | null = $state(null);
	let pollTimer: ReturnType<typeof setInterval> | undefined;

	const node = $derived(app.nodes.find((n) => n.id === id) ?? null);
	const stats = $derived(app.nodeStats[id] ?? null);

	onMount(() => {
		void refreshNodeDetail(id);
		pollTimer = setInterval(() => void refreshNodeDetail(id), 5_000);
	});

	onDestroy(() => {
		if (pollTimer) clearInterval(pollTimer);
	});

	async function postAction(action: 'start' | 'stop' | 'restart'): Promise<void> {
		busyAction = action;
		try {
			await apiPost(`/api/nodes/${encodeURIComponent(id)}/${action}`);
			pushToast('success', `${action} requested`);
			await refreshNodeDetail(id);
		} catch (err) {
			const code = err instanceof ApiError ? err.code : 'error';
			const msg = err instanceof Error ? err.message : String(err);
			pushToast('error', `${action} failed: ${msg} (${code})`);
		} finally {
			busyAction = null;
		}
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
				<div><dt>Ports</dt><dd>health {node.ports.health} · metrics {node.ports.metrics} · p2p {node.ports.p2p}</dd></div>
				<div><dt>CPU</dt><dd>{stats ? stats.cpu.toFixed(1) + '%' : '—'}</dd></div>
				<div><dt>Memory (RSS)</dt><dd>{formatBytes(stats?.rssBytes)}</dd></div>
			</dl>

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
