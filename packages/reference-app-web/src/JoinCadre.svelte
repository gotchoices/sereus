<script lang="ts">
	import { untrack } from 'svelte';
	import { nodeState } from './lib/store.svelte.js';
	import {
		cancelJoin,
		dismissJoinFailure,
		dismissJoinFlow,
		joinCadreState,
		joinExistingCadre,
		refreshJoinRequest,
	} from './lib/join-cadre.svelte.js';
	import { joinFlowText } from './lib/join-flow.js';
	import { peerCode } from './lib/cadre-format.js';
	import Copyable from './lib/Copyable.svelte';
	import QrCode from './lib/QrCode.svelte';

	const node = nodeState();
	const join = joinCadreState();

	const INTRO_LINE =
		'If another Sereus app already holds your cadre, this tab can join it. What its own cadre holds moves with it.';

	const flowText = $derived(join.flow ? joinFlowText(join.flow) : null);

	// The request names this tab's peer id, the same in every party; re-read after a restart or a join.
	$effect(() => {
		if (node.status !== 'running') return;
		untrack(refreshJoinRequest);
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
			<div class="buttons">
				{#if join.flow.step === 'joining'}
					<button onclick={cancelJoin} data-testid="btn-cancel-join">Cancel</button>
				{:else if join.flow.step === 'done' || join.flow.step === 'move-incomplete'}
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
		<label for="cadre-invitation-in">Paste response or invitation</label>
		<textarea
			id="cadre-invitation-in"
			rows="3"
			spellcheck="false"
			placeholder="sereus-invite:1.…"
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
		{#if join.failure}
			<div class="notice" data-testid="join-failure">
				<strong>{join.failure.title}</strong>
				<p>{join.failure.message}</p>
				<button class="small" onclick={dismissJoinFailure}>Dismiss</button>
			</div>
		{/if}
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
