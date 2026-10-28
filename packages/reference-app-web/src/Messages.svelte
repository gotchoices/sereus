<script lang="ts">
	import { onMount } from 'svelte';
	import {
		messagesState,
		ensureReady,
		sendMessage,
		composerChanged,
		changeOfflineMode,
		discardMessage,
		dismissUnsent,
		onDraftSettled,
		queueLine,
		refresh,
		sendMarkOf,
		startPolling,
		stopPolling,
		unsentMessages,
	} from './lib/messages.svelte.js';
	import { sendMarkText } from './lib/send-marks.js';
	import { nodeState } from './lib/store.svelte.js';

	const msgs = messagesState();
	const node = nodeState();

	let author = $state('');
	let content = $state('');
	let markError: string | null = $state(null);
	let modeBusy = $state(false);
	const line = $derived(queueLine());
	const unsent = $derived(unsentMessages());

	function onDiscard(messageId: string) {
		markError = discardMessage(messageId);
	}

	async function onOfflineChange(evt: Event) {
		const input = evt.currentTarget as HTMLInputElement;
		const offline = input.checked;
		modeBusy = true;
		markError = null;
		try {
			await changeOfflineMode(offline);
		} catch (err) {
			// `msgs.offline` did not change, so nothing re-renders the box the click toggled.
			input.checked = !offline;
			markError = `Could not change offline mode: ${err instanceof Error ? err.message : String(err)}`;
		} finally {
			modeBusy = false;
		}
	}
	let composeError: string | null = $state(null);

	$effect(() => {
		if (node.status === 'running') {
			void ensureReady();
		}
	});

	// Every edit, so text other than the pending draft's never reuses its key (see `composerChanged`).
	$effect(() => {
		composerChanged(author.trim(), content.trim());
	});

	onMount(() => {
		startPolling();
		const stopSettled = onDraftSettled(settleDraft);
		return () => {
			stopPolling();
			stopSettled();
		};
	});

	/** A send that reported failure did land. Leave text the user has since typed alone. */
	function settleDraft(settledAuthor: string, settledContent: string) {
		composeError = null;
		if (author.trim() === settledAuthor && content.trim() === settledContent) content = '';
	}

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
			const reason = err instanceof Error ? err.message : String(err);
			// A failed strand write does not always settle whether it landed, so say "not confirmed"
			// rather than "failed". Repeating is safe because the id is minted per draft (see
			// `sendMessage`), so a resend of unchanged text can only ever replace the earlier write.
			composeError = `Not confirmed sent (${reason}). Press Send again — the message can only be stored once.`;
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
			<label class="mode" title="On: a message counts as sent once this tab has saved it, and goes to the other members, in order, when they can be reached. Off: once the members this tab can reach hold it.">
				<input
					type="checkbox"
					checked={msgs.offline === true}
					onchange={onOfflineChange}
					disabled={msgs.offline === null || modeBusy || node.status !== 'running'}
					data-testid="toggle-offline"
				/>
				Offline mode
			</label>
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

	{#if markError}
		<p class="error" data-testid="mark-error">{markError}</p>
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
		{#if line}
			<p class="queue" data-testid="queue-line">{line}</p>
		{/if}

		{#each unsent as m (m.messageId)}
			<p class="unsent" data-testid="message-unsent" data-message-id={m.messageId}>
				“{m.content}” — {sendMarkText(m.mark)}
				<button type="button" onclick={() => dismissUnsent(m.messageId)} data-testid="btn-dismiss-unsent">Dismiss</button>
			</p>
		{/each}

		{#if msgs.messages.length === 0}
			<p class="empty">No messages yet. Send the first one above.</p>
		{:else}
			<ul class="list">
				{#each msgs.messages as msg (msg.Id)}
					{@const mark = sendMarkOf(msg.Id)}
					<li data-testid="message-row" data-message-id={msg.Id}>
						<div class="msg-head">
							<span class="author">{msg.ParticipantName ?? msg.ParticipantId}</span>
							<span class="ts">{formatWhen(msg.Timestamp)}</span>
						</div>
						<p class="body" data-testid="message-body">{msg.Content}</p>
						{#if mark}
							<span class="send-mark" data-testid="message-send-mark">
								{sendMarkText(mark)}
								{#if mark.kind === 'waiting' && mark.discardable}
									<button type="button" onclick={() => onDiscard(msg.Id)} data-testid="btn-discard">Discard</button>
								{/if}
							</span>
						{/if}
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

	.send-mark {
		justify-self: end;
		color: #9a6700;
		font-size: 0.75rem;
	}

	.send-mark button,
	.unsent button {
		font: inherit;
		margin-left: 0.5rem;
		padding: 0 0.375rem;
		border: 1px solid #d4d6db;
		border-radius: 0.25rem;
		background: white;
		cursor: pointer;
	}

	.queue {
		margin: 0;
		color: #9a6700;
		font-size: 0.8125rem;
	}

	.unsent {
		margin: 0;
		color: #b3261e;
		font-size: 0.8125rem;
	}

	.mode {
		display: flex;
		align-items: center;
		gap: 0.25rem;
	}

	.id {
		justify-self: end;
		color: #8a8d94;
		font-family: ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace;
		font-size: 0.7rem;
	}
</style>
