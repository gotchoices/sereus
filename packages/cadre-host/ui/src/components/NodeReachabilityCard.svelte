<script lang="ts">
	import type { Snippet } from 'svelte';

	import { ApiError } from '../lib/api.js';
	import {
		copyText,
		pushToast,
		refreshConnectivity,
		saveForward,
		type ManualForwardPatch,
		type NatStatusSnapshot,
		type NodeReachability,
	} from '../lib/state.svelte.js';
	import {
		forwardInstruction,
		manualPortText,
		parsePortField,
		routeLabel,
		verdictTone,
		VERDICT_LABEL,
	} from '../lib/reachability.js';

	import CopyIcon from './icons/CopyIcon.svelte';

	interface Props {
		node: NodeReachability;
		connectivity: NatStatusSnapshot;
		/** Leads the verdict line, e.g. the node's id and label on the Connectivity page. */
		header?: Snippet;
	}

	const { node, connectivity, header }: Props = $props();

	let tcpText = $state('');
	let wsText = $state('');
	/** Set on the first keystroke so a status refresh does not overwrite what the user is typing. */
	let edited = $state(false);
	let saving = $state(false);
	let formError: string | null = $state(null);

	const storedTcp = $derived(manualPortText(node.tcp));
	const storedWs = $derived(manualPortText(node.ws));
	const instruction = $derived(forwardInstruction(node, connectivity));
	const cgnatBlocked = $derived(connectivity.cgnatDetected && node.verdict === 'unreachable');
	const hasManual = $derived(storedTcp !== '' || storedWs !== '');

	// The fields follow the stored forward (saved from another tab or the CLI) until edited.
	$effect(() => {
		const tcp = storedTcp;
		const ws = storedWs;
		if (edited) return;
		tcpText = tcp;
		wsText = ws;
	});

	function save(event: SubmitEvent): void {
		event.preventDefault();
		const tcp = parsePortField(tcpText);
		const ws = node.ws ? parsePortField(wsText) : null;
		if (tcp === undefined || ws === undefined) {
			formError = 'Enter each port as a whole number from 1 to 65535, or leave it blank.';
			return;
		}
		void submit({ tcp, ws }, 'Saved the forwarded ports');
	}

	function clear(): void {
		void submit({ tcp: null, ws: null }, 'Cleared the forwarded ports');
	}

	async function submit(patch: ManualForwardPatch, done: string): Promise<void> {
		saving = true;
		formError = null;
		try {
			await saveForward(node.nodeId, patch);
			edited = false;
			pushToast('success', `${done} for ${node.nodeId}`);
		} catch (err) {
			reportSaveFailure(err);
		} finally {
			saving = false;
		}
	}

	function reportSaveFailure(err: unknown): void {
		if (err instanceof ApiError && err.code === 'unknown_node') {
			pushToast('error', `Node ${node.nodeId} is no longer running on this machine.`);
			void refreshConnectivity();
			return;
		}
		if (err instanceof ApiError && err.code === 'invalid_config') {
			formError = err.message;
			return;
		}
		const code = err instanceof ApiError ? err.code : 'error';
		pushToast('error', `Save failed: ${(err as Error).message} (${code})`);
	}
</script>

<div class="reach stack">
	<div class="row">
		{@render header?.()}
		<span class="badge {verdictTone(node.verdict)}">{VERDICT_LABEL[node.verdict]}</span>
		{#if !node.running}<span class="badge">stopped</span>{/if}
	</div>

	<dl class="kv">
		<div><dt>TCP</dt><dd>{routeLabel(node.tcp)}</dd></div>
		<div><dt>WebSocket</dt><dd>{routeLabel(node.ws)}</dd></div>
		<div>
			<dt>Public addresses</dt>
			<dd>
				{#if node.publicAddrs.length === 0}
					<span class="muted">none</span>
				{:else}
					<ul class="addrs">
						{#each node.publicAddrs as addr (addr)}
							<li>
								<code>{addr}</code>
								<button type="button" class="ghost" aria-label={`Copy ${addr}`} onclick={() => copyText(addr)}>
									<CopyIcon />
								</button>
							</li>
						{/each}
					</ul>
				{/if}
			</dd>
		</div>
	</dl>

	{#if node.reason}<p class="small">{node.reason}</p>{/if}
	{#if cgnatBlocked}
		<p class="small">cadre-host cannot reserve a relay for its nodes yet. If the carrier-grade NAT detection is wrong and you did forward ports, enter them below.</p>
	{/if}
	{#if instruction}<p class="small instruction">{instruction}</p>{/if}

	<details open={node.verdict === 'unreachable' || hasManual}>
		<summary>I forwarded these ports</summary>
		<form class="forward" onsubmit={save}>
			<div class="fields">
				<div>
					<label for={`fwd-tcp-${node.nodeId}`}>External TCP port (to {node.tcp.internalPort})</label>
					<input
						id={`fwd-tcp-${node.nodeId}`}
						type="text"
						inputmode="numeric"
						autocomplete="off"
						placeholder={String(node.tcp.internalPort)}
						bind:value={tcpText}
						oninput={() => (edited = true)}
					/>
				</div>
				{#if node.ws}
					<div>
						<label for={`fwd-ws-${node.nodeId}`}>External WebSocket port (to {node.ws.internalPort})</label>
						<input
							id={`fwd-ws-${node.nodeId}`}
							type="text"
							inputmode="numeric"
							autocomplete="off"
							placeholder={String(node.ws.internalPort)}
							bind:value={wsText}
							oninput={() => (edited = true)}
						/>
					</div>
				{/if}
			</div>
			{#if formError}<p class="error small">{formError}</p>{/if}
			<div class="actions">
				<button type="button" disabled={saving || !hasManual} onclick={clear}>Clear</button>
				<button type="submit" class="primary" disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
			</div>
			<p class="muted small">
				A blank field means no forward for that port. If the node's public addresses change, it restarts to announce them, at most once every 10 minutes.
			</p>
		</form>
	</details>
</div>

<style>
	.row { display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; }
	.kv {
		margin: 0;
		display: grid;
		grid-template-columns: max-content 1fr;
		gap: var(--space-1) var(--space-3);
		font-size: 0.9rem;
	}
	.kv > div { display: contents; }
	.kv dt { color: var(--color-text-muted); }
	.kv dd { margin: 0; min-width: 0; }
	.addrs { list-style: none; margin: 0; padding: 0; }
	.addrs li { display: flex; align-items: center; gap: 0.25rem; }
	.addrs code { word-break: break-all; }
	.reach p { margin: 0; }
	.instruction { font-weight: 500; }
	summary { cursor: pointer; font-size: 0.9rem; font-weight: 500; }
	.forward { display: grid; gap: var(--space-2); margin-top: var(--space-2); }
	.fields { display: grid; gap: var(--space-2); grid-template-columns: repeat(auto-fit, minmax(12rem, 1fr)); }
	.actions { display: flex; justify-content: flex-end; gap: 0.5rem; }
	.small { font-size: 0.85rem; }
	.error { color: var(--color-danger); }
</style>
