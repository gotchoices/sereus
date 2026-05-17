<script lang="ts">
	import type { DirectReachability, PortForwardMode } from '../lib/state.svelte.js';

	interface Props {
		reachability: DirectReachability;
		portMode: PortForwardMode;
	}

	let { reachability, portMode }: Props = $props();

	const reachLabel = $derived.by(() => {
		switch (reachability) {
			case 'reachable': return 'Reachable';
			case 'unreachable': return 'Unreachable';
			case 'cgnat': return 'Behind CGNAT';
			default: return 'Unknown';
		}
	});

	const reachTone: 'ok' | 'warn' | 'err' | 'info' = $derived.by(() => {
		switch (reachability) {
			case 'reachable': return 'ok';
			case 'unreachable': return 'err';
			case 'cgnat': return 'warn';
			default: return 'info';
		}
	});

	const portModeLabel = $derived.by(() => {
		switch (portMode) {
			case 'auto-upnp': return 'UPnP';
			case 'auto-natpmp': return 'NAT-PMP';
			case 'manual': return 'Manual';
			case 'failed': return 'Failed';
			case 'disabled': return 'Disabled';
			default: return portMode;
		}
	});
</script>

<span class="row">
	<span class="badge {reachTone}">{reachLabel}</span>
	<span class="badge">{portModeLabel}</span>
</span>

<style>
	.row { display: inline-flex; gap: 0.4rem; flex-wrap: wrap; }
</style>
