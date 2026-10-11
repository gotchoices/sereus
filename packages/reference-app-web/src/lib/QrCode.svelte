<script lang="ts">
	import QRCode from 'qrcode';

	interface Props {
		text: string;
		/** Accessible name for the drawn code. */
		label: string;
	}

	const { text, label }: Props = $props();

	// Level L: an invitation runs to about 2,000 characters, and the lowest error correction
	// keeps the modules as large as that allows, so a camera reads it from a screen. The
	// encoder refuses only text too long for any QR code.
	// NOTE: at 24rem a ~1,200-character invitation draws about 3 CSS px per module, never read
	// by a phone camera in a test; if phones fail to scan it, draw it wider.
	const svg = $derived(
		QRCode.toString(text, { type: 'svg', errorCorrectionLevel: 'L', margin: 2 }).catch((err: unknown) => {
			console.warn('[reference-app-web] no QR code for this text:', err);
			return null;
		}),
	);
</script>

{#await svg then markup}
	{#if markup}
		<div class="qr" role="img" aria-label={label} data-testid="qr-code">
			<!-- eslint-disable-next-line svelte/no-at-html-tags -- the qrcode library's own rendering of our text: path data only, nothing in the text reaches the markup. -->
			{@html markup}
		</div>
	{:else}
		<p class="too-long" data-testid="qr-too-long">Too long for a QR code; use copy instead.</p>
	{/if}
{/await}

<style>
	.qr {
		width: min(24rem, 100%);
		background: white;
		line-height: 0;
	}
	.qr :global(svg) {
		display: block;
		width: 100%;
		height: auto;
	}
	.too-long {
		font-size: 0.8125rem;
		color: #6c6f76;
		margin: 0;
	}
</style>
