<script lang="ts">
	import { apiPost, ApiError } from '../lib/api.js';
	import { pushToast, refreshTrustCircle } from '../lib/state.svelte.js';

	import QrCode from './QrCode.svelte';
	import CopyIcon from './icons/CopyIcon.svelte';

	interface Props {
		open: boolean;
		onClose: () => void;
	}

	const { open, onClose }: Props = $props();

	const TTL_OPTIONS = [
		{ label: '15 minutes', value: 15 * 60 * 1000 },
		{ label: '1 hour', value: 60 * 60 * 1000 },
		{ label: '24 hours', value: 24 * 60 * 60 * 1000 },
		{ label: '7 days', value: 7 * 24 * 60 * 60 * 1000 },
		{ label: 'No expiry', value: 0 },
	];

	let label = $state('');
	let ttl: number = $state(24 * 60 * 60 * 1000);
	let busy = $state(false);
	let result: { encodedInvite: string; token: string; expiresAt?: string } | null = $state(null);

	function reset(): void {
		label = '';
		ttl = 24 * 60 * 60 * 1000;
		busy = false;
		result = null;
	}

	function close(): void {
		reset();
		onClose();
	}

	async function submit(event: Event): Promise<void> {
		event.preventDefault();
		const trimmed = label.trim();
		if (!trimmed) {
			pushToast('error', 'Label is required');
			return;
		}
		busy = true;
		try {
			const body: { label: string; ttlMs?: number } = { label: trimmed };
			if (ttl > 0) body.ttlMs = ttl;
			const r = await apiPost<{ encodedInvite: string; token: string; expiresAt?: string }>(
				'/auth/invites',
				body,
			);
			result = r;
			pushToast('success', 'Invite created');
			void refreshTrustCircle();
		} catch (err) {
			const code = err instanceof ApiError ? err.code : 'error';
			const msg = err instanceof Error ? err.message : String(err);
			pushToast('error', `Invite failed: ${msg} (${code})`);
		} finally {
			busy = false;
		}
	}

	async function copy(text: string): Promise<void> {
		try {
			await navigator.clipboard.writeText(text);
			pushToast('success', 'Copied to clipboard');
		} catch (err) {
			pushToast('error', `Copy failed: ${(err as Error).message}`);
		}
	}

	function onKey(event: KeyboardEvent): void {
		if (event.key === 'Escape') close();
	}
</script>

{#if open}
	<div class="backdrop" role="presentation" onclick={close}></div>
	<div
		class="dialog"
		role="dialog"
		aria-modal="true"
		aria-labelledby="invite-title"
		tabindex="-1"
		onkeydown={onKey}
	>
		<h3 id="invite-title">Invite a friend</h3>

		{#if !result}
			<form onsubmit={submit} class="stack">
				<div>
					<label for="invite-label">Label</label>
					<input
						id="invite-label"
						type="text"
						bind:value={label}
						placeholder="e.g. Mom's phone"
						required
						autocomplete="off"
					/>
				</div>
				<div>
					<label for="invite-ttl">Expires after</label>
					<select id="invite-ttl" bind:value={ttl}>
						{#each TTL_OPTIONS as opt (opt.value)}
							<option value={opt.value}>{opt.label}</option>
						{/each}
					</select>
				</div>
				<div class="actions">
					<button type="button" onclick={close} disabled={busy}>Cancel</button>
					<button type="submit" class="primary" disabled={busy}>
						{busy ? 'Creating…' : 'Create invite'}
					</button>
				</div>
			</form>
		{:else}
			<p class="muted">Share this invite with the new device. It can be scanned as a QR or pasted as text.</p>
			<div class="qr-wrap">
				<QrCode value={result.encodedInvite} size={224} />
			</div>
			<div class="token">
				<textarea readonly rows="3">{result.encodedInvite}</textarea>
				<button class="ghost" type="button" onclick={() => copy(result!.encodedInvite)} aria-label="Copy invite">
					<CopyIcon /> Copy
				</button>
			</div>
			{#if result.expiresAt}
				<p class="muted small">Expires {new Date(result.expiresAt).toLocaleString()}</p>
			{/if}
			<div class="actions">
				<button type="button" onclick={() => (result = null)}>Create another</button>
				<button type="button" class="primary" onclick={close}>Done</button>
			</div>
		{/if}
	</div>
{/if}

<style>
	.backdrop {
		position: fixed;
		inset: 0;
		background: rgba(15, 17, 22, 0.45);
		z-index: 1000;
	}
	.dialog {
		position: fixed;
		top: 50%;
		left: 50%;
		transform: translate(-50%, -50%);
		background: var(--color-surface);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-lg);
		box-shadow: var(--shadow-lg);
		padding: var(--space-5);
		width: min(28rem, calc(100vw - 2rem));
		max-height: calc(100vh - 2rem);
		overflow: auto;
		z-index: 1010;
	}
	.actions {
		display: flex;
		justify-content: flex-end;
		gap: 0.5rem;
		margin-top: var(--space-4);
	}
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
	.small { font-size: 0.85rem; }
</style>
