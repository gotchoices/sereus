<script lang="ts">
	import { onMount } from 'svelte';

	import { apiDelete, ApiError } from '../lib/api.js';
	import {
		appState,
		refreshStrands,
		pushToast,
		type StrandRemovalResult,
		type StrandSummary,
	} from '../lib/state.svelte.js';
	import {
		removalFeedback,
		requiresTypedConfirmation,
		type RemovalFeedback,
	} from '../lib/strand-removal.js';

	import ConfirmDialog from '../components/ConfirmDialog.svelte';

	function openMessage(id: string): string {
		return (
			`Every cadre node in your party will stop taking part in ${id}. The other parties ` +
			'in that network are unaffected — this only removes yours. You can re-join later ' +
			'by publishing the strand again.'
		);
	}

	function closedMessage(id: string): string {
		return (
			`This is irreversible. ${id} is a closed network, and your party’s membership key ` +
			'for it is stored only in the row you are about to delete. Once it is gone your ' +
			'party can never admit another member to that network, and re-publishing the ' +
			'strand would create a different key that its existing members will not accept. ' +
			'Every cadre node in your party will stop taking part in it. The other parties in ' +
			'that network are unaffected.'
		);
	}

	const NO_CONNECTIONS_NOTE =
		'This machine currently has no connection to your other cadre nodes. If you leave ' +
		'now, they may keep running this network until they sync.';

	const app = appState();

	// Typed through the generic rather than an annotation: with `: T | null = $state(null)`
	// TypeScript narrows the variable to `null` for the rest of the module scope, and the
	// `$derived` below then reads a property off `never`.
	let confirmStrand = $state<StrandSummary | null>(null);
	/** Id of a strand left while this machine saw no siblings; drives the banner. */
	let aloneNotice: string | null = $state(null);

	/** With no strand selected the dialog is closed, so the type is immaterial. */
	const gated = $derived(requiresTypedConfirmation(confirmStrand?.type ?? 'o'));

	/**
	 * What the card shows under any error line. An unfetched list is not an empty
	 * one, and a fetch that failed before any success has nothing to show at all —
	 * the error line above already speaks for it.
	 */
	const listView = $derived.by((): 'loading' | 'empty' | 'list' | 'none' => {
		if (app.strands.loaded) return app.strands.list.length === 0 ? 'empty' : 'list';
		return app.strands.error ? 'none' : 'loading';
	});

	onMount(() => {
		void refreshStrands();
	});

	function runState(strand: StrandSummary): string {
		if (!strand.running) return 'not running';
		return strand.status ? `running · ${strand.status}` : 'running';
	}

	async function leaveStrand(): Promise<void> {
		const strand = confirmStrand;
		if (!strand) return;
		// The dialog already collected the confirmation the node demands for a
		// closed strand; an open one is sent without it, never with it defaulted on.
		const query = requiresTypedConfirmation(strand.type) ? '?confirm=1' : '';
		try {
			const result = await apiDelete<StrandRemovalResult>(
				`/api/strands/${encodeURIComponent(strand.id)}${query}`,
			);
			report(removalFeedback(result));
			await refreshStrands();
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			if (err instanceof ApiError && err.status === 428) {
				// Should be unreachable — the page confirms before sending. Surface the
				// node's own wording rather than burying it under "Leave failed".
				pushToast('error', msg);
			} else {
				const code = err instanceof ApiError ? err.code : 'error';
				pushToast('error', `Leave failed: ${msg} (${code})`);
			}
		} finally {
			confirmStrand = null;
		}
	}

	/** Show the one piece of feedback `removalFeedback` chose. */
	function report(feedback: RemovalFeedback): void {
		if (feedback.kind === 'banner') aloneNotice = feedback.strandId;
		else pushToast(feedback.tone, feedback.text);
	}
</script>

<section class="stack">
	<header>
		<h2>Strands</h2>
		<p class="muted">
			Shared networks this party takes part in. Leaving one takes your whole party out of
			it. The other parties in that network are unaffected and keep running it.
		</p>
	</header>

	{#if aloneNotice}
		<div class="card warning" role="status">
			<p>
				You left <code>{aloneNotice}</code> while this machine had no connection to your
				other cadre nodes. The removal is recorded here, but your other nodes may keep
				running it until they reconnect and sync.
			</p>
			<div class="actions">
				<button onclick={() => (aloneNotice = null)}>Dismiss</button>
			</div>
		</div>
	{/if}

	<div class="card">
		<!-- The error line sits above the list rather than replacing it: a failed
		     refresh should not discard the last list that did load. -->
		{#if app.strands.error}
			<p class="error">Couldn’t load strands: {app.strands.error}</p>
		{/if}
		{#if listView === 'loading'}
			<p class="muted">Loading…</p>
		{:else if listView === 'empty'}
			<p class="muted">This party doesn’t take part in any shared networks yet.</p>
		{:else if listView === 'list'}
			<ul class="list">
				{#each app.strands.list as strand (strand.id)}
					<li>
						<div class="strand-main">
							<code class="strand-id">{strand.id}</code>
							<div class="row meta">
								<span class="badge {strand.type === 'c' ? 'warn' : 'info'}">
									{strand.type === 'c' ? 'Closed' : 'Open'}
								</span>
								<span class="muted small">{runState(strand)}</span>
							</div>
						</div>
						<button
							class="danger"
							onclick={() => (confirmStrand = strand)}
							aria-label={`Leave ${strand.id}`}
						>Leave</button>
					</li>
				{/each}
			</ul>
		{/if}
	</div>
</section>

<ConfirmDialog
	open={confirmStrand !== null}
	title={gated ? 'Leave this closed network?' : 'Leave this shared network?'}
	message={gated ? closedMessage(confirmStrand?.id ?? '') : openMessage(confirmStrand?.id ?? '')}
	note={app.strands.loaded && app.strands.controlConnections === 0 ? NO_CONNECTIONS_NOTE : undefined}
	requireText={gated ? (confirmStrand?.id ?? '') : undefined}
	confirmLabel="Leave"
	danger
	onConfirm={leaveStrand}
	onCancel={() => (confirmStrand = null)}
/>

<style>
	.list {
		list-style: none;
		padding: 0;
		margin: 0;
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}
	.list li {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-3);
		padding: var(--space-3);
		border: 1px solid var(--color-border);
		border-radius: var(--radius);
		background: var(--color-surface-alt);
	}
	.strand-main {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		min-width: 0;
	}
	.strand-id {
		/* Ids are arbitrary caller-chosen strings — long or opaque ones wrap
		   instead of widening the row, and stay selectable for copy-paste. */
		overflow-wrap: anywhere;
		user-select: text;
	}
	.error { color: var(--color-danger); }
	.meta { gap: 0.5rem; }
	.small { font-size: 0.85rem; }
	.warning {
		background: var(--color-warn-bg);
		border-color: var(--color-warn);
	}
	.warning code { overflow-wrap: anywhere; }
	.actions { display: flex; justify-content: flex-end; gap: 0.5rem; }
</style>
