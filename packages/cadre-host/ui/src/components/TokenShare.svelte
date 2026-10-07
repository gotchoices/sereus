<script lang="ts">
	import { copyText } from '../lib/state.svelte.js';

	import QrCode from './QrCode.svelte';
	import CopyIcon from './icons/CopyIcon.svelte';

	interface Props {
		/** The secret to hand over, shown as a QR code and as copyable text. */
		value: string;
		/** Accessible name for the copy button, e.g. "Copy grant token". */
		copyLabel: string;
	}

	const { value, copyLabel }: Props = $props();
</script>

<div class="qr-wrap">
	<QrCode {value} size={224} />
</div>
<div class="token">
	<textarea readonly rows="3">{value}</textarea>
	<button class="ghost" type="button" onclick={() => copyText(value)} aria-label={copyLabel}>
		<CopyIcon /> Copy
	</button>
</div>

<style>
	.qr-wrap {
		display: flex;
		justify-content: center;
		margin: var(--space-3) 0;
	}
	.token {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}
	.token textarea {
		font-family: var(--font-mono);
		font-size: 0.78rem;
		word-break: break-all;
		resize: vertical;
	}
	.token button {
		align-self: flex-end;
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
	}
</style>
