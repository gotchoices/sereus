<script lang="ts">
	import QRCode from 'qrcode';

	interface Props {
		value: string;
		size?: number;
	}

	const { value, size = 192 }: Props = $props();

	let svg = $state('');
	let error: string | null = $state(null);

	$effect(() => {
		const v = value;
		if (!v) {
			svg = '';
			error = null;
			return;
		}
		QRCode.toString(v, {
			type: 'svg',
			errorCorrectionLevel: 'M',
			margin: 1,
			width: size,
			color: {
				dark: '#1d1f24',
				light: '#ffffff',
			},
		})
			.then((generated) => {
				svg = generated;
				error = null;
			})
			.catch((err: Error) => {
				console.error('QR generation failed', err);
				error = err.message;
			});
	});
</script>

{#if error}
	<p class="muted">QR unavailable: {error}</p>
{:else if svg}
	<div class="qr" style="width: {size}px; height: {size}px;">
		<!-- eslint-disable-next-line svelte/no-at-html-tags -- `svg` is markup generated locally by the qrcode library (QRCode.toString), not user-supplied/network content, so there is no XSS surface here. -->
		{@html svg}
	</div>
{:else}
	<div class="qr placeholder" style="width: {size}px; height: {size}px;"></div>
{/if}

<style>
	.qr {
		background: white;
		border-radius: var(--radius);
		padding: 0.5rem;
		display: inline-block;
		line-height: 0;
	}
	.qr :global(svg) {
		width: 100%;
		height: 100%;
		display: block;
	}
	.placeholder {
		background: var(--color-surface-alt);
	}
</style>
