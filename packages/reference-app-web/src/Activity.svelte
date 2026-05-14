<script lang="ts">
	import { onMount } from 'svelte';
	import {
		messagesState,
		ensureReady,
		refresh,
		startPolling,
		stopPolling,
	} from './lib/messages.svelte.js';
	import { nodeState } from './lib/store.svelte.js';

	const msgs = messagesState();
	const node = nodeState();

	$effect(() => {
		if (node.status === 'running') {
			void ensureReady();
		}
	});

	onMount(() => {
		startPolling();
		return () => stopPolling();
	});

	function formatWhen(ms: number): string {
		return new Date(ms).toLocaleString();
	}
</script>

<section class="page">
	<header class="page-head">
		<h2>Activity</h2>
		<div class="meta">
			<span>{msgs.activity.length} entries</span>
			{#if msgs.updatedMs}
				<span>refreshed {new Date(msgs.updatedMs).toLocaleTimeString()}</span>
			{/if}
			<button type="button" onclick={() => void refresh()} disabled={msgs.loading}>
				Refresh
			</button>
		</div>
	</header>

	{#if !msgs.ready}
		<p class="empty">
			{#if node.status === 'running'}
				Connecting to MessageApp…
			{:else}
				Node not running — start it from <a href="#/">Home</a>.
			{/if}
		</p>
	{/if}

	{#if msgs.error}
		<p class="error">{msgs.error}</p>
	{/if}

	{#if msgs.ready && msgs.activity.length === 0}
		<p class="empty">No activity yet. Add a message from the Messages page.</p>
	{/if}

	{#if msgs.ready && msgs.activity.length > 0}
		<ul class="log">
			{#each msgs.activity as entry, i (entry.timestamp + ':' + entry.messageId + ':' + i)}
				<li
					data-testid="activity-row"
					data-message-id={entry.messageId}
					data-action={entry.action}
					data-timestamp={entry.timestamp}
				>
					<span class="badge action-{entry.action}">{entry.action}</span>
					<code class="id">{entry.messageId}</code>
					<span class="ts">{formatWhen(entry.timestamp)}</span>
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

	.empty {
		color: #6c6f76;
		font-size: 0.875rem;
	}

	.error {
		color: #b3261e;
		font-size: 0.8125rem;
		margin: 0;
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
		grid-template-columns: 5rem 1fr auto;
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
		text-transform: uppercase;
		letter-spacing: 0.05em;
		padding: 0.0625rem 0.375rem;
		border-radius: 999px;
		text-align: center;
	}

	.action-created {
		background: #d8f1e0;
		color: #1f7a3b;
	}

	.action-updated {
		background: #d3e4fd;
		color: #1c4f9c;
	}

	.action-deleted {
		background: #fde0dd;
		color: #b3261e;
	}

	.id {
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
