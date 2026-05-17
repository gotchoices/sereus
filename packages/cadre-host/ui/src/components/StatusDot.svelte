<script lang="ts">
	import type { OverallStatus } from '../lib/state.svelte.js';

	interface Props {
		status: OverallStatus;
		label?: string;
		size?: number;
	}

	let { status, label, size = 14 }: Props = $props();

	const tone = $derived.by(() => {
		switch (status) {
			case 'ok': return 'ok';
			case 'warn': return 'warn';
			case 'error': return 'err';
			default: return 'muted';
		}
	});

	const text = $derived(label ?? defaultLabel(status));

	function defaultLabel(s: OverallStatus): string {
		switch (s) {
			case 'ok': return 'Healthy';
			case 'warn': return 'Attention needed';
			case 'error': return 'Error';
			default: return 'Loading…';
		}
	}
</script>

<span class="dot dot-{tone}" role="status">
	<span class="bulb" style="width: {size}px; height: {size}px;" aria-hidden="true"></span>
	<span>{text}</span>
</span>

<style>
	.dot {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
		font-weight: 500;
	}
	.bulb {
		display: inline-block;
		border-radius: 999px;
		flex: 0 0 auto;
		background: var(--color-text-soft);
		box-shadow: 0 0 0 3px rgba(0, 0, 0, 0.06);
	}
	.dot-ok .bulb { background: var(--color-success); box-shadow: 0 0 0 3px var(--color-success-bg); }
	.dot-warn .bulb { background: var(--color-warn); box-shadow: 0 0 0 3px var(--color-warn-bg); }
	.dot-err .bulb { background: var(--color-danger); box-shadow: 0 0 0 3px var(--color-danger-bg); }
	.dot-muted .bulb { background: var(--color-text-soft); }

	.dot-ok { color: var(--color-success); }
	.dot-warn { color: var(--color-warn); }
	.dot-err { color: var(--color-danger); }
</style>
