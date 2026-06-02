<script lang="ts">
	import { apiFetch } from '../lib/api.js';
	import { pushToast } from '../lib/state.svelte.js';
	import RefreshIcon from './icons/RefreshIcon.svelte';

	interface Props {
		nodeId: string;
		lines?: number;
	}

	const { nodeId, lines = 200 }: Props = $props();

	let logLines: string[] = $state([]);
	let loading = $state(false);
	let lastFetchedAt: Date | null = $state(null);

	async function load(): Promise<void> {
		if (!nodeId) return;
		loading = true;
		try {
			const r = await apiFetch<{ lines: string[] }>(
				`/api/nodes/${encodeURIComponent(nodeId)}/logs?lines=${lines}`,
			);
			logLines = r.lines;
			lastFetchedAt = new Date();
		} catch (err) {
			pushToast('error', `Logs unavailable: ${(err as Error).message}`);
		} finally {
			loading = false;
		}
	}

	$effect(() => {
		// Reload when the id changes.
		void load();
	});
</script>

<div class="card log-card">
	<div class="header">
		<h3>Recent logs</h3>
		<div class="row">
			{#if lastFetchedAt}
				<span class="muted small">as of {lastFetchedAt.toLocaleTimeString()}</span>
			{/if}
			<button onclick={load} disabled={loading} class="ghost" aria-label="Refresh logs">
				<RefreshIcon /> Refresh
			</button>
		</div>
	</div>
	{#if logLines.length === 0}
		<p class="muted">{loading ? 'Loading…' : 'No log lines yet.'}</p>
	{:else}
		<pre class="logs">{logLines.join('\n')}</pre>
	{/if}
</div>

<style>
	.log-card { display: flex; flex-direction: column; gap: var(--space-3); }
	.header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-3);
	}
	.logs {
		max-height: 24rem;
		font-size: 0.78rem;
		line-height: 1.45;
		white-space: pre;
	}
	.small { font-size: 0.85rem; }
	button { display: inline-flex; align-items: center; gap: 0.375rem; }
</style>
