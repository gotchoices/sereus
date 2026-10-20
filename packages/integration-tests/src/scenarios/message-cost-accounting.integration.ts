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
 * The two-machine idle minute is the headline. On 2026-10-19 nearly every idle control read
 * became a `sync` request to the sibling (Optimystic's background check of a block read more
 * than 10 s after its last check, and a consult for every read of a never-written table). Now
 * an idle minute reads no control block and opens no `sync` stream: no pass runs inside it, and
 * the reads a pass makes are served from the view. Every remaining idle stream is a
 * `block-transfer` push from Optimystic's under-replication drain, which re-sends the blocks
 * the owner wrote alone before the member joined (`DEBUG=optimystic:db-p2p:*` shows them as
 * `under-replication-drain push:ok`); that cadence is Optimystic's. The strand idle minute
 * opens no Optimystic or Sereus stream at all; its 30 streams are ping and FRET upkeep.
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
