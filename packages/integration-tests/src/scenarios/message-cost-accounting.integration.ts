/**
 * Message-cost ACCOUNTING — opt-in, and never part of `yarn test`.
 *
 * What forming and idling a two-member Sereus network costs, phase by phase: the streams each
 * libp2p node opens, per protocol (Optimystic, Sereus, and the libp2p / FRET upkeep), and the
 * block reads each Sereus caller makes. Three cases:
 * - `strand`: two single-machine parties, both relay-only through one dedicated loopback relay;
 *   A founds a closed strand, B forms and joins it, both write, then settle, idle and one steady
 *   write each side;
 * - `cadre`: one party, a phone-shaped owner admitting an always-on pinning member
 *   (`admitMember`: addDrone + seed + reconcile), then settle and idle;
 * - `invite`: the same party shape, the second machine redeeming a cadre invitation.
 *
 * It exists so the message-reduction tickets that cite `message-cost-accounting` (GitHub #50,
 * gotchoices/Optimystic#39) can each show a before and after against one instrument, instead of
 * each writing a throwaway one. It asserts nothing but completion; budgets belong in the pinned
 * cadre-core specs listed in docs/testing.md. Change what it measures only when you mean to make
 * older numbers incomparable, and say so in the ticket that does it.
 *
 * ── Running it ──
 *
 *   MESSAGE_COST_MEASURE=1 yarn workspace @serfab/integration-tests exec vitest run message-cost-accounting
 *
 * - `MESSAGE_COST_CASE=strand|cadre|invite` runs one case (default: all three, about 4 minutes).
 * - `MESSAGE_COST_IDLE_S=<s>` sets the idle phase (default 60).
 * - `MESSAGE_COST_STRANDS=<n>` (strand case) forms and joins n strands before idling; strands
 *   after the first are formed in one phase each, so the per-step breakdown is for the first only.
 *
 * ── How it counts ──
 *
 * - Streams: `connection.newStream` is wrapped on every connection of every node in the process
 *   (each CadreNode's control and strand nodes, found by a 20 ms poll, and the relay). A stream
 *   counts against the node that opened it as `opener->remote protocol`; a failed negotiation as
 *   `FAILED <first requested protocol>`. Streams opened inside another `connection:open` handler
 *   (identify) and in a node's first ~20 ms are not seen, so upkeep counts are a floor;
 *   Optimystic and Sereus protocol counts after bring-up are exact.
 * - Block reads: `NetworkTransactor.prototype.get` is wrapped; calls and block ids are counted
 *   per node (`localPeerId`) and per the first three cadre-core frames on the stack. `dupBlocks`
 *   is the number of block ids one node read more than once in the phase.
 * - A phase covers one awaited call; background work spills into the next phase, which is why
 *   the settle and idle phases exist.
 *
 * ── Baseline ──
 *
 * MEASURED_ON 2026-10-19: sereus `52ac437e`, `@optimystic/*` 1.15.0 linked at `f22a8cb7`,
 * `@quereus/quereus` 4.20.3, FRET 1.1.0, libp2p 3.3.11; Windows, Node, loopback. The idle minute
 * was identical across three runs; formation phases differ only in how background work splits
 * across adjacent phases. "app" streams are Optimystic and Sereus protocols; "upkeep" is
 * `/ipfs/*`, `/libp2p/*` and FRET.
 *
 *   strand               ms   app  upkeep  gets
 *   A start             533     0       2    44   36 from control schema/genesis writes
 *   A foundStrand       456     1       2    90   strand/Member read 11x
 *   B formStrand        293     1       2    66   at A: FormationInvite 5x, FormationUsage 4x, Revocation 14x
 *   B addStrand         530    26      10    31   25 sync B->A, one block at a time
 *   B first insert      451    24       3    56   20 sync + 4 cluster
 *   settle 15 s      15 003   110      39    84   44 block-transfer A->B; 38 sync + 20 cluster B->A
 *   idle 60 s        60 005    18      56   154   144 control reads; 18 sync from the revocation enforcer
 *   one steady write    ~60   6-7       0   1-2   4 cluster + 2-3 sync
 *
 *   cadre (admitMember)  join 362 ms, 22 app streams, 75 gets    idle 60 s: 103 sync, 133 gets
 *   invite (redeem)      join 1013 ms, 50 app streams, 79 gets   idle 60 s: 134 sync, 148 gets
 *
 * MEASURED_ON 2026-10-20, one run per case, after `control-reconcile-woken-by-changes-reads-once`
 * (the reconcile pass runs on change with a 2-minute backstop; membership reads are served from
 * the membership rows view):
 *
 *   cadre (admitMember)  join 398 ms, 8 app streams, 52 gets     settle 15 s: 92 app, 23 gets
 *                                                                idle 60 s: 34 app, 0 sync, 0 gets
 *   invite (redeem)      join 776 ms, 38 app streams, 73 gets    settle 15 s: 85 app, 25 gets
 *                                                                idle 60 s: 26 app, 0 sync, 0 gets
 *   strand               B addStrand 435 ms, 16 app, 20 gets     settle 15 s: 93 app, 73 gets
 *                                                                idle 60 s: 0 app, 30 upkeep, 0 gets
 *
 * The strand row is sereus `a19c28aa`, where the strand watcher, the pending-join runner and the
 * revocation enforcer also run on change instead of on a timer.
 *
 * 38 of the strand settle window's 73 gets (33 from `consumeInvite`, 5 from
 * `registerMemberPeer`) and B's 20 `/cluster` streams to A are B's single invitation redemption
 * and its `MemberPeer` binding commit. They land in the settle window because "A sees B insert"
 * waits for B's `App.Seat` row, not its `Strand.Member` row, and the membership reconciler
 * redeems in the background. `DEBUG='sereus:cadre:strand-membership*'` shows one
 * `Consumed invite` and no retry.
 *
 * The two-machine idle minute is the headline. On 2026-10-19 nearly every idle control read
 * became a `sync` request to the sibling (Optimystic's background check of a block read more
 * than 10 s after its last check, and a consult for every read of a never-written table). Now
 * an idle minute reads no control block and opens no `sync` stream: no pass runs inside it, and
 * the reads a pass makes are served from the view. Every remaining idle stream is a
 * `block-transfer` push from Optimystic's under-replication drain, which re-sends the blocks
 * the owner wrote alone before the member joined (`DEBUG=optimystic:db-p2p:*` shows them as
 * `under-replication-drain push:ok`); that cadence is Optimystic's. The strand idle minute
 * opens no Optimystic or Sereus stream at all; its 30 streams are ping and FRET upkeep.
 *
 * MEASURED_ON 2026-10-20, one run per column, before and after `join-backfill-pushes-once-and-is-waited-for`
 * (sereus `b1d85c22`, `@optimystic/*` 1.16.0 linked at `72ac338c`, the harness's in-memory storage).
 * Streams per direction, summed over the joiner's window (strand: B addStrand through settle;
 * invite: settle plus idle, the redemption itself being unchanged):
 *
 *   strand                before  after
 *   B addStrand ms           487    365   the push landed while B's database initialized; first probe passed
 *   B->A sync                 42     35   13 -> 2 inside B addStrand
 *   B->A block-transfer        2      0   B no longer pushes A's solo commits back to A
 *   A->B block-transfer       44     44   43 requests: one backfill push, 42 drain re-sends of its blocks
 *
 *   invite                before  after
 *   A->B block-transfer       92    182   +90 single-block `reason=rebalance` pushes (below)
 *   B->A block-transfer        6      5
 *
 * The invite case's growth is Optimystic's rebalance growth arm on the storage-profile owner: it
 * pushes a joiner each block whose cohort the joiner entered unless the owner's rebalance monitor
 * already counts the joiner as holding it, which the monitor learns only from pushes the owner
 * receives. The joiner used to push the owner's own blocks back (101 blocks), which taught it; now
 * the joiner skips blocks the owner signed. A run with that skip disabled showed no rebalance push
 * (settle 73 app streams, idle 28). `cohort-join-catch-up-runs-once-per-node` turns the growth arm
 * off where the backfill runs. The drain re-sends in both cases come about 7 s after the backfill
 * delivered the same blocks (`under-replication-drain pass:done ... pushed=42`); the drain has no way
 * to hear of the backfill's pushes (fixed by `optimystic-embedder-cannot-report-block-holders`, below).
 *
 * MEASURED_ON 2026-10-20, one run per column, before and after `cohort-join-catch-up-runs-once-per-node`
 * (sereus `b3437f7f`, same Optimystic link): a node that arms the backfill is built with Optimystic's
 * rebalance reaction off. Streams summed over settle plus idle:
 *
 *                               before  after
 *   invite A->B block-transfer     182     92   no `reason=rebalance` push (90 before); 91 are drain re-sends
 *   cadre  A->M block-transfer      96     96
 *   cadre  M->A block-transfer       7      5   M's 2 `reason=rebalance` pushes
 *
 * The strand case is unchanged (A->B block-transfer 44, B->A sync 35): its machines are transaction
 * profile, which runs no rebalance reaction.
 *
 * MEASURED_ON 2026-10-20, one run of all three cases, on the published Optimystic 1.17.0 and FRET
 * 1.2.1 (`adopt-optimystic-1-17-0`; sereus `ea3eed00`, `@optimystic/*` linked at `0e70f551`, FRET at
 * `439b85e`). The 2026-10-19 baseline already ran Optimystic 1.16.0's code (`f22a8cb7`), so what
 * 1.17.0 adds against it is #39, #42 and #43, and FRET's Fret#3:
 *
 *   strand               ms   app  upkeep  gets
 *   B addStrand         456     6       7    20   2 sync B->A, 2 block-transfer A->B
 *   B first insert      525    20       5    13   16 sync + 4 cluster
 *   settle 15 s      15 004    82      35    52   42 block-transfer A->B; 17 sync + 20 cluster B->A
 *   idle 60 s        60 007     0      30     0   24 /ipfs/ping, 6 FRET ping, none failed
 *   one steady write   ~150   6-7       0   1-2   4 cluster + 2-3 sync
 *
 *   cadre (admitMember)  join 696 ms, 27 app streams, 56 gets   settle 15 s: 83 app, 26 gets
 *                                                               idle 60 s: 32 app (all block-transfer), 0 sync, 0 gets
 *   invite (redeem)      join 965 ms, 51 app streams, 71 gets   settle 15 s: 74 app, 0 gets
 *                                                               idle 60 s: 28 app (all block-transfer), 0 sync, 0 gets
 *
 * What moved since 2026-10-19, by upstream change:
 * - #39 (one fetch per missing block; a collection open reads its log ends once): B addStrand's `sync`
 *   to A went 25 -> 13 between the 2026-10-19 23:28 and 2026-10-20 00:46 runs, the window in which both
 *   changes landed upstream and no Sereus change touched the strand attach; `join-backfill-pushes-once-
 *   and-is-waited-for` took it on to 2 (block above). B->A `sync` from addStrand through settle is 35,
 *   as in that block.
 * - #42 (groundwork only): the join window's `cluster` streams are unchanged, 4 for B's first insert and
 *   20 in settle, as on 2026-10-19.
 * - Fret#3 (foreign peers not re-probed): the strand idle minute's FRET pings went 32 -> 6, none failing
 *   (the 23:28 run had 20 between the strand nodes and 12 failed, 2 from each node to the relay and 2 each
 *   way between the control nodes), and upkeep 56 -> 30. The settle window still has 16 failed FRET pings,
 *   the run of three refused probes FRET needs before it leaves a foreign peer alone, and 9 `dcutr`
 *   streams per join, as before.
 * - #43 (one consult request per peer, block bytes only when the peer is ahead, a received commit counts
 *   as a check): not visible here. The cadre cases' idle `sync` went 103 and 134 -> 0 because the idle
 *   minute no longer reads anything (`control-reconcile-woken-by-changes-reads-once`, the 2026-10-20 block
 *   above). The steady writes' `sync` streams are single-block reads, which per-peer batching does not
 *   change, and this instrument counts streams, not the bytes the revision-only reply saves.
 *
 * The cadre and invite rows equal `cohort-join-catch-up-runs-once-per-node`'s runs: the admit phase's
 * growth from 8 app streams (2026-10-20 block above) to 27 is Sereus's, from the joins changed later
 * that day, not this release.
 *
 * MEASURED_ON 2026-10-21, one run of all three cases, after `optimystic-embedder-cannot-report-block-holders`
 * (the join catch-up reports each block the peer accepted through the node's `reportBlockHeld`;
 * `@optimystic/*` linked at `94cd25ea`, which also leaves `dcutr` out of a node with no directly
 * dialable address):
 *
 *   strand               B addStrand 195 ms, 7 app, 54 gets      settle 15 s: 31 app (was 82), 41 gets
 *                                                                idle 60 s: 0 app, 30 upkeep, 0 gets
 *   cadre (admitMember)  join 651 ms, 27 app streams, 54 gets   settle 15 s: 16 app (was 83), 23 gets
 *                                                                idle 60 s: 0 app (was 32), 0 gets
 *   invite (redeem)      join 767 ms, 51 app streams, 71 gets   settle 15 s: 7 app (was 74), 0 gets
 *                                                                idle 60 s: 0 app (was 28), 0 gets
 *
 * The strand settle window's 42 A->B drain re-sends are gone (2 block-transfer streams in B addStrand
 * remain, the backfill's push), and the cadre cases' idle minutes open no Optimystic or Sereus stream.
 *
 * MEASURED_ON 2026-10-25, one run of all three cases, 238 s, on Optimystic 1.19.0 (`adopt-optimystic-1-19-0`;
 * sereus `2e1b052c`, `@optimystic/*` linked at `cc87a138`, past the `v1.19.0` tag `f1f774ea` by two tickets
 * that change how a refused or short write is reported, not what a write sends; FRET 1.2.1). What 1.19.0
 * adds for this instrument is #42, a transaction's collections pended and committed together, one request
 * per member per phase:
 *
 *   strand               2026-10-21               2026-10-25
 *   B addStrand          195 ms, 7 app, 54 gets   234 ms, 9 app, 54 gets   5 sync B->A, 2 block-transfer A->B
 *   B first insert       (not broken out)         151 ms, 20 app, 8 gets   16 sync + 4 cluster, as on 2026-10-20
 *   settle 15 s          31 app, 41 gets          17 app, 35 gets          6 cluster + 7 sync B->A (2026-10-20: 20 + 17)
 *   idle 60 s            0 app, 30 upkeep         0 app, 30 upkeep
 *   one steady write     (not broken out)         6-7 app                  4 cluster + 2-3 sync, as on 2026-10-20
 *
 *   cadre (admitMember)  join 651 ms, 27 app, 54 gets   join 446 ms, 10 app, 51 gets
 *                        settle 16 app, 23 gets         settle 26 app, 23 gets
 *   invite (redeem)      join 767 ms, 51 app, 71 gets   join 637 ms, 33 app, 63 gets
 *                        settle 7 app, 0 gets           settle 7 app, 1 get
 *   both cadre cases     idle 60 s: 0 app, 0 gets       idle 60 s: 0 app, 0 gets
 *
 * - #42: the strand settle window's `cluster` streams went 20 -> 6. They are B's two membership commits,
 *   the invitation redemption (`consumeInvite`: `Member`, `ConsumedInvite` and their unique trees) and
 *   the `MemberPeer` binding (`registerMemberPeer`), which cost about 4 per collection before and 6
 *   between them now. B's first insert and the steady writes touch one collection (`App.Seat`,
 *   `App.Ledger`, no index), which #42 does not change, and still cost 4 `cluster` each.
 * - The cadre and invite joins also fell (27 -> 10 and 51 -> 33 app streams), but the cadre case's settle
 *   window rose 16 -> 26, so part of that is background work landing in the next phase. This is one run,
 *   and the 2026-10-21 block has no per-protocol breakdown to attribute the rest, or B addStrand's 7 -> 9.
 */

import { describe, it } from 'vitest'
import { generateKeyPair } from '@libp2p/crypto/keys'
import { peerIdFromPrivateKey } from '@libp2p/peer-id'
import type { Libp2p, Connection } from '@libp2p/interface'
import { NetworkTransactor } from '@optimystic/db-core'
import { CadreNode, generateStrandMemberKey } from '@serfab/cadre-core'
import type { StrandRow } from '@serfab/cadre-core'
import type { Database } from '@quereus/quereus'
import {
	waitUntil,
	controlNodeConfig,
	createSignedSAppConfig,
	makeOwnOwner,
	startDedicatedRelay,
	startPinningMember,
	admitMember,
	machinePeerIds,
	type DedicatedRelay,
	type InviteMember,
	buildPartyDevice,
	redeemWaitingForMember,
} from '../harness/index.js'

const SCHEMA = `
table Seat (Side text primary key, Sid text);
table Ledger (Id text primary key, Body text);
`
const SAPP_ID = 'sapp-message-cost-accounting'
const YEAR_MS = 365 * 24 * 3600_000
const SETTLE_MS = 15_000
const IDLE_MS = Number(process.env.MESSAGE_COST_IDLE_S ?? 60) * 1000
const STRAND_COUNT = Math.max(1, Number(process.env.MESSAGE_COST_STRANDS ?? 1))
const MEASURE = process.env.MESSAGE_COST_MEASURE === '1'
const ONLY_CASE = process.env.MESSAGE_COST_CASE
const TOP_CALLERS = 8

// ── instrumentation ──────────────────────────────────────────────────────────

interface PhaseRecord {
	name: string
	wallMs: number
	streams: Map<string, number>          // `${label}\t${protocol}`
	readsByNode: Map<string, { calls: number; blocks: number }>
	readsByCaller: Map<string, number>
	dupBlocks: number                     // block ids read more than once by the same node in the phase
	maxSameBlock: { key: string; n: number }
}

class Accounting {
	private readonly labels = new Map<string, string>()     // peerId → label
	private readonly watched = new Set<Libp2p>()
	private readonly wrapped = new Map<Connection, Connection['newStream']>()
	private readonly unsub: Array<() => void> = []
	private streams = new Map<string, number>()
	private readsByNode = new Map<string, { calls: number; blocks: number }>()
	private readsByCaller = new Map<string, number>()
	private blockHits = new Map<string, number>()
	private readonly restoreGet: () => void
	private readonly sources: Array<[string, CadreNode]> = []
	private readonly poller: ReturnType<typeof setInterval>
	private phaseStart = Date.now()
	readonly phases: PhaseRecord[] = []
	private readonly replacements: Array<[string, string]> = []

	constructor() {
		const proto = NetworkTransactor.prototype as unknown as { get: (...args: unknown[]) => Promise<unknown> }
		const original = proto.get
		// eslint-disable-next-line @typescript-eslint/no-this-alias
		const self = this
		proto.get = function (this: { localPeerId?: string }, ...args: unknown[]) {
			self.countRead(this.localPeerId, args[0] as { blockIds?: string[] } | undefined)
			return original.apply(this, args)
		}
		this.restoreGet = () => { proto.get = original }
		this.poller = setInterval(() => { this.discover() }, 20)
	}

	/** Rewrite run-specific ids (party ids, strand ids) in protocol names. */
	alias(text: string, as: string): void { this.replacements.push([text, as]) }

	addCadre(label: string, node: CadreNode): void {
		this.sources.push([label, node])
		this.discover()
	}

	addLibp2p(label: string, node: Libp2p): void {
		if (this.watched.has(node)) return
		this.watched.add(node)
		this.labels.set(node.peerId.toString(), label)
		for (const c of node.getConnections()) this.wrap(label, c)
		const onOpen = (e: CustomEvent<Connection>): void => { this.wrap(label, e.detail) }
		node.addEventListener('connection:open', onOpen)
		this.unsub.push(() => { node.removeEventListener('connection:open', onOpen) })
	}

	private discover(): void {
		for (const [label, cadre] of this.sources) {
			const ctl = cadre.getControlNode()
			if (ctl) this.addLibp2p(`${label}.ctl`, ctl)
			for (const [, inst] of cadre.getStrands()) {
				if (inst.libp2pNode) this.addLibp2p(`${label}.strand`, inst.libp2pNode)
			}
		}
	}

	private wrap(label: string, connection: Connection): void {
		if (this.wrapped.has(connection)) return
		const original = connection.newStream.bind(connection)
		this.wrapped.set(connection, connection.newStream)
		connection.newStream = async (protocols, options) => {
			try {
				const stream = await original(protocols, options)
				this.bump(this.streams, `${label}\t${connection.remotePeer.toString()}\t${this.norm(stream.protocol)}`)
				return stream
			} catch (err) {
				const first = Array.isArray(protocols) ? protocols[0] : protocols
				this.bump(this.streams, `${label}\t${connection.remotePeer.toString()}\tFAILED ${this.norm(String(first))}`)
				throw err
			}
		}
	}

	private countRead(localPeerId: string | undefined, gets: { blockIds?: string[] } | undefined): void {
		const node = localPeerId ?? '?'
		const ids = gets?.blockIds ?? []
		const entry = this.readsByNode.get(node) ?? { calls: 0, blocks: 0 }
		entry.calls += 1
		entry.blocks += ids.length
		this.readsByNode.set(node, entry)
		this.bump(this.readsByCaller, `${node}\t${asker()}`)
		for (const id of ids) this.bump(this.blockHits, `${node} ${id}`)
	}

	private bump(m: Map<string, number>, k: string): void { m.set(k, (m.get(k) ?? 0) + 1) }

	private norm(protocol: string): string {
		let p = protocol
		for (const [from, to] of this.replacements) p = p.split(from).join(to)
		return p
	}

	/** Pre-register a peer id (e.g. a control node's, known from its key before start). */
	label(peerId: string, label: string): void { this.labels.set(peerId, label) }

	private who(peerId: string): string { return this.labels.get(peerId) ?? `?${peerId.slice(-6)}` }

	private resolveKeys<V>(m: Map<string, V>, merge: (a: V, b: V) => V, fields: number[]): Map<string, V> {
		const out = new Map<string, V>()
		for (const [k, v] of m) {
			const parts = k.split('\t')
			for (const f of fields) parts[f] = this.who(parts[f]!)
			const nk = parts.join('\t')
			const prev = out.get(nk)
			out.set(nk, prev === undefined ? v : merge(prev, v))
		}
		return out
	}

	/** Close the current phase. */
	end(name: string): PhaseRecord {
		this.discover()
		const now = Date.now()
		let dupBlocks = 0
		let maxSameBlock = { key: '', n: 0 }
		for (const [k, n] of this.blockHits) {
			if (n > 1) dupBlocks += 1
			if (n > maxSameBlock.n) maxSameBlock = { key: `${this.who(k.split(' ')[0]!)} ${k.split(' ').slice(1).join(' ')}`, n }
		}
		const rec: PhaseRecord = {
			name, wallMs: now - this.phaseStart,
			streams: this.resolveKeys(this.streams, (a, b) => a + b, [1]),
			readsByNode: this.resolveKeys(this.readsByNode, (a, b) => ({ calls: a.calls + b.calls, blocks: a.blocks + b.blocks }), [0]),
			readsByCaller: this.resolveKeys(this.readsByCaller, (a, b) => a + b, [0]),
			dupBlocks, maxSameBlock,
		}
		this.phases.push(rec)
		this.streams = new Map()
		this.readsByNode = new Map()
		this.readsByCaller = new Map()
		this.blockHits = new Map()
		this.phaseStart = now
		print(rec)
		return rec
	}

	async phase<T>(name: string, fn: () => Promise<T>): Promise<T> {
		const out = await fn()
		this.discover()
		this.end(name)
		return out
	}

	stop(): void {
		clearInterval(this.poller)
		this.restoreGet()
		for (const u of this.unsub) u()
		for (const [c, orig] of this.wrapped) c.newStream = orig
		this.wrapped.clear()
	}
}

/** The first cadre-core frames on the stack (async frames included), or the first non-library one. */
function asker(): string {
	const limit = Error.stackTraceLimit
	Error.stackTraceLimit = 80
	const stack = new Error().stack ?? ''
	Error.stackTraceLimit = limit
	const frames = stack.split('\n').slice(1).map(line => line.trim()).filter(line => !line.includes('integration.ts'))
	const cadre = frames.filter(line => /cadre-core[/\\](dist|src)[/\\]/.test(line)).slice(0, 3)
	const chosen = cadre.length ? cadre : [frames.find(line => !/@optimystic|optimystic[/\\]packages|@quereus|quereus[/\\]packages|node:internal|<anonymous>/.test(line)) ?? '?']
	return chosen.map(frame => {
		const named = frame.match(/at (?:async )?([\w.$<>]+) \(/)?.[1]
		const file = frame.match(/([\w.-]+\.[mc]?[jt]s):(\d+)/)
		const where = file ? `${file[1]}:${file[2]}` : '?'
		return named && named.length > 2 ? named : `${named ?? ''}@${where}`
	}).join(' < ')
}

function sum(m: Map<string, number>): number { return [...m.values()].reduce((a, b) => a + b, 0) }

function print(rec: PhaseRecord): void {
	const lines: string[] = []
	const readCalls = [...rec.readsByNode.values()].reduce((a, b) => a + b.calls, 0)
	const readBlocks = [...rec.readsByNode.values()].reduce((a, b) => a + b.blocks, 0)
	lines.push(`\n=== [acct] phase "${rec.name}"  wall=${rec.wallMs} ms  streams=${sum(rec.streams)}  reads=${readCalls} calls / ${readBlocks} block ids  dupBlocks=${rec.dupBlocks}${rec.maxSameBlock.n > 1 ? ` (max ${rec.maxSameBlock.n}x ${rec.maxSameBlock.key.slice(0, 80)})` : ''}`)
	if (rec.streams.size) {
		lines.push('  outbound streams (node, protocol):')
		for (const [k, n] of [...rec.streams].sort((a, b) => a[0].localeCompare(b[0]))) {
			const [label, remote, proto] = k.split('\t')
			lines.push(`    ${String(n).padStart(5)}  ${`${label}->${remote}`.padEnd(20)} ${proto}`)
		}
	}
	if (rec.readsByNode.size) {
		lines.push('  block reads by node (get calls / block ids):')
		for (const [k, v] of [...rec.readsByNode].sort((a, b) => a[0].localeCompare(b[0]))) {
			lines.push(`    ${String(v.calls).padStart(5)} / ${String(v.blocks).padEnd(5)} ${k}`)
		}
		lines.push(`  top callers (of ${rec.readsByCaller.size}):`)
		for (const [k, n] of [...rec.readsByCaller].sort((a, b) => b[1] - a[1]).slice(0, TOP_CALLERS)) {
			const [node, caller] = k.split('\t')
			lines.push(`    ${String(n).padStart(5)}  ${node!.padEnd(9)} ${caller}`)
		}
	}
	console.log(lines.join('\n'))
}

function printSummary(title: string, phases: PhaseRecord[]): void {
	const lines = [`\n##### [acct-summary] ${title}`, '  phase | wall ms | streams (non-maint) | maint streams | get calls | block ids']
	for (const p of phases) {
		let maint = 0
		let other = 0
		for (const [k, n] of p.streams) {
			const proto = k.split('\t')[2]!
			if (/\/ipfs\/|\/libp2p\/|\/fret\//.test(proto)) maint += n; else other += n
		}
		const calls = [...p.readsByNode.values()].reduce((a, b) => a + b.calls, 0)
		const blocks = [...p.readsByNode.values()].reduce((a, b) => a + b.blocks, 0)
		lines.push(`  ${p.name} | ${p.wallMs} | ${other} | ${maint} | ${calls} | ${blocks}`)
	}
	console.log(lines.join('\n'))
}

async function rows(db: Database, sql: string): Promise<Record<string, unknown>[]> {
	const out: Record<string, unknown>[] = []
	for await (const row of db.eval(sql)) out.push({ ...row })
	return out
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

// ── case 1: two-party strand ─────────────────────────────────────────────────

async function strandCase(): Promise<void> {
	const acct = new Accounting()
	let relay: DedicatedRelay | undefined
	let A: CadreNode | undefined
	let B: CadreNode | undefined
	try {
		const runTag = Date.now()
		const strandId = `strand-acct-${runTag}`
		const aParty = `acct-a-${runTag}`
		const bParty = `acct-b-${runTag}`
		acct.alias(strandId, '<strand>')
		acct.alias(aParty, '<partyA>')
		acct.alias(bParty, '<partyB>')
		const sApp = createSignedSAppConfig(SCHEMA, '0.1.0')
		relay = await startDedicatedRelay()
		acct.label(relay.peerId, 'relay')
		acct.addLibp2p('relay', relay.node as unknown as Libp2p)
		acct.end('(relay start)')

		const aKey = await generateKeyPair('Ed25519')
		const nodeA = new CadreNode(controlNodeConfig({ partyId: aParty, privateKey: aKey, listenAddrs: [], relayAddrs: [relay.dialAddr] }))
		A = nodeA
		acct.label(peerIdFromPrivateKey(aKey).toString(), 'A.ctl')
		acct.addCadre('A', nodeA)
		await acct.phase('A start', () => nodeA.start())
		await acct.phase('A make owner', () => makeOwnOwner(nodeA))
		const memberPrivateKey = await generateStrandMemberKey()
		const founded = await acct.phase('A foundStrand', () =>
			nodeA.foundStrand({ strandId, type: 'c', memberPrivateKey, sAppConfig: sApp }))
		const aDb = founded.instance.database!.getDatabase()
		await acct.phase('A first insert', () => aDb.exec(`insert into App.Seat (Side, Sid) values ('S', 'sid-a');
insert into App.Ledger (Id, Body) values ('a-1', 'founder');`, undefined, { transaction: true }))
		const invitation = await acct.phase('A invite+publish', async () => {
			const inv = await nodeA.createOpenInvitation(SAPP_ID, YEAR_MS)
			await nodeA.publishFormationInvite(inv.token, SAPP_ID, { strandId, expiresAtMs: Date.now() + YEAR_MS, totalUses: 1 })
			return inv
		})

		const bKey = await generateKeyPair('Ed25519')
		const nodeB = new CadreNode(controlNodeConfig({ partyId: bParty, privateKey: bKey, listenAddrs: [], relayAddrs: [relay.dialAddr] }))
		B = nodeB
		acct.label(peerIdFromPrivateKey(bKey).toString(), 'B.ctl')
		acct.addCadre('B', nodeB)
		await acct.phase('B start', () => nodeB.start())
		await acct.phase('B make owner', () => makeOwnOwner(nodeB))
		const formed = await acct.phase('B formStrand', () =>
			nodeB.formStrand(nodeB.decodeInvitation(nodeA.encodeInvitation(invitation)), { partyId: bParty, purpose: 'message-cost accounting' }))
		const bRow: StrandRow = { Id: strandId, MemberPrivateKey: formed.memberPrivateKey ?? null, Type: 'c', FounderOwnerKey: null, FounderPeerId: null }
		await acct.phase('B addStrand', () => nodeB.addStrand({ strandRow: bRow, sAppConfig: sApp, awaitFirstSync: false }))
		const bInst = await acct.phase('B whenStrandWritable', () => nodeB.whenStrandWritable(strandId, { timeoutMs: 300_000 }))
		const bDb = bInst.database!.getDatabase()
		await acct.phase('B first insert', () => bDb.exec(`insert into App.Seat (Side, Sid) values ('F', 'sid-b');`, undefined, { transaction: true }))
		await acct.phase('A sees B insert', () => waitUntil(async () => (await rows(aDb, 'select Side from App.Seat')).length === 2,
			{ timeoutMs: 120_000, intervalMs: 250, description: "the joiner's seat reaches the founder" }))
		for (let n = 2; n <= STRAND_COUNT; n++) {
			const extraId = `strand-acct${n}-${runTag}`
			acct.alias(extraId, `<strand${n}>`)
			await acct.phase(`strand #${n} found + form + join`, () => joinExtraStrand(nodeA, nodeB, bParty, extraId, sApp))
		}
		await acct.phase(`settle ${SETTLE_MS / 1000}s`, () => sleep(SETTLE_MS))
		await acct.phase(`idle ${IDLE_MS / 1000}s`, () => sleep(IDLE_MS))
		await acct.phase('A steady write', () => aDb.exec(`insert into App.Ledger (Id, Body) values ('a-2', 'steady');`, undefined, { transaction: true }))
		await acct.phase('B sees A write', () => waitUntil(async () => (await rows(bDb, "select Id from App.Ledger where Id = 'a-2'")).length === 1,
			{ timeoutMs: 120_000, intervalMs: 250, description: "A's steady write reaches B" }))
		await acct.phase('B steady write', () => bDb.exec(`insert into App.Ledger (Id, Body) values ('b-2', 'steady');`, undefined, { transaction: true }))
		await acct.phase('A sees B write', () => waitUntil(async () => (await rows(aDb, "select Id from App.Ledger where Id = 'b-2'")).length === 1,
			{ timeoutMs: 120_000, intervalMs: 250, description: "B's steady write reaches A" }))
		printSummary('two-party strand', acct.phases)
	} finally {
		acct.stop()
		await Promise.allSettled([B?.stop(), A?.stop()])
		await relay?.stop()
	}
}

/** Found, invite, form and join one more strand between A and B, and have B write to it once. */
async function joinExtraStrand(founder: CadreNode, joiner: CadreNode, joinerParty: string, strandId: string, sApp: ReturnType<typeof createSignedSAppConfig>): Promise<void> {
	await founder.foundStrand({ strandId, type: 'c', memberPrivateKey: await generateStrandMemberKey(), sAppConfig: sApp })
	const invitation = await founder.createOpenInvitation(SAPP_ID, YEAR_MS)
	await founder.publishFormationInvite(invitation.token, SAPP_ID, { strandId, expiresAtMs: Date.now() + YEAR_MS, totalUses: 1 })
	const formed = await joiner.formStrand(joiner.decodeInvitation(founder.encodeInvitation(invitation)), { partyId: joinerParty, purpose: 'message-cost accounting' })
	const row: StrandRow = { Id: strandId, MemberPrivateKey: formed.memberPrivateKey ?? null, Type: 'c', FounderOwnerKey: null, FounderPeerId: null }
	await joiner.addStrand({ strandRow: row, sAppConfig: sApp, awaitFirstSync: false })
	const db = (await joiner.whenStrandWritable(strandId, { timeoutMs: 300_000 })).database!.getDatabase()
	await db.exec(`insert into App.Seat (Side, Sid) values ('F', 'sid-b');`, undefined, { transaction: true })
}

// ── case 2: two-machine cadre, one party ─────────────────────────────────────

async function cadreCase(): Promise<void> {
	const acct = new Accounting()
	let A: CadreNode | undefined
	let M: InviteMember | undefined
	try {
		const runTag = Date.now()
		const partyId = `acct-cadre-${runTag}`
		acct.alias(partyId, '<party>')
		const aKey = await generateKeyPair('Ed25519')
		const nodeA = new CadreNode(controlNodeConfig({ partyId, privateKey: aKey, profile: 'transaction', strandFilter: 'none', listenAddrs: [] }))
		A = nodeA
		acct.label(peerIdFromPrivateKey(aKey).toString(), 'A.ctl')
		acct.addCadre('A', nodeA)
		await acct.phase('A start', () => nodeA.start())
		const owner = await acct.phase('A make owner', () => makeOwnOwner(nodeA))
		const mKey = await generateKeyPair('Ed25519')
		acct.label(peerIdFromPrivateKey(mKey).toString(), 'M.ctl')
		const member = await acct.phase('M start (pinning)', () => startPinningMember(partyId, owner.publicKey, { key: mKey }))
		M = member
		acct.addCadre('M', member.node)
		await acct.phase('A admits M (addDrone+seed+reconcile)', () => admitMember(nodeA, member, 60_000))
		const both = [nodeA.peerId!.toString(), member.peerId].sort()
		await acct.phase('both list both machines', () => waitUntil(async () => {
			const [a, m] = await Promise.all([machinePeerIds(nodeA), machinePeerIds(member.node)])
			return both.every(p => a.includes(p)) && both.every(p => m.includes(p))
		}, { timeoutMs: 120_000, intervalMs: 250, description: 'both machines list both' }))
		await acct.phase(`settle ${SETTLE_MS / 1000}s`, () => sleep(SETTLE_MS))
		await acct.phase(`idle ${IDLE_MS / 1000}s`, () => sleep(IDLE_MS))
		printSummary('two-machine cadre', acct.phases)
	} finally {
		acct.stop()
		await Promise.allSettled([M?.node.stop(), A?.stop()])
	}
}

// ── case 3: two-machine cadre, second machine joins by cadre invitation ─────

async function cadreInviteCase(): Promise<void> {
	const acct = new Accounting()
	let A: CadreNode | undefined
	let B: CadreNode | undefined
	try {
		const runTag = Date.now()
		const partyId = `acct-inv-${runTag}`
		acct.alias(partyId, '<party>')
		const aKey = await generateKeyPair('Ed25519')
		const nodeA = new CadreNode(controlNodeConfig({ partyId, privateKey: aKey, profile: 'storage', strandFilter: 'none' }))
		A = nodeA
		acct.label(peerIdFromPrivateKey(aKey).toString(), 'A.ctl')
		acct.addCadre('A', nodeA)
		await acct.phase('A start (storage, listening)', () => nodeA.start())
		await acct.phase('A make owner', () => makeOwnOwner(nodeA))
		const created = await acct.phase('A createCadreInvitation', () => nodeA.createCadreInvitation())
		const bKey = await generateKeyPair('Ed25519')
		acct.label(peerIdFromPrivateKey(bKey).toString(), 'B.ctl')
		const nodeB = await buildPartyDevice(partyId, bKey)
		B = nodeB
		acct.addCadre('B', nodeB)
		await acct.phase('B start (phone-shaped)', () => nodeB.start())
		await acct.phase('B redeemCadreInvitation', () => redeemWaitingForMember(nodeB, created.invitation, 120_000, 'acct-invite'))
		const both = [nodeA.peerId!.toString(), nodeB.peerId!.toString()].sort()
		await acct.phase('both list both machines', () => waitUntil(async () => {
			const [a, b] = await Promise.all([machinePeerIds(nodeA), machinePeerIds(nodeB)])
			return both.every(p => a.includes(p)) && both.every(p => b.includes(p))
		}, { timeoutMs: 120_000, intervalMs: 250, description: 'both machines list both' }))
		await acct.phase(`settle ${SETTLE_MS / 1000}s`, () => sleep(SETTLE_MS))
		await acct.phase(`idle ${IDLE_MS / 1000}s`, () => sleep(IDLE_MS))
		printSummary('two-machine cadre (invitation)', acct.phases)
	} finally {
		acct.stop()
		await Promise.allSettled([B?.stop(), A?.stop()])
	}
}

describe.runIf(MEASURE)('message-cost accounting (opt-in: MESSAGE_COST_MEASURE=1)', () => {
	const wants = (name: string): boolean => ONLY_CASE === undefined || ONLY_CASE === name
	it.runIf(wants('strand'))('two-party strand: form + idle', async () => { await strandCase() }, 900_000)
	it.runIf(wants('cadre'))('two-machine cadre: form + idle', async () => { await cadreCase() }, 900_000)
	it.runIf(wants('invite'))('two-machine cadre by invitation: form + idle', async () => { await cadreInviteCase() }, 900_000)
})
