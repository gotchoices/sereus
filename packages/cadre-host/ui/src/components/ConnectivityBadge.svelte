<script lang="ts">
	import type { DirectReachability } from '../lib/state.svelte.js';

	interface Props {
		reachability: DirectReachability;
	}

	const { reachability }: Props = $props();

	const reachLabel = $derived.by(() => {
		switch (reachability) {
			case 'reachable': return 'Reachable';
			case 'unreachable': return 'Unreachable';
			case 'cgnat': return 'Behind CGNAT';
			default: return 'Unknown';
		}
	});

	// Unreachable nodes still work on the home network: a warning, as in `overall-status.ts`.
	const reachTone: 'ok' | 'warn' | 'info' = $derived.by(() => {
		switch (reachability) {
			case 'reachable': return 'ok';
			case 'unreachable':
			case 'cgnat': return 'warn';
			default: return 'info';
		}
	});
</script>

<span class="badge {reachTone}">{reachLabel}</span>
