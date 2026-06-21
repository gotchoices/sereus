import { createHmac } from 'node:crypto'

// check-turn-creds.mjs — validate the TURN credential scheme served by
// ops/docker/turn-credential-issuer/ (the dynamic ICE-config manifest).
//
// Two modes:
//
//   --self-test   Agent-runnable, NO network. Pins the credential scheme
//                 (base64-not-base64url, `<expiry>:<id>` username, HMAC-SHA1
//                 digest) against a fixed vector, and drives the gating matrix
//                 (when is a TURN entry emitted?). This is the floor that keeps
//                 the issuer and any client in sync.
//
//   --url <u>     Live check (NOT agent-runnable — needs a deployed issuer).
//                 Fetch the manifest, assert a STUN entry is present, and when a
//                 TURN entry is present: parse `username` as `<future-unix>:<id>`
//                 and, if --secret is given, re-derive the HMAC and assert it
//                 matches the served `credential`. Like check-stun.mjs, this
//                 requires a deployed server (see ops/test/README.md).
//
// The HMAC + gating below MIRROR ops/docker/turn-credential-issuer/src/main.ts
// (mintTurnCredential / buildManifest / shouldEmitTurn). Keep them in sync — the
// pinned vector is the lock that catches drift.

// --- Scheme (mirror of mintTurnCredential) ---------------------------------

function sanitizeId (id) {
  return id.replace(/[^A-Za-z0-9._-]/g, '') || 'client'
}

function mintCredential (secret, expiry, id) {
  const username = `${expiry}:${sanitizeId(id)}`
  // STANDARD base64 with padding — NOT base64url. coturn rejects a mismatch.
  const credential = createHmac('sha1', secret).update(username).digest('base64')
  return { username, credential }
}

// --- Gating (mirror of shouldEmitTurn / buildManifest) ----------------------

function shouldEmitTurn (cfg) {
  return Boolean(cfg.turnEnabled) &&
    typeof cfg.turnSecret === 'string' && cfg.turnSecret.length > 0 &&
    Array.isArray(cfg.turnUrls) && cfg.turnUrls.length > 0 &&
    (cfg.turnPolicy === 'gated' || cfg.turnPolicy === 'on')
}

// --- Self-test --------------------------------------------------------------

// Pinned vector. If you change the scheme, this MUST change too — that is the
// point. Recomputed independently by anyone implementing a client.
const PINNED = {
  secret: 'test-secret-do-not-use',
  expiry: 1735689600,
  id: 'web',
  username: '1735689600:web',
  credential: 'zjHGi3Op+GDVwe3+VlIssA1POfs=',
}

function assert (cond, msg) {
  if (!cond) throw new Error(`assertion failed: ${msg}`)
}

function selfTest () {
  let n = 0
  const check = (cond, msg) => { assert(cond, msg); n++; console.log(`  ok ${msg}`) }

  // 1. Pinned HMAC vector — locks digest + separator + secret handling.
  const { username, credential } = mintCredential(PINNED.secret, PINNED.expiry, PINNED.id)
  check(username === PINNED.username, `username = ${PINNED.username}`)
  check(credential === PINNED.credential, `credential = ${PINNED.credential}`)

  // 2. Standard base64 (padding, no - or _) — a base64url slip silently breaks coturn.
  check(!/[-_]/.test(credential), 'credential is standard base64 (no - or _)')
  check(/=*$/.test(credential) && credential.includes('='), 'credential carries base64 padding')

  // 3. id sanitization — the `:` separator must never appear inside <id>.
  const malicious = mintCredential(PINNED.secret, 100, 'we:b/../x')
  check(malicious.username.split(':').length === 2, 'sanitized id cannot inject a `:` separator')
  const empty = mintCredential(PINNED.secret, 100, '!!!')
  check(empty.username === '100:client', 'empty-after-sanitize id falls back to `client`')

  // 4. Gating matrix — TURN entry emitted ONLY when enabled+secret+urls+policy(gated|on).
  const url = ['turn:turn.sereus.org:3478?transport=udp']
  const matrix = [
    ['disabled', { turnEnabled: false, turnSecret: 's', turnUrls: url, turnPolicy: 'on' }, false],
    ['no secret', { turnEnabled: true, turnSecret: '', turnUrls: url, turnPolicy: 'gated' }, false],
    ['no urls', { turnEnabled: true, turnSecret: 's', turnUrls: [], turnPolicy: 'gated' }, false],
    ['policy=off', { turnEnabled: true, turnSecret: 's', turnUrls: url, turnPolicy: 'off' }, false],
    ['gated', { turnEnabled: true, turnSecret: 's', turnUrls: url, turnPolicy: 'gated' }, true],
    ['on', { turnEnabled: true, turnSecret: 's', turnUrls: url, turnPolicy: 'on' }, true],
  ]
  for (const [name, cfg, expect] of matrix) {
    check(shouldEmitTurn(cfg) === expect, `gating[${name}] emits TURN = ${expect}`)
  }

  console.log(`\nself-test ok: ${n} checks passed`)
}

// --- Live check -------------------------------------------------------------

function findEntry (iceServers, scheme) {
  return iceServers.find((s) => {
    const urls = Array.isArray(s.urls) ? s.urls : [s.urls]
    return urls.some((u) => typeof u === 'string' && u.startsWith(scheme))
  })
}

async function liveCheck (url, secret) {
  console.log(`fetching manifest: ${url}`)
  const res = await fetch(url, { headers: { accept: 'application/json' } })
  if (!res.ok) throw new Error(`manifest fetch returned HTTP ${res.status}`)
  const manifest = await res.json()

  assert(Array.isArray(manifest.iceServers), 'manifest.iceServers is an array')
  const stun = findEntry(manifest.iceServers, 'stun:')
  assert(stun, 'manifest advertises at least one stun: entry')
  console.log(`  ok stun entry present (turnPolicy=${manifest.turnPolicy ?? 'unset'})`)

  const turn = findEntry(manifest.iceServers, 'turn:')
  if (!turn) {
    console.log('  note: no turn: entry (STUN-only manifest) — nothing further to verify')
    return
  }

  assert(typeof turn.username === 'string' && typeof turn.credential === 'string',
    'turn entry carries username + credential')
  const parts = turn.username.split(':')
  assert(parts.length === 2, 'turn username parses as <expiry>:<id>')
  const expiry = Number.parseInt(parts[0], 10)
  const nowSec = Math.floor(Date.now() / 1000)
  assert(Number.isFinite(expiry) && expiry > nowSec, `turn username expiry (${expiry}) is in the future`)
  console.log(`  ok turn entry username=${turn.username} expires in ${expiry - nowSec}s`)

  if (secret) {
    const expected = createHmac('sha1', secret).update(turn.username).digest('base64')
    assert(expected === turn.credential,
      'served credential matches HMAC-SHA1(secret, username) — issuer secret matches coturn')
    console.log('  ok served credential matches re-derived HMAC')
  } else {
    console.log('  note: pass --secret <TURN_SECRET> to verify the served credential HMAC')
  }

  console.log('\nlive check ok')
}

// --- CLI --------------------------------------------------------------------

function usage () {
  console.log(`Usage:
  node sereus/ops/test/check-turn-creds.mjs --self-test
  node sereus/ops/test/check-turn-creds.mjs --url <manifest-url> [--secret <TURN_SECRET>]

Modes:
  --self-test   Pin the credential scheme + gating matrix. No network; agent-runnable.
  --url         Fetch a deployed issuer's /ice-servers.json and validate it.
                Requires a deployed server (see ops/test/README.md).

Options:
  --secret      Shared TURN secret; with --url, re-derives + checks the HMAC.
`)
}

function parseArgs (argv) {
  const args = { selfTest: false, url: null, secret: null }
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--self-test') args.selfTest = true
    else if (a === '--url') args.url = argv[++i]
    else if (a === '--secret') args.secret = argv[++i]
    else if (a === '-h' || a === '--help') { usage(); process.exit(0) }
    else throw new Error(`Unknown arg: ${a}`)
  }
  return args
}

async function main () {
  const args = parseArgs(process.argv)
  if (args.selfTest) {
    selfTest()
    return
  }
  if (args.url) {
    await liveCheck(args.url, args.secret)
    return
  }
  usage()
  process.exit(2)
}

main().catch((err) => {
  console.error(err?.stack ?? String(err))
  process.exit(1)
})
