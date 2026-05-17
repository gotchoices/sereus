<script lang="ts">
	interface Props { size?: number }
	let { size = 16 }: Props = $props();
</script>

<svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
	<rect x="2" y="2" width="5" height="5" rx="0.5" />
	<rect x="9" y="2" width="5" height="5" rx="0.5" />
	<rect x="2" y="9" width="5" height="5" rx="0.5" />
	<path d="M9 9h2v2h-2zM13 9h1M9 13v1M11 11h3v3" />
</svg>
