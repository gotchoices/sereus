<script lang="ts">
	interface Props {
		open: boolean;
		title: string;
		message: string;
		confirmLabel?: string;
		cancelLabel?: string;
		danger?: boolean;
		onConfirm: () => void | Promise<void>;
		onCancel: () => void;
	}

	let {
		open,
		title,
		message,
		confirmLabel = 'Confirm',
		cancelLabel = 'Cancel',
		danger = false,
		onConfirm,
		onCancel,
	}: Props = $props();

	let pending = $state(false);

	async function handleConfirm(): Promise<void> {
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
		<div class="actions">
			<button onclick={onCancel} disabled={pending}>{cancelLabel}</button>
			<button
				class={danger ? 'danger' : 'primary'}
				onclick={handleConfirm}
				disabled={pending}
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
		z-index: 1010;
	}
	.actions {
		display: flex;
		justify-content: flex-end;
		gap: 0.5rem;
		margin-top: var(--space-4);
	}
</style>
