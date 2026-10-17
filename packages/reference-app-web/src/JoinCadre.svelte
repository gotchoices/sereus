<script lang="ts">
	import { untrack } from 'svelte';
	import { nodeState } from './lib/store.svelte.js';
	import {
		cancelJoin,
		dismissJoinFailure,
		dismissJoinFlow,
		joinCadreState,
		joinExistingCadre,
		keepOldCadre,
		refreshJoinRequest,
		removeOldCadre,
		resumeUnfinishedJoin,
		retryStrandMove,
	} from './lib/join-cadre.svelte.js';
	import { joinFlowText } from './lib/join-flow.js';
	import { peerCode } from './lib/cadre-format.js';
	import Copyable from './lib/Copyable.svelte';
	import QrCode from './lib/QrCode.svelte';

	const node = nodeState();
	const join = joinCadreState();

	const INTRO_LINE =
		'If another Sereus app already holds your cadre, this tab can join it. What its own cadre holds moves with it.';

	/** Where an owner grant comes from, and why this tab would want one. */
	const OWNER_GRANT_LINE =
		'To bring this tab’s strands along, it joins as an owner: in the app that holds your cadre, make an owner grant (a code that makes the app that uses it an owner) under Owner keys → Add an owner key, and paste it below.';

	const flowText = $derived(join.flow ? joinFlowText(join.flow) : null);

	// The request names this tab's peer id, the same in every party; re-read after a restart or a join.
	// A start may also have left a join's later steps undone: the old cadre, or strands to move.
	$effect(() => {
		if (node.status !== 'running') return;
		untrack(() => {
			refreshJoinRequest();
			void resumeUnfinishedJoin();
		});
	});
</script>

<section class="card" data-testid="join-cadre">
	<h3>Join my existing cadre</h3>
	<p class="hint">{INTRO_LINE}</p>

	{#if join.flow && flowText}
		<div class="flow" data-testid="join-flow">
			<p class="line" data-testid="join-flow-line">{flowText.line}</p>
			{#if flowText.detail}
				<p class="hint" data-testid="join-flow-detail">{flowText.detail}</p>
			{/if}
			<!-- No action while the tab is admitted and still moving or removing: none of it rolls back. -->
			<div class="buttons">
				{#if join.flow.step === 'joining'}
					<button onclick={cancelJoin} data-testid="btn-cancel-join">Cancel</button>
				{:else if join.flow.step === 'move-incomplete'}
					<button onclick={() => void retryStrandMove()} data-testid="btn-retry-strand-move">Retry moving</button>
					<button onclick={dismissJoinFlow} data-testid="btn-join-flow-later">Later</button>
				{:else if join.flow.step === 'confirm-discard'}
					{@const discard = [...join.flow.strandIds, ...join.flow.pendingJoinIds]}
					<button class="danger" onclick={() => void removeOldCadre(discard)} data-testid="btn-discard-old-cadre-items">
						Delete them
					</button>
					<button onclick={keepOldCadre} data-testid="btn-keep-old-cadre">Keep old cadre</button>
				{:else if join.flow.step === 'old-cadre-remains'}
					<button onclick={() => void removeOldCadre()} data-testid="btn-remove-old-cadre">Remove it now</button>
					<button onclick={dismissJoinFlow} data-testid="btn-join-flow-later">Later</button>
				{:else if join.flow.step === 'old-cadre-kept' || join.flow.step === 'removal-unfinished' || join.flow.step === 'done'}
					<button onclick={dismissJoinFlow} data-testid="btn-join-flow-ok">OK</button>
				{/if}
			</div>
		</div>
	{:else if node.status !== 'running'}
		<p class="hint">The node is not running.</p>
	{:else}
		<h4>This tab's request</h4>
		{#if join.request.state === 'ready'}
			<QrCode text={join.request.text} label="This tab's join request" />
			<div class="request-text" data-testid="join-request-text">
				<Copyable value={join.request.text} />
			</div>
			<div class="row">
				<span class="label">Code</span>
				<code class="value" data-testid="join-request-code">{peerCode(join.request.peerId)}</code>
			</div>
			<p class="hint">
				The app holding your cadre shows this code when it asks you to add this tab; check that they match.
				Paste the request in that app, under Add a device or app → Paste request. Or ask that app for an open invitation.
			</p>
		{:else if join.request.state === 'failed'}
			<p class="bad">Could not read this tab's identity, so it has no request to show: {join.request.error}</p>
		{:else}
			<p class="hint">Reading this tab's identity…</p>
		{/if}

		<h4>Join</h4>
		<p class="hint">{OWNER_GRANT_LINE}</p>
		<label for="cadre-invitation-in">Paste response, invitation or owner grant</label>
		<textarea
			id="cadre-invitation-in"
			rows="3"
			spellcheck="false"
			placeholder="sereus-invite:1.… or sereus-owner-grant:1.…"
			bind:value={join.invitationText}
			data-testid="cadre-invitation-in"
		></textarea>
		<div class="buttons">
			<button
				onclick={() => void joinExistingCadre()}
				disabled={!join.invitationText.trim()}
				data-testid="btn-join-cadre"
			>
				Join
			</button>
		</div>
	{/if}
	<!-- Outside the status branch: a join whose rollback also failed leaves the node stopped,
	     and the join's own failure must still be readable here, not only the store's on Home. -->
	{#if join.failure}
		<div class="notice" data-testid="join-failure">
			<strong>{join.failure.title}</strong>
			<p>{join.failure.message}</p>
			<button class="small" onclick={dismissJoinFailure}>Dismiss</button>
		</div>
	{/if}
</section>

<style>
	.card {
		margin-top: 1.5rem;
		border: 1px solid #e3e5ea;
		border-radius: 0.5rem;
		background: #fafbfc;
		padding: 1rem 1.25rem;
	}

	h3 {
		margin: 0 0 0.5rem 0;
		font-size: 0.875rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: #4a4d54;
	}

	h4 {
		margin: 1.25rem 0 0.375rem 0;
		font-size: 0.8125rem;
		font-weight: 600;
		color: #4a4d54;
	}

	.hint {
		font-size: 0.8125rem;
		color: #6c6f76;
		margin: 0 0 0.5rem 0;
	}

	.flow {
		display: grid;
		gap: 0.375rem;
		padding: 0.5rem 0.75rem;
		background: #eef0f4;
		border-radius: 0.375rem;
	}

	.line {
		margin: 0;
		font-size: 0.9rem;
	}

	label {
		display: block;
		font-size: 0.8125rem;
		color: #6c6f76;
		margin-bottom: 0.25rem;
	}

	textarea {
		width: 100%;
		font-family: ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace;
		font-size: 0.85rem;
		padding: 0.375rem 0.5rem;
		border: 1px solid #d4d6db;
		border-radius: 0.25rem;
		resize: vertical;
	}

	button {
		padding: 0.5rem 1rem;
		font: inherit;
		font-weight: 500;
		border: 1px solid #d4d6db;
		border-radius: 0.375rem;
		background: white;
		cursor: pointer;
	}

	button:disabled {
		opacity: 0.6;
		cursor: not-allowed;
	}

	button.danger {
		color: #b3261e;
		border-color: #e3b4b0;
	}

	button.small {
		padding: 0.125rem 0.5rem;
		font-size: 0.75rem;
		margin-top: 0.25rem;
	}

	.buttons {
		display: flex;
		gap: 0.5rem;
		margin: 0.5rem 0;
		flex-wrap: wrap;
	}

	.request-text {
		max-width: 100%;
		margin: 0.5rem 0;
	}

	.row {
		display: grid;
		grid-template-columns: 4rem 1fr;
		gap: 0.75rem;
		align-items: baseline;
		margin-bottom: 0.375rem;
	}

	.label {
		font-size: 0.8125rem;
		font-weight: 500;
		color: #6c6f76;
	}

	code.value {
		font-family: ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace;
		font-size: 0.9rem;
		word-break: break-all;
	}

	.notice {
		color: #b3261e;
		font-size: 0.8125rem;
		margin: 0.25rem 0 0.5rem 0;
	}

	.notice p {
		margin: 0.125rem 0 0 0;
		word-break: break-word;
	}

	.bad {
		color: #b3261e;
		font-size: 0.8125rem;
		margin: 0 0 0.5rem 0;
	}
</style>
