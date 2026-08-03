<script lang="ts">
	import { typedConfirmationMatches } from '../lib/strand-confirm.js';

	interface Props {
		open: boolean;
		title: string;
		message: string;
		/** Extra advisory line, rendered as a warning block below the message. */
		note?: string;
		/**
		 * When set, the operator must type this exact text before Confirm enables.
		 * Reserved for actions that destroy something unrecreatable — a checkbox
		 * costs one reflexive click, typing costs deliberate attention.
		 */
		requireText?: string;
		requireTextLabel?: string;
		confirmLabel?: string;
		cancelLabel?: string;
		danger?: boolean;
		onConfirm: () => void | Promise<void>;
		onCancel: () => void;
	}

	const {
		open,
		title,
		message,
		note,
		requireText,
		requireTextLabel,
		confirmLabel = 'Confirm',
		cancelLabel = 'Cancel',
		danger = false,
		onConfirm,
		onCancel,
	}: Props = $props();

	let pending = $state(false);
	let typed = $state('');

	const gated = $derived(typeof requireText === 'string' && requireText.trim() !== '');
	const matched = $derived(gated && typedConfirmationMatches(requireText ?? '', typed));
	const canConfirm = $derived(!pending && (!gated || matched));

	$effect(() => {
		// Re-runs whenever the dialog opens/closes or targets a different value, so
		// text typed for one target never carries into the next one's field.
		void open;
		void requireText;
		typed = '';
	});

	async function handleConfirm(): Promise<void> {
		if (!canConfirm) return;
		pending = true;
		try {
			await onConfirm();
		} finally {
			pending = false;
		}
	}

	function onKey(event: KeyboardEvent): void {
		if (event.key === 'Escape') onCancel();
	}

	function onConfirmInputKey(event: KeyboardEvent): void {
		// Enter is a shortcut for the button, so it must obey the same gate.
		if (event.key !== 'Enter') return;
		event.preventDefault();
		if (canConfirm) void handleConfirm();
	}
</script>

{#if open}
	<div class="backdrop" role="presentation" onclick={onCancel}></div>
	<div
		class="dialog"
		role="dialog"
		aria-modal="true"
		aria-labelledby="confirm-title"
		tabindex="-1"
		onkeydown={onKey}
	>
		<h3 id="confirm-title">{title}</h3>
		<p class="muted">{message}</p>
		{#if note}
			<p class="note">⚠ {note}</p>
		{/if}
		{#if gated}
			<div class="gate">
				<label for="confirm-typed">{requireTextLabel ?? `Type ${requireText} to confirm:`}</label>
				<input
					id="confirm-typed"
					type="text"
					autocomplete="off"
					autocapitalize="off"
					spellcheck="false"
					bind:value={typed}
					onkeydown={onConfirmInputKey}
					disabled={pending}
				/>
			</div>
		{/if}
		<div class="actions">
			<button onclick={onCancel} disabled={pending}>{cancelLabel}</button>
			<button
				class={danger ? 'danger' : 'primary'}
				onclick={handleConfirm}
				disabled={!canConfirm}
			>{pending ? 'Working…' : confirmLabel}</button>
		</div>
	</div>
{/if}

<style>
	.backdrop {
		position: fixed;
		inset: 0;
		background: rgba(15, 17, 22, 0.45);
		z-index: 1000;
	}
	.dialog {
		position: fixed;
		top: 50%;
		left: 50%;
		transform: translate(-50%, -50%);
		background: var(--color-surface);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-lg);
		box-shadow: var(--shadow-lg);
		padding: var(--space-5);
		min-width: min(24rem, calc(100vw - 2rem));
		/* Caps growth so a long strand id wraps instead of widening the dialog. */
		max-width: min(32rem, calc(100vw - 2rem));
		overflow-wrap: anywhere;
		z-index: 1010;
	}
	.note {
		background: var(--color-warn-bg);
		color: var(--color-warn);
		border-radius: var(--radius);
		padding: var(--space-2) var(--space-3);
		font-size: 0.9rem;
	}
	.gate {
		margin-top: var(--space-3);
		/* A long, opaque id must wrap rather than widen the dialog. */
		overflow-wrap: anywhere;
	}
	.actions {
		display: flex;
		justify-content: flex-end;
		gap: 0.5rem;
		margin-top: var(--space-4);
	}
</style>
