<script lang="ts">
	import { onMount } from 'svelte';
	import {
		diagnosticsState,
		startDiagnostics,
		stopDiagnostics,
		refreshDiagnostics,
		clearErrors,
		formatBytes,
		formatDuration,
		formatTimestamp,
	} from './lib/diagnostics.svelte.js';
	import Copyable from './lib/Copyable.svelte';

	const state = diagnosticsState();

	onMount(() => {
		startDiagnostics();
		return () => stopDiagnostics();
	});

	function onManualRefresh() {
		void refreshDiagnostics();
	}

	function percent(used: number | null, quota: number | null): string {
		if (used == null || quota == null || quota === 0) return '';
		return `(${((used / quota) * 100).toFixed(1)}%)`;
	}
</script>

<div class="diag">
	<header>
		<h2>Diagnostics</h2>
		<div class="meta">
			<span>updated {formatTimestamp(state.updatedMs)}</span>
			<button type="button" onclick={onManualRefresh}>Refresh now</button>
		</div>
	</header>

	<section class="card">
		<h3>Identity</h3>
		<dl>
			<dt>Peer ID</dt>
			<dd>
				{#if state.identity.peerId}
					<Copyable value={state.identity.peerId} />
				{:else}
					—
				{/if}
			</dd>
			<dt>Short</dt>
			<dd><code>{state.identity.peerIdShort ?? '—'}</code></dd>
			<dt>Persisted</dt>
			<dd>
				<span
					class="badge"
					class:ok={state.identity.persisted}
					data-testid="diag-identity-persisted"
					>{state.identity.persisted ? 'persisted ✓' : 'not persisted'}</span
				>
			</dd>
			<dt>First seen</dt>
			<dd>
				{formatTimestamp(state.identity.firstSeenMs)}
				{#if state.identity.ageMs != null}
					<span class="muted">(age {formatDuration(state.identity.ageMs)})</span>
				{/if}
			</dd>
		</dl>
	</section>

	<section class="card">
		<h3>Connectivity</h3>
		<dl>
			<dt>Status</dt>
			<dd>
				<span class="badge status-{state.connectivity.status}">
					{state.connectivity.status ?? '—'}
				</span>
			</dd>
			<dt>Listen addrs</dt>
			<dd>
				{#if state.connectivity.listenAddrs.length === 0}
					<span class="muted">none (browser cannot listen)</span>
				{:else}
					<ul class="addr-list">
						{#each state.connectivity.listenAddrs as addr (addr)}
							<li><Copyable value={addr} /></li>
						{/each}
					</ul>
				{/if}
			</dd>
			<dt>Paths</dt>
			<dd>
				<div class="path-summary" data-testid="diag-path-summary">
					<span class="badge" data-testid="diag-path-relayed"
						>relayed {state.connectivity.paths.relayed}</span
					>
					<span class="badge ok" data-testid="diag-path-direct"
						>direct {state.connectivity.paths.direct}</span
					>
					<span
						class="badge"
						class:bad={state.connectivity.paths.stuckOnRelay > 0}
						data-testid="diag-path-stuck"
						>stuck-on-relay {state.connectivity.paths.stuckOnRelay}</span
					>
					{#each Object.entries(state.connectivity.paths.byTransport) as [transport, count] (transport)}
						{#if count > 0}
							<span class="badge" data-transport={transport}
								><code>{transport}</code> {count}</span
							>
						{/if}
					{/each}
				</div>
				{#if state.connectivity.paths.stuckOnRelay > 0}
					<p class="bad warn-row" data-testid="diag-stuck-warning">
						⚠ {state.connectivity.paths.stuckOnRelay} connection{state.connectivity
							.paths.stuckOnRelay === 1
							? ''
							: 's'} stuck on relay — direct upgrade (WebRTC/DCUtR) did not
						complete within {Math.round(
							state.connectivity.paths.settleWindowMs / 1000,
						)}s.
					</p>
				{/if}
			</dd>
			<dt>Connections</dt>
			<dd>
				{#if state.connectivity.connections.length === 0}
					<span class="muted">0</span>
				{:else}
					<div class="conn-table">
						<table>
							<thead>
								<tr>
									<th>Peer</th>
									<th>Path</th>
									<th>Remote</th>
									<th>Dir</th>
									<th>Protocols</th>
								</tr>
							</thead>
							<tbody>
								{#each state.connectivity.connections as c (c.peerId + c.remoteAddr)}
									<tr
										data-testid="diag-connection-row"
										data-peer-id={c.peerId}
										data-kind={c.kind}
										data-transport={c.transport}
										data-stuck={c.stuckOnRelay}
									>
										<td>
											<Copyable value={c.peerId} label={c.peerIdShort} />
										</td>
										<td class="path-cell">
											<span
												class="badge"
												class:ok={c.kind === 'direct'}
												class:bad={c.stuckOnRelay}>{c.kind}</span
											>
											<code class="transport">{c.transport}</code>
											{#if c.stuckOnRelay}
												<span class="badge bad">stuck</span>
											{/if}
										</td>
										<td>
											<Copyable value={c.remoteAddr} />
										</td>
										<td>{c.direction}</td>
										<td class="protos">
											{#if c.protocols.length === 0}
												<span class="muted">none</span>
											{:else}
												{c.protocols.join(', ')}
											{/if}
										</td>
									</tr>
								{/each}
							</tbody>
						</table>
					</div>
				{/if}
			</dd>
		</dl>
	</section>

	<section class="card">
		<h3>Transports</h3>
		<dl>
			<dt>Registered</dt>
			<dd>
				{#if state.transports.names.length === 0}
					<span class="muted">—</span>
				{:else}
					<ul class="inline" data-testid="diag-transports">
						{#each state.transports.names as name (name)}
							<li data-transport-name={name}><code>{name}</code></li>
						{/each}
					</ul>
				{/if}
			</dd>
		</dl>
	</section>

	<section class="card">
		<h3>FRET</h3>
		{#if !state.fret.available}
			<p class="muted">FRET service is not registered on this node.</p>
		{:else}
			<dl>
				<dt>Known peers</dt>
				<dd>{state.fret.knownPeerCount}</dd>
				<dt>Network size</dt>
				<dd>
					{#if state.fret.networkSize}
						est. {state.fret.networkSize.estimate}
						<span class="muted"
							>(confidence {state.fret.networkSize.confidence.toFixed(2)},
							sources {state.fret.networkSize.sources})</span
						>
					{:else}
						<span class="muted">—</span>
					{/if}
				</dd>
				<dt>Churn</dt>
				<dd>
					{state.fret.churn != null
						? state.fret.churn.toFixed(3)
						: '—'}
				</dd>
				<dt>Partition</dt>
				<dd>
					{#if state.fret.partition === null}
						<span class="muted">—</span>
					{:else}
						<span class="badge" class:bad={state.fret.partition}>
							{state.fret.partition ? 'detected' : 'none'}
						</span>
					{/if}
				</dd>
				<dt>Last refresh</dt>
				<dd>{formatTimestamp(state.fret.lastTickMs)}</dd>
				<dt>My Arachnode</dt>
				<dd>
					{#if state.fret.myArachnode}
						ring depth {state.fret.myArachnode.ringDepth}
						<span class="muted">({state.fret.myArachnode.status})</span>
						<br />
						capacity {formatBytes(state.fret.myArachnode.capacityUsed)} /
						{formatBytes(state.fret.myArachnode.capacityTotal)}
						<span class="muted"
							>(avail {formatBytes(state.fret.myArachnode.capacityAvailable)})</span
						>
					{:else}
						<span class="muted">not announced yet</span>
					{/if}
				</dd>
				<dt>Known rings</dt>
				<dd>
					{#if state.fret.knownRings.length === 0}
						<span class="muted">—</span>
					{:else}
						{state.fret.knownRings.join(', ')}
					{/if}
				</dd>
			</dl>
		{/if}
	</section>

	<section class="card">
		<h3>Storage</h3>
		<dl>
			<dt>Backend</dt>
			<dd><code data-testid="diag-storage-backend">{state.storage.backend ?? '—'}</code></dd>
			<dt>Quota</dt>
			<dd>{formatBytes(state.storage.quotaBytes)}</dd>
			<dt>Origin usage</dt>
			<dd>
				{formatBytes(state.storage.usageBytes)}
				<span class="muted"
					>{percent(state.storage.usageBytes, state.storage.quotaBytes)}</span
				>
			</dd>
			<dt>Raw approx</dt>
			<dd>{formatBytes(state.storage.approxRawBytes)}</dd>
			<dt>Store counts</dt>
			<dd>
				{#if state.storage.storesError}
					<span class="bad">{state.storage.storesError}</span>
				{:else if state.storage.storeCounts}
					<ul class="store-counts">
						{#each Object.entries(state.storage.storeCounts) as [name, count] (name)}
							<li>
								<code>{name}</code>
								<span class="count">{count}</span>
							</li>
						{/each}
					</ul>
				{:else}
					<span class="muted">—</span>
				{/if}
			</dd>
		</dl>
	</section>

	<section class="card">
		<h3>Crypto sanity</h3>
		<ul class="checks" data-testid="diag-crypto">
			<li class:ok={state.crypto.cryptoSubtle} data-check="crypto.subtle" data-ok={state.crypto.cryptoSubtle}>
				<span class="check-icon">{state.crypto.cryptoSubtle ? '✓' : '✗'}</span>
				<code>crypto.subtle</code>
			</li>
			<li
				class:ok={state.crypto.cryptoGetRandomValues}
				data-check="crypto.getRandomValues"
				data-ok={state.crypto.cryptoGetRandomValues}
			>
				<span class="check-icon"
					>{state.crypto.cryptoGetRandomValues ? '✓' : '✗'}</span
				>
				<code>crypto.getRandomValues</code>
			</li>
			<li class:ok={state.crypto.eventTarget} data-check="EventTarget" data-ok={state.crypto.eventTarget}>
				<span class="check-icon">{state.crypto.eventTarget ? '✓' : '✗'}</span>
				<code>EventTarget</code>
			</li>
			<li
				class:ok={state.crypto.promiseWithResolvers}
				data-check="Promise.withResolvers"
				data-ok={state.crypto.promiseWithResolvers}
			>
				<span class="check-icon"
					>{state.crypto.promiseWithResolvers ? '✓' : '✗'}</span
				>
				<code>Promise.withResolvers</code>
			</li>
			<li
				class:ok={state.crypto.structuredClone}
				data-check="structuredClone"
				data-ok={state.crypto.structuredClone}
			>
				<span class="check-icon">{state.crypto.structuredClone ? '✓' : '✗'}</span>
				<code>structuredClone</code>
			</li>
			<li
				class:ok={state.crypto.readableStream}
				data-check="ReadableStream"
				data-ok={state.crypto.readableStream}
			>
				<span class="check-icon">{state.crypto.readableStream ? '✓' : '✗'}</span>
				<code>ReadableStream</code>
			</li>
			<li
				class:ok={state.crypto.bufferGlobal}
				data-check="globalThis.Buffer"
				data-ok={state.crypto.bufferGlobal}
			>
				<span class="check-icon">{state.crypto.bufferGlobal ? '✓' : '✗'}</span>
				<code>globalThis.Buffer</code>
			</li>
		</ul>
	</section>

	<section class="card">
		<header class="card-header">
			<h3>Recent errors</h3>
			<button type="button" onclick={clearErrors}>Clear</button>
		</header>
		{#if state.errors.length === 0}
			<p class="muted" data-testid="diag-errors" data-error-count="0">No errors captured.</p>
		{:else}
			<ul class="errors" data-testid="diag-errors" data-error-count={state.errors.length}>
				{#each state.errors as err, i (err.ts + ':' + i)}
					<li>
						<div class="err-meta">
							<span class="err-time">{new Date(err.ts).toLocaleTimeString()}</span>
							<span class="err-source">{err.source}</span>
						</div>
						<pre>{err.message}</pre>
					</li>
				{/each}
			</ul>
		{/if}
	</section>
</div>

<style>
	.diag {
		display: grid;
		gap: 1rem;
	}

	header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
	}

	h2 {
		margin: 0;
		font-size: 1.25rem;
		font-weight: 600;
	}

	.meta {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		color: #6c6f76;
		font-size: 0.8125rem;
	}

	.meta button {
		font-size: 0.75rem;
		padding: 0.25rem 0.625rem;
		border: 1px solid #d4d6db;
		border-radius: 0.25rem;
		background: white;
		cursor: pointer;
		font-family: inherit;
	}

	.card {
		border: 1px solid #e3e5ea;
		border-radius: 0.5rem;
		background: #fafbfc;
		padding: 0.875rem 1.125rem;
	}

	.card h3 {
		margin: 0 0 0.5rem 0;
		font-size: 0.875rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: #4a4d54;
	}

	.card-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		margin-bottom: 0.5rem;
	}
	.card-header h3 {
		margin: 0;
	}
	.card-header button {
		font-size: 0.7rem;
		padding: 0.125rem 0.5rem;
		border: 1px solid #d4d6db;
		border-radius: 0.25rem;
		background: white;
		cursor: pointer;
		font-family: inherit;
	}

	dl {
		display: grid;
		grid-template-columns: 8rem 1fr;
		row-gap: 0.375rem;
		column-gap: 1rem;
		margin: 0;
	}

	dt {
		font-size: 0.8125rem;
		color: #6c6f76;
		font-weight: 500;
	}

	dd {
		margin: 0;
		font-size: 0.875rem;
		word-break: break-word;
	}

	code {
		font-family: ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace;
		font-size: 0.85rem;
	}

	.muted {
		color: #8a8d94;
	}

	.badge {
		display: inline-block;
		font-size: 0.75rem;
		font-weight: 500;
		padding: 0.0625rem 0.5rem;
		border-radius: 999px;
		background: #eef0f4;
		color: #4a4d54;
	}

	.badge.ok {
		background: #d8f1e0;
		color: #1f7a3b;
	}

	.badge.bad {
		background: #fde0dd;
		color: #b3261e;
	}

	.bad {
		color: #b3261e;
	}

	.badge.status-running {
		background: #d8f1e0;
		color: #1f7a3b;
	}

	.badge.status-starting {
		background: #ffe9b3;
		color: #6b4d00;
	}

	.badge.status-stopped {
		background: #eef0f4;
		color: #4a4d54;
	}

	.addr-list,
	.inline,
	.store-counts,
	.checks,
	.errors {
		list-style: none;
		margin: 0;
		padding: 0;
	}

	.addr-list li {
		margin-bottom: 0.25rem;
	}

	.inline {
		display: flex;
		flex-wrap: wrap;
		gap: 0.375rem;
	}

	.inline code {
		background: #eef0f4;
		padding: 0.0625rem 0.375rem;
		border-radius: 0.25rem;
	}

	.path-summary {
		display: flex;
		flex-wrap: wrap;
		gap: 0.375rem;
		align-items: center;
	}

	.warn-row {
		margin: 0.5rem 0 0 0;
		font-size: 0.8125rem;
		font-weight: 500;
	}

	.path-cell {
		display: flex;
		flex-wrap: wrap;
		gap: 0.25rem;
		align-items: center;
	}

	.path-cell .transport {
		color: #6c6f76;
	}

	.conn-table {
		overflow-x: auto;
	}

	.conn-table table {
		width: 100%;
		border-collapse: collapse;
		font-size: 0.8125rem;
	}

	.conn-table th,
	.conn-table td {
		text-align: left;
		padding: 0.25rem 0.5rem;
		border-bottom: 1px solid #e3e5ea;
		vertical-align: top;
	}

	.conn-table th {
		font-weight: 500;
		color: #6c6f76;
		font-size: 0.75rem;
		text-transform: uppercase;
		letter-spacing: 0.04em;
	}

	.protos {
		font-family: ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace;
		font-size: 0.75rem;
	}

	.store-counts {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(8rem, 1fr));
		gap: 0.25rem 1rem;
	}

	.store-counts li {
		display: flex;
		justify-content: space-between;
		gap: 0.5rem;
	}

	.store-counts .count {
		color: #1d1f24;
		font-variant-numeric: tabular-nums;
	}

	.checks {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(11rem, 1fr));
		gap: 0.25rem 1rem;
	}

	.checks li {
		display: flex;
		align-items: center;
		gap: 0.375rem;
		color: #b3261e;
	}

	.checks li.ok {
		color: #1f7a3b;
	}

	.check-icon {
		font-weight: 700;
		width: 1rem;
		text-align: center;
	}

	.errors li {
		border-top: 1px solid #e3e5ea;
		padding: 0.5rem 0;
	}

	.errors li:first-child {
		border-top: none;
	}

	.err-meta {
		display: flex;
		gap: 0.5rem;
		font-size: 0.75rem;
		color: #6c6f76;
		margin-bottom: 0.25rem;
	}

	.err-source {
		font-family: ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace;
	}

	.errors pre {
		margin: 0;
		font-size: 0.75rem;
		font-family: ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace;
		white-space: pre-wrap;
		word-break: break-word;
		color: #b3261e;
	}
</style>
