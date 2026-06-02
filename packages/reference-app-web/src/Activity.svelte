<script lang="ts">
	import { eventsState, clearEvents } from './lib/store.svelte.js';

	const events = eventsState();

	function kindClass(type: string): string {
		if (type.startsWith('control:')) return 'control';
		if (type.startsWith('strand:')) return 'strand';
		if (type.startsWith('seed:')) return 'seed';
		if (type.startsWith('authority')) return 'authority';
		return 'other';
	}
</script>

<section class="page">
	<header class="page-head">
		<h2>Activity</h2>
		<div class="meta">
			<span>{events.list.length} events</span>
			<button type="button" onclick={clearEvents}>Clear</button>
		</div>
	</header>

	<p class="hint">
		CadreNode lifecycle events — control-network connection, strand
		start/stop/error, and seed activity. Newest first.
	</p>

	{#if events.list.length === 0}
		<p class="empty">No events yet.</p>
	{:else}
		<ul class="log" data-testid="event-log">
			{#each events.list as entry, i (entry.ts + ':' + i)}
				<li
					data-testid="event-row"
					data-type={entry.type}
					data-timestamp={entry.ts}
				>
					<span class="badge kind-{kindClass(entry.type)}">{entry.type}</span>
					{#if entry.detail}<code class="detail">{entry.detail}</code>{/if}
					<span class="ts">{new Date(entry.ts).toLocaleTimeString()}</span>
				</li>
			{/each}
		</ul>
	{/if}
</section>

<style>
	.page {
		display: grid;
		gap: 1rem;
	}

	.page-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
	}

	h2 {
		margin: 0;
		font-size: 1.25rem;
		font-weight: 600;
	}

	.meta {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		color: #6c6f76;
		font-size: 0.8125rem;
	}

	.meta button {
		font-size: 0.75rem;
		padding: 0.25rem 0.625rem;
		border: 1px solid #d4d6db;
		border-radius: 0.25rem;
		background: white;
		cursor: pointer;
		font-family: inherit;
	}

	.hint {
		font-size: 0.8125rem;
		color: #6c6f76;
		margin: 0;
	}

	.empty {
		color: #6c6f76;
		font-size: 0.875rem;
	}

	.log {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: 0.25rem;
	}

	.log li {
		display: grid;
		grid-template-columns: 11rem 1fr auto;
		gap: 0.75rem;
		align-items: baseline;
		padding: 0.375rem 0.625rem;
		border: 1px solid #e3e5ea;
		border-radius: 0.375rem;
		background: white;
		font-size: 0.875rem;
	}

	.badge {
		font-size: 0.7rem;
		font-weight: 600;
		letter-spacing: 0.03em;
		padding: 0.0625rem 0.375rem;
		border-radius: 999px;
		text-align: center;
		font-family: ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace;
	}

	.kind-control {
		background: #d3e4fd;
		color: #1c4f9c;
	}
	.kind-strand {
		background: #d8f1e0;
		color: #1f7a3b;
	}
	.kind-seed {
		background: #ffe9b3;
		color: #6b4d00;
	}
	.kind-authority {
		background: #ede0fd;
		color: #5b2c9c;
	}
	.kind-other {
		background: #eef0f4;
		color: #4a4d54;
	}

	.detail {
		font-family: ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace;
		font-size: 0.8125rem;
		color: #4a4d54;
		word-break: break-all;
	}

	.ts {
		font-size: 0.75rem;
		color: #6c6f76;
		white-space: nowrap;
	}
</style>
