<script lang="ts">
	import { apiPost, ApiError } from '../lib/api.js';
	import { pushToast, refreshGrants, type GrantListing } from '../lib/state.svelte.js';

	import TokenShare from './TokenShare.svelte';

	/** The part of a grant this modal shows; `POST /grants-admin` answers with no node counts. */
	type SharedGrant = Pick<GrantListing, 'token' | 'label' | 'maxNodes' | 'expiresAt'>;

	interface Props {
		open: boolean;
		/** An existing grant to re-share: the form is skipped and its token shown. */
		grant?: SharedGrant | null;
		onClose: () => void;
	}

	const { open, grant = null, onClose }: Props = $props();

	const DAY_MS = 24 * 60 * 60 * 1000;
	const TTL_OPTIONS = [
		{ label: '30 days', value: 30 * DAY_MS },
		{ label: '90 days', value: 90 * DAY_MS },
		{ label: '1 year', value: 365 * DAY_MS },
		{ label: 'No expiry', value: 0 },
	];

	let label = $state('');
	// A cleared number input binds as null (or undefined); either means "use the server default".
	let maxNodes: number | null | undefined = $state(null);
	let ttl: number = $state(0);
	let busy = $state(false);
	// Held only while the modal is open; closing drops it. Never written to browser storage.
	let issued = $state<SharedGrant | null>(null);

	const shown = $derived(issued ?? grant);

	function reset(): void {
		label = '';
		maxNodes = null;
		ttl = 0;
		busy = false;
		issued = null;
	}

	function close(): void {
		reset();
		onClose();
	}

	/** The request body, or an error message when the form cannot be sent as is. */
	function buildBody(): { label: string; maxNodes?: number; ttlMs?: number } | string {
		const trimmed = label.trim();
		if (!trimmed) return 'Label is required';
		const body: { label: string; maxNodes?: number; ttlMs?: number } = { label: trimmed };
		if (maxNodes !== null && maxNodes !== undefined) {
			if (!Number.isInteger(maxNodes) || maxNodes < 1) return 'Max nodes must be a whole number, 1 or more';
			body.maxNodes = maxNodes;
		}
		if (ttl > 0) body.ttlMs = ttl;
		return body;
	}

	async function submit(event: Event): Promise<void> {
		event.preventDefault();
		const body = buildBody();
		if (typeof body === 'string') {
			pushToast('error', body);
			return;
		}
		busy = true;
		try {
			const r = await apiPost<{ grant: SharedGrant }>('/grants-admin', body);
			issued = r.grant;
			pushToast('success', 'Grant issued');
			void refreshGrants();
		} catch (err) {
			const code = err instanceof ApiError ? err.code : 'error';
			const msg = err instanceof Error ? err.message : String(err);
			pushToast('error', `Issue failed: ${msg} (${code})`);
		} finally {
			busy = false;
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
		aria-labelledby="grant-title"
		tabindex="-1"
		onkeydown={onKey}
	>
		{#if !shown}
			<h3 id="grant-title">Issue a grant</h3>
			<form onsubmit={submit} class="stack">
				<div>
					<label for="grant-label">Label</label>
					<input
						id="grant-label"
						type="text"
						bind:value={label}
						placeholder="e.g. Alice's cadre"
						maxlength="200"
						required
						autocomplete="off"
					/>
				</div>
				<div>
					<label for="grant-max-nodes">Max nodes at once</label>
					<input
						id="grant-max-nodes"
						type="number"
						bind:value={maxNodes}
						placeholder="1"
						min="1"
						step="1"
					/>
				</div>
				<div>
					<label for="grant-ttl">Expires after</label>
					<select id="grant-ttl" bind:value={ttl}>
						{#each TTL_OPTIONS as opt (opt.value)}
							<option value={opt.value}>{opt.label}</option>
						{/each}
					</select>
				</div>
				<div class="actions">
					<button type="button" onclick={close} disabled={busy}>Cancel</button>
					<button type="submit" class="primary" disabled={busy}>
						{busy ? 'Issuing…' : 'Issue grant'}
					</button>
				</div>
			</form>
		{:else}
			<h3 id="grant-title">Grant for {shown.label}</h3>
			<p class="muted">
				In their app's Host Node settings, your friend enters this machine's address as the
				host URL and this token as the grant token. Anyone holding the token can ask this
				machine for nodes, so share it only with them.
			</p>
			<TokenShare value={shown.token} copyLabel="Copy grant token" />
			<p class="muted small">
				Up to {shown.maxNodes} node{shown.maxNodes === 1 ? '' : 's'} at once ·
				{shown.expiresAt ? `expires ${new Date(shown.expiresAt).toLocaleString()}` : 'never expires'}
			</p>
			<div class="actions">
				{#if issued}
					<button type="button" onclick={reset}>Issue another</button>
				{/if}
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
		overflow-wrap: anywhere;
		z-index: 1010;
	}
	.actions {
		display: flex;
		justify-content: flex-end;
		gap: 0.5rem;
		margin-top: var(--space-4);
	}
	.small { font-size: 0.85rem; }
</style>
