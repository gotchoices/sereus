<script lang="ts">
	import { onMount } from 'svelte';
	import {
		messagesState,
		ensureReady,
		addMessage,
		updateMessage,
		deleteMessage,
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

	/** id → in-progress edit buffer; absent means "not editing". */
	let editing: Record<string, string> = $state({});

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
			await addMessage(a, c);
			content = '';
		} catch (err) {
			composeError = err instanceof Error ? err.message : String(err);
		}
	}

	function beginEdit(id: string, current: string) {
		editing = { ...editing, [id]: current };
	}

	function cancelEdit(id: string) {
		const next = { ...editing };
		delete next[id];
		editing = next;
	}

	function onEditInput(id: string, evt: Event) {
		const target = evt.currentTarget as HTMLInputElement;
		editing = { ...editing, [id]: target.value };
	}

	async function commitEdit(id: string) {
		const value = editing[id];
		if (value === undefined) return;
		const trimmed = value.trim();
		if (trimmed === '') return;
		try {
			await updateMessage(id, trimmed);
			cancelEdit(id);
		} catch (err) {
			composeError = err instanceof Error ? err.message : String(err);
		}
	}

	async function handleDelete(id: string) {
		const ok = window.confirm('Delete this message?');
		if (!ok) return;
		try {
			await deleteMessage(id);
		} catch (err) {
			composeError = err instanceof Error ? err.message : String(err);
		}
	}

	function formatWhen(ms: number): string {
		return new Date(ms).toLocaleString();
	}
</script>

<section class="page">
	<header class="page-head">
		<h2>Messages</h2>
		<div class="meta">
			<span>mode {msgs.mode}</span>
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
				Connecting to MessageApp…
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
				placeholder="Author"
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
				{#each msgs.messages as msg (msg.id)}
					<li data-testid="message-row" data-message-id={msg.id}>
						<div class="msg-head">
							<span class="author">{msg.author}</span>
							<span class="ts">{formatWhen(msg.timestamp)}</span>
						</div>
						{#if editing[msg.id] !== undefined}
							<div class="edit-row">
								<input
									type="text"
									value={editing[msg.id]}
									oninput={(e) => onEditInput(msg.id, e)}
									disabled={msgs.loading}
									data-testid="edit-input"
								/>
								<button
									type="button"
									onclick={() => void commitEdit(msg.id)}
									disabled={msgs.loading}
									data-testid="btn-save"
								>
									Save
								</button>
								<button
									type="button"
									onclick={() => cancelEdit(msg.id)}
									disabled={msgs.loading}
									data-testid="btn-cancel"
								>
									Cancel
								</button>
							</div>
						{:else}
							<p class="body" data-testid="message-body">{msg.content}</p>
							<div class="msg-actions">
								<button
									type="button"
									onclick={() => beginEdit(msg.id, msg.content)}
									disabled={msgs.loading}
									data-testid="btn-edit"
								>
									Edit
								</button>
								<button
									type="button"
									class="danger"
									onclick={() => void handleDelete(msg.id)}
									disabled={msgs.loading}
									data-testid="btn-delete"
								>
									Delete
								</button>
								<code class="id">{msg.id}</code>
							</div>
						{/if}
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

	.compose input,
	.edit-row input {
		font: inherit;
		font-size: 0.9rem;
		padding: 0.375rem 0.5rem;
		border: 1px solid #d4d6db;
		border-radius: 0.25rem;
	}

	.compose button,
	.msg-actions button,
	.edit-row button {
		font: inherit;
		font-weight: 500;
		padding: 0.375rem 0.75rem;
		border: 1px solid #d4d6db;
		border-radius: 0.25rem;
		background: white;
		cursor: pointer;
		font-size: 0.875rem;
	}

	.compose button:disabled,
	.msg-actions button:disabled,
	.edit-row button:disabled {
		opacity: 0.6;
		cursor: not-allowed;
	}

	.msg-actions button.danger {
		color: #b3261e;
		border-color: #f3c2bf;
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

	.msg-actions {
		display: flex;
		gap: 0.375rem;
		align-items: center;
		font-size: 0.75rem;
	}

	.msg-actions .id {
		margin-left: auto;
		color: #8a8d94;
		font-family: ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace;
		font-size: 0.7rem;
	}

	.edit-row {
		display: grid;
		grid-template-columns: 1fr auto auto;
		gap: 0.375rem;
	}
</style>
