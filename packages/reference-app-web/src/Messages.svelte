<script lang="ts">
	import { onMount } from 'svelte';
	import {
		messagesState,
		ensureReady,
		sendMessage,
		refresh,
		startPolling,
		stopPolling,
	} from './lib/messages.svelte.js';
	import { nodeState } from './lib/store.svelte.js';

	const msgs = messagesState();
	const node = nodeState();

	let author = $state('');
	let content = $state('');
	let composeError: string | null = $state(null);

	$effect(() => {
		if (node.status === 'running') {
			void ensureReady();
		}
	});

	onMount(() => {
		startPolling();
		return () => stopPolling();
	});

	async function onSubmit(evt: SubmitEvent) {
		evt.preventDefault();
		composeError = null;
		const a = author.trim();
		const c = content.trim();
		if (a === '' || c === '') {
			composeError = 'Author and content are required.';
			return;
		}
		try {
			await sendMessage(a, c);
			content = '';
		} catch (err) {
			composeError = err instanceof Error ? err.message : String(err);
		}
	}

	function formatWhen(ts: string): string {
		// Strand timestamps are T-separated ISO (e.g. 'YYYY-MM-DDTHH:MM:SS'). Render as-is.
		return ts;
	}
</script>

<section class="page">
	<header class="page-head">
		<h2>Messages</h2>
		<div class="meta">
			<span>strand {node.strandStatus ?? '—'}</span>
			{#if msgs.updatedMs}
				<span>refreshed {new Date(msgs.updatedMs).toLocaleTimeString()}</span>
			{/if}
			<button
				type="button"
				onclick={() => void refresh()}
				disabled={msgs.loading}
				data-testid="btn-refresh"
			>
				Refresh
			</button>
		</div>
	</header>

	{#if !msgs.ready}
		<p class="empty">
			{#if node.status === 'running'}
				Waiting for the chat strand to become active…
			{:else}
				Node not running — start it from <a href="#/">Home</a>.
			{/if}
		</p>
	{/if}

	{#if msgs.error}
		<p class="error">{msgs.error}</p>
	{/if}

	{#if msgs.ready}
		<form class="compose" onsubmit={onSubmit}>
			<input
				type="text"
				placeholder="Your name"
				bind:value={author}
				disabled={msgs.loading}
				class="author"
				data-testid="compose-author"
			/>
			<input
				type="text"
				placeholder="Say something…"
				bind:value={content}
				disabled={msgs.loading}
				class="content"
				data-testid="compose-content"
			/>
			<button type="submit" disabled={msgs.loading} data-testid="btn-send">Send</button>
		</form>
		{#if composeError}
			<p class="error">{composeError}</p>
		{/if}

		{#if msgs.messages.length === 0}
			<p class="empty">No messages yet. Send the first one above.</p>
		{:else}
			<ul class="list">
				{#each msgs.messages as msg (msg.Id)}
					<li data-testid="message-row" data-message-id={msg.Id}>
						<div class="msg-head">
							<span class="author">{msg.MemberName ?? msg.MemberId}</span>
							<span class="ts">{formatWhen(msg.Timestamp)}</span>
						</div>
						<p class="body" data-testid="message-body">{msg.Content}</p>
						<code class="id">#{msg.Id}</code>
					</li>
				{/each}
			</ul>
		{/if}
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

	.compose {
		display: grid;
		grid-template-columns: 9rem 1fr auto;
		gap: 0.5rem;
		padding: 0.75rem;
		border: 1px solid #e3e5ea;
		border-radius: 0.5rem;
		background: #fafbfc;
	}

	.compose input {
		font: inherit;
		font-size: 0.9rem;
		padding: 0.375rem 0.5rem;
		border: 1px solid #d4d6db;
		border-radius: 0.25rem;
	}

	.compose button {
		font: inherit;
		font-weight: 500;
		padding: 0.375rem 0.75rem;
		border: 1px solid #d4d6db;
		border-radius: 0.25rem;
		background: white;
		cursor: pointer;
		font-size: 0.875rem;
	}

	.compose button:disabled {
		opacity: 0.6;
		cursor: not-allowed;
	}

	.list {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: 0.625rem;
	}

	.list li {
		border: 1px solid #e3e5ea;
		border-radius: 0.5rem;
		padding: 0.75rem 1rem;
		background: white;
		display: grid;
		gap: 0.375rem;
	}

	.msg-head {
		display: flex;
		justify-content: space-between;
		align-items: baseline;
		gap: 1rem;
	}

	.author {
		font-weight: 600;
		font-size: 0.9375rem;
	}

	.ts {
		font-size: 0.75rem;
		color: #6c6f76;
	}

	.body {
		margin: 0;
		font-size: 0.9375rem;
		white-space: pre-wrap;
		word-break: break-word;
	}

	.id {
		justify-self: end;
		color: #8a8d94;
		font-family: ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace;
		font-size: 0.7rem;
	}
</style>
