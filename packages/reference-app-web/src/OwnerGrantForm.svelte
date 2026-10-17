<script lang="ts">
	import { untrack } from 'svelte';
	import { DEFAULT_BACKUP_LABEL, OWNER_GRANT_MEANING } from './lib/owner-grants.js';
	import { labelProblem } from './lib/owner-keys.svelte.js';

	/** The Owner keys card's form for Add an owner key and Make a backup: the name the key it adds is listed under. */
	interface Props {
		/** Make a backup; otherwise Add an owner key. */
		backup: boolean;
		busy: boolean;
		onSubmit: (label: string) => void;
		onCancel: () => void;
	}

	const { backup, busy, onSubmit, onCancel }: Props = $props();

	// The card mounts a new form for each opening.
	let label = $state(untrack(() => backup) ? DEFAULT_BACKUP_LABEL : '');
	// Nothing is sent while the name is too long.
	const problem = $derived(labelProblem(label));
</script>

<div class="form" data-testid="owner-grant-form">
	<h4>{backup ? 'Make a backup' : 'Add an owner key'}</h4>
	<p class="hint">{OWNER_GRANT_MEANING}</p>
	<p class="hint">
		{backup
			? 'A backup is an owner grant with no expiry, to print or save, so a new device can become an owner of this cadre if this tab’s site data is lost. It is shown once.'
			: 'For another device or another app of yours: whichever uses this grant first becomes an owner of this cadre, with a key of its own. It works once, within 15 minutes.'}
	</p>
	<label for="owner-grant-label-in">Name</label>
	<input
		id="owner-grant-label-in"
		type="text"
		autocomplete="off"
		placeholder={backup ? undefined : 'tablet'}
		bind:value={label}
		data-testid="owner-grant-label-in"
	/>
	<p class="hint">The owner key it adds is listed under this name.</p>
	{#if problem}
		<p class="hint">{problem}</p>
	{/if}
	<div class="buttons">
		<button onclick={() => onSubmit(label)} disabled={busy || problem !== null} data-testid="btn-submit-owner-grant">
			{busy ? 'Working…' : backup ? 'Make backup' : 'Make owner grant'}
		</button>
		<button onclick={onCancel} disabled={busy} data-testid="btn-cancel-owner-grant">Cancel</button>
	</div>
</div>

<style>
	.form {
		display: grid;
		gap: 0.25rem;
		padding: 0.5rem 0.75rem;
		margin-top: 0.75rem;
		background: #eef0f4;
		border-radius: 0.375rem;
	}

	h4 {
		margin: 0.5rem 0 0.375rem 0;
		font-size: 0.8125rem;
		font-weight: 600;
		color: #4a4d54;
	}

	.hint {
		font-size: 0.8125rem;
		color: #6c6f76;
		margin: 0 0 0.5rem 0;
	}

	label {
		display: block;
		font-size: 0.8125rem;
		color: #6c6f76;
	}

	input[type='text'] {
		font: inherit;
		font-size: 0.875rem;
		padding: 0.375rem 0.5rem;
		border: 1px solid #d4d6db;
		border-radius: 0.25rem;
		max-width: 24rem;
		margin-bottom: 0.25rem;
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

	.buttons {
		display: flex;
		gap: 0.5rem;
		margin: 0.5rem 0;
		flex-wrap: wrap;
	}
</style>
