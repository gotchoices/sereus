<script lang="ts">
	import { appState, dismissToast } from '../lib/state.svelte.js';
	const app = appState();
</script>

{#if app.toasts.length > 0}
	<div class="toast-stack" aria-live="polite" aria-relevant="additions">
		{#each app.toasts as toast (toast.id)}
			<div class="toast toast-{toast.kind}" role="status">
				<span class="text">{toast.text}</span>
				<button class="ghost" aria-label="Dismiss" onclick={() => dismissToast(toast.id)}>×</button>
			</div>
		{/each}
	</div>
{/if}

<style>
	.toast-stack {
		position: fixed;
		right: 1rem;
		bottom: 1rem;
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		max-width: min(30rem, calc(100vw - 2rem));
		z-index: 1100;
	}
	.toast {
		background: var(--color-surface);
		color: var(--color-text);
		border: 1px solid var(--color-border-strong);
		border-radius: var(--radius);
		padding: 0.625rem 0.75rem;
		display: flex;
		align-items: center;
		gap: 0.5rem;
		box-shadow: var(--shadow);
		font-size: 0.92rem;
	}
	.toast-error {
		border-color: var(--color-danger);
		background: var(--color-danger-bg);
		color: var(--color-danger);
	}
	.toast-success {
		border-color: var(--color-success);
		background: var(--color-success-bg);
		color: var(--color-success);
	}
	.text { flex: 1 1 auto; }
	button {
		font-size: 1.1rem;
		line-height: 1;
		padding: 0.125rem 0.5rem;
		color: currentColor;
	}
</style>
