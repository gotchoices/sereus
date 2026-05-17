<script lang="ts">
	interface Props {
		size?: number;
	}
	let { size = 16 }: Props = $props();
</script>

<svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
	<circle cx="8" cy="8" r="6" fill="currentColor" />
</svg>
