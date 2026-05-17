<script lang="ts">
	interface Props { size?: number }
	let { size = 16 }: Props = $props();
</script>

<svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
	<path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9" />
	<path d="M14 2v3h-3" />
</svg>
