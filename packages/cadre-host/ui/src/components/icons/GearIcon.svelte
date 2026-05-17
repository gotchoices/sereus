<script lang="ts">
	interface Props { size?: number }
	let { size = 16 }: Props = $props();
</script>

<svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
	<circle cx="8" cy="8" r="2" />
	<path d="M13.4 9.9a1 1 0 0 0 .2 1.1l.1.1a1.3 1.3 0 1 1-1.8 1.8l-.1-.1a1 1 0 0 0-1.1-.2 1 1 0 0 0-.6 1V14a1.3 1.3 0 1 1-2.6 0v-.1a1 1 0 0 0-.7-1 1 1 0 0 0-1.1.2l-.1.1a1.3 1.3 0 1 1-1.8-1.8l.1-.1a1 1 0 0 0 .2-1.1 1 1 0 0 0-1-.6H2.6A1.3 1.3 0 1 1 2.6 7h.1a1 1 0 0 0 1-.7 1 1 0 0 0-.2-1.1l-.1-.1A1.3 1.3 0 1 1 5.2 3.3l.1.1a1 1 0 0 0 1.1.2H6.5a1 1 0 0 0 .6-1V2.6a1.3 1.3 0 1 1 2.6 0v.1a1 1 0 0 0 .6 1 1 1 0 0 0 1.1-.2l.1-.1a1.3 1.3 0 1 1 1.8 1.8l-.1.1a1 1 0 0 0-.2 1.1V6.5a1 1 0 0 0 1 .6H14a1.3 1.3 0 1 1 0 2.6h-.1a1 1 0 0 0-1 .6Z" />
</svg>
