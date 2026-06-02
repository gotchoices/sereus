<script lang="ts">
	interface Props { size?: number }
	const { size = 16 }: Props = $props();
</script>

<svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
	<rect x="5" y="5" width="9" height="9" rx="1.5" />
	<path d="M11 3.5V3a1 1 0 0 0-1-1H3a1 1 0 0 0-1 1v7a1 1 0 0 0 1 1h.5" />
</svg>
