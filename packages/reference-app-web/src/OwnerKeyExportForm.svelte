<script lang="ts">
	import { untrack } from 'svelte';
	import { exportFormProblem, type ExportForm } from './lib/owner-keys.svelte.js';

	/** The Owner keys card's form for exporting this tab's own key: a name, and a passphrase typed twice unless it is turned off. */
	interface Props {
		title: string;
		intro: string;
		defaultLabel: string;
		submitLabel: string;
		busy: boolean;
		onSubmit: (form: ExportForm) => void;
		onCancel: () => void;
	}

	const { title, intro, defaultLabel, submitLabel, busy, onSubmit, onCancel }: Props = $props();

	// The name the form opened with; the card mounts a new form for each opening.
	const form = $state<ExportForm>({ label: untrack(() => defaultLabel), locked: true, passphrase: '', repeat: '' });
	// Nothing is sent while the form has a problem.
	const problem = $derived(exportFormProblem(form));
</script>

<div class="form" data-testid="owner-key-export-form">
	<h4>{title}</h4>
	<p class="hint">{intro}</p>
	<label for="owner-key-label-in">Name</label>
	<input id="owner-key-label-in" type="text" autocomplete="off" bind:value={form.label} data-testid="owner-key-label-in" />
	<label class="check">
		<input type="checkbox" bind:checked={form.locked} data-testid="owner-key-locked" />
		Protect with a passphrase
	</label>
	{#if form.locked}
		<label for="owner-key-passphrase-in">Passphrase</label>
		<input id="owner-key-passphrase-in" type="password" autocomplete="off" bind:value={form.passphrase} data-testid="owner-key-passphrase-in" />
		<label for="owner-key-passphrase-again-in">Passphrase again</label>
		<input id="owner-key-passphrase-again-in" type="password" autocomplete="off" bind:value={form.repeat} data-testid="owner-key-passphrase-again-in" />
	{:else}
		<p class="hint warn">Without a passphrase, anyone who sees the text or the QR code holds the key.</p>
	{/if}
	{#if problem}
		<p class="hint">{problem}</p>
	{/if}
	<div class="buttons">
		<button onclick={() => onSubmit($state.snapshot(form))} disabled={busy || problem !== null} data-testid="btn-submit-owner-key-export">
			{busy ? 'Working…' : submitLabel}
		</button>
		<button onclick={onCancel} disabled={busy} data-testid="btn-cancel-owner-key-export">Cancel</button>
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

	.hint.warn {
		color: #6b4d00;
	}

	label {
		display: block;
		font-size: 0.8125rem;
		color: #6c6f76;
	}

	label.check {
		display: flex;
		align-items: center;
		gap: 0.375rem;
		color: #1d1f24;
		font-size: 0.875rem;
		margin: 0.5rem 0 0.25rem 0;
	}

	input[type='text'],
	input[type='password'] {
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
