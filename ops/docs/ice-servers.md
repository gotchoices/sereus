## ICE servers (STUN/TURN) discovery

WebRTC peers need a list of **ICE servers** (STUN and optionally TURN) to discover
their public address and, as a last resort, relay media. Unlike libp2p infra,
these are advertised to clients as `stun:` / `turn:` URLs — **not** as
`/dnsaddr/...` multiaddrs — so the libp2p DNSADDR/TXT mechanism (see `dnsaddr.md`)
cannot carry them. Instead clients fetch a small **JSON manifest** at startup.

Fetching the list at runtime (rather than baking it into the app) lets operators
rotate, scale, or fail over STUN/TURN servers **without an app rebuild**.

### STUN-first / TURN-off policy
- **STUN is the goal.** It lets peers form **direct** connections, taking traffic
  off the libp2p circuit relay. Cheap to run; no media flows through it.
- **TURN is a relay by another name.** A TURN-relayed media path burns server
  bandwidth for the life of the connection — the exact cost the WebRTC effort
  removes. So TURN stays **off** by default and the manifest advertises STUN only.
- `turnPolicy` records the intent: `"off"` (default), `"gated"` (TURN exists but is
  only issued to callers the issuer admits), or `"on"`. It is **informational** —
  clients use whatever `iceServers` entries are present; `turnPolicy` is for
  operators/telemetry. How strict `gated` actually is depends on the issuer's
  admission knobs: rate-limit-only at one end, and `PEER_AUTH_MODE=required` plus a
  non-empty `PEER_ALLOW_LIST` — the real "vetted clients only" setup — at the other.

### Manifest schema
The manifest is deliberately shaped like the W3C `RTCIceServer[]` so it drops
straight into `new RTCPeerConnection({ iceServers })` / libp2p
`webRTC({ rtcConfiguration: { iceServers } })`. Reference copy:
`../docker/coturn/ice-servers.example.json`.

```jsonc
{
  "iceServers": [
    { "urls": ["stun:stun.sereus.org:3478"] }
  ],
  "turnPolicy": "off",
  "generatedAt": "2026-06-02T00:00:00Z"
}
```

When TURN is enabled, the manifest adds a TURN entry with ephemeral (time-limited)
credentials. The manifest is then per-client / short-lived (the credentials
expire), so it is **generated on demand** by the credential issuer rather than
served as a static file:

```jsonc
{
  "urls": ["turn:turn.sereus.org:3478?transport=udp"],
  "username": "1735689600:web",                 // <unixExpiry>:<id>
  "credential": "base64(HMAC-SHA1(secret, username))"
}
```

> ⚠️ Never put static TURN user/password in the manifest — it would be a public,
> long-lived open-relay credential. TURN credentials must be ephemeral, minted
> per-request by the **`turn-credential-issuer`** service
> (`../docker/turn-credential-issuer/`). It signs the username with the shared
> coturn `static-auth-secret` (which lives only on the issuer, never in a client
> bundle); coturn verifies. When TURN is off, the issuer serves a STUN-only
> manifest identical in shape to the static example.

### The dynamic manifest (turn-credential-issuer)
`../docker/turn-credential-issuer/` is a tiny HTTP service that serves
`/ice-servers.json` per request. It is the operator-hosted evolution of the static
file: same JSON shape, but it injects a freshly-minted TURN credential when TURN is
enabled. Stand it up co-located with coturn (one `env.local` carries both the
issuer config and the shared `TURN_SECRET`).

- **Gating matrix** — a TURN entry is emitted **only** when ALL hold; otherwise the
  manifest is STUN-only (TURN stays last-resort / off):

  | Condition                              | Manifest          |
  |----------------------------------------|-------------------|
  | `TURN_ENABLED=false`                   | STUN-only         |
  | `TURN_SECRET` or `TURN_URLS` empty     | STUN-only (+ warn)|
  | `TURN_POLICY=off` (secret set)         | STUN-only (policy wins) |
  | enabled + secret + URLs + `gated`/`on` | STUN **+ TURN**   |

- **Turning TURN on** is the `turnPolicy` transition `off → gated`: enable coturn
  TURN, set the issuer's `TURN_SECRET` (== coturn's), `TURN_URLS`, and
  `TURN_POLICY=gated`. Clients need no rebuild — they already pass through
  `username`/`credential`.
- **`Cache-Control: no-store`** — the dynamic endpoint MUST NOT be cached; a stale
  manifest would serve already-expired credentials. (The *static* example file
  stays cacheable — it has no credentials to expire.)
- **CORS** — the issuer sends `Access-Control-Allow-Origin` so cross-origin
  browsers can fetch it; it answers `OPTIONS` preflights for the token-header path.
- **Clock** — coturn checks credential expiry against its own clock, so the issuer
  and coturn must share time (NTP).
- **Abuse posture** — issuance is never unbounded: always-on per-IP rate limit +
  short TTL + optional bearer token, with coturn's quotas as the hard backstop.

#### Peer-bound issuance (per-node attribution)
The posture above bounds abuse but binds a credential to **nobody** — a shared token
in a browser bundle is effectively public, and per-IP limits are coarse. Setting
`PEER_AUTH_MODE` to `optional` or `required` turns on **peer-bound issuance**: the
client signs a short, domain-separated statement with the libp2p Ed25519 identity
key its node already has, and presents it in five `X-Sereus-Peer-*` request headers.

The issuer verifies the signature, derives the peer id **from the presented public
key** (never from a client-supplied id), and uses that peer id as the credential's
`<id>` label — so `username` becomes `<unixExpiry>:<peerId>` and coturn's logs
attribute relayed bytes to the same peer id that appears in relay logs. Operators
get `PEER_ALLOW_LIST` / `PEER_DENY_LIST` and a per-peer issuance limit on top of the
per-IP one.

Two informational manifest fields come with it — `peerAuth` (`"off"` | `"none"` |
`"verified"`) and, when verified, `peerId`. Clients read only `iceServers`, so older
clients are unaffected.

Replay protection is a client-chosen nonce plus a bounded acceptance window
(`PEER_AUTH_SKEW_SECONDS`), not a server-minted challenge: same property, no
cross-replica state, no extra round trip per node start. The replay cache and both
rate limiters are per-process, so replicas do not share them.

The wire format, the full admission order, and the status codes are normative in
`../docker/turn-credential-issuer/README.md` → "Peer-bound issuance".

See `../docker/turn-credential-issuer/README.md` for the full knob set and the
reverse-proxy / `TRUST_PROXY` notes.

##### Client side (what the apps send)
Both reference apps send an assertion on **every** manifest fetch — the web app
(`packages/reference-app-web/src/lib/ice-config.ts`, signing with the browser peer
key) and the React Native app (`packages/reference-app-rn/src/ice-config.ts`,
signing with the secure-enclave identity key). Nothing needs to be turned on in the
app: with `PEER_AUTH_MODE=off` the issuer simply ignores the headers.

**`PEER_AUTH_AUDIENCE` must equal the manifest URL the app fetched, with the query
string and fragment removed and nothing else changed.** The comparison is exact —
these are all *different* audiences:

```
https://relay.sereus.org/ice-servers.json     ← what to configure
https://relay.sereus.org/ice-servers.json/    ← trailing slash: mismatch
http://relay.sereus.org/ice-servers.json      ← scheme: mismatch
https://relay.sereus.org/ice/servers.json     ← proxy rewrote the path: mismatch
/ice-servers.json                             ← relative URL: this IS the audience
```

That last one is the trap in a same-origin deployment. The client takes the
audience from the *configured URL string* and normalizes nothing, so a relative
`VITE_ICE_CONFIG_URL=/ice-servers.json` signs the audience `/ice-servers.json` —
the browser resolves the fetch against the page origin, but the signed string never
sees that origin. Either set `PEER_AUTH_AUDIENCE=/ice-servers.json` to match, or
configure the app with the absolute URL. (Leaving `PEER_AUTH_AUDIENCE` empty
disables audience binding entirely — see the issuer README before choosing that.)

A mismatch is invisible from the server side (it looks like any other bad
signature), so the client logs the audience it sent whenever it falls back. Look
for this in the browser/device console:

```
[reference-app-web] ice-config: peer assertion not accepted — HTTP 401,
  audience "https://relay.sereus.org/ice-servers.json"; retrying unauthenticated
```

**CORS: a static manifest on another origin now needs preflight support.** The five
`X-Sereus-Peer-*` headers are not CORS-safelisted, so a *cross-origin* fetch from
the web app is preflighted — the browser sends an `OPTIONS` first. The
turn-credential-issuer answers that preflight (it lists all five headers in
`Access-Control-Allow-Headers`); a plain static file server generally does not. Two
ways this is already safe:

- Host the manifest **same-origin** with the web app and there is no CORS at all.
- Cross-origin and static: the failed preflight surfaces as a network error, and
  the client retries unsigned — which is a "simple request" and needs no
  preflight — so STUN survives. It costs one wasted round trip per tab start; add
  the header to the static host's CORS config to avoid it.

Three client behaviours worth knowing when reading issuer logs:

- **The 4xx/503 fallback.** On `400`, `401`, `403`, or `503` — the statuses only
  the assertion path can produce — the client retries the fetch **once** with no
  assertion headers, and uses whatever that returns. A device with a clock skewed
  past `PEER_AUTH_SKEW_SECONDS`, a deny-listed peer, or a full replay cache
  therefore keeps working on the unauthenticated path rather than losing STUN
  entirely (`loadIceConfig` turns a non-OK response into `[]`, which would strip
  STUN too). So expect a paired 401-then-200 in the access log. `429` is
  deliberately **not** in that list: the per-IP limit fires before the assertion is
  parsed, so an unsigned retry would hit the same wall. Note the retry does spend a
  second token of the per-IP limit `RATE_LIMIT_PER_MIN`: a *persistently* rejected assertion
  (a misconfigured audience, say) halves the effective per-IP budget, which matters
  only if many clients share one address behind NAT. Fix by correcting the audience
  — the fallback is meant to be rare, not steady-state.
- **A signed request that fails outright** takes the same single retry, for the
  CORS reason above. A genuinely offline device just fails twice inside the one 5 s
  deadline and gets `[]`, as before.
- **No assertion at all** is not an error either — if signing fails for any reason
  the app logs it and fetches unauthenticated. Identity trouble never stops a node
  from booting.

The whole exchange is one request per node start (plus at most one retry), so
under `required` mode a node that cannot assert still gets the STUN-only `200`.

### Where to host it
The manifest is plain HTTPS — host it wherever is convenient and same-origin-ish
for the app:
- alongside the web app origin (e.g. `https://app.sereus.org/ice-servers.json`), or
- alongside the relay/ops infra (e.g. `https://relay.sereus.org/ice-servers.json`).

Clients point at it via a build-time env var — `VITE_ICE_CONFIG_URL` (web) or
`EXPO_PUBLIC_ICE_CONFIG_URL` (React Native) — or, on web only, a `ice-config-url`
`localStorage` override (runtime/debug). With none set, clients run **STUN-less**
— degraded but safe (no leak to a third-party STUN); see the helpers below.

### Rotating / scaling without an app rebuild
- Add capacity: list multiple STUN servers in `iceServers` (the browser races them).
- Replace a server: edit the manifest's URL and re-publish — clients pick it up on
  their next load. No app deploy.
- Regenerate `generatedAt` on each change so caches/operators can tell versions apart.
- Set a short `Cache-Control` max-age on the manifest so rotations propagate quickly.

### Optional: DNS-anchored discovery (TXT pointer)
Operators who prefer to anchor discovery in DNS (rather than hardcoding a manifest
URL in the app) can publish a TXT record pointing at the manifest, and have their
own bootstrap step read it:
- `_ice-config.sereus.org  TXT  "url=https://app.sereus.org/ice-servers.json"`

This is just an indirection to the same JSON manifest — the browser helper still
fetches and validates that JSON. (This is distinct from the libp2p `_dnsaddr`
records in `dnsaddr.md`, which carry multiaddrs, not `stun:`/`turn:` URLs.)

### Client helpers
`packages/reference-app-web/src/lib/ice-config.ts` exposes
`loadIceConfig({ url?, signer? })`: resolve URL (`options.url` →
`VITE_ICE_CONFIG_URL` → `localStorage['ice-config-url']` → none), optionally attach
a peer assertion, fetch + validate, and return `RTCIceServer[]`. It returns `[]` on
any failure (no URL, network error, malformed) and **never** falls back to a
third-party STUN (e.g. Google) — empty is the privacy-preserving default. The
WebRTC transport wiring that consumes it is `web-webrtc-transport-to-bypass-relay`
(ticket 3).

`packages/reference-app-rn/src/ice-config.ts` is the React Native port: same
validation, same assertion wire format, 5 s timeout, and never-throws contract, but
resolves the URL from `EXPO_PUBLIC_ICE_CONFIG_URL` only (no `localStorage`) and
returns a local structural `IceServer[]` (RN's tsconfig lacks the `dom` lib). The
transport wiring that consumes it is `rn-webrtc-transport`.

Both copies are deliberately dependency-free: the signing capability arrives as an
injected structural interface (`IceConfigPeerSigner`), so neither file imports a
crypto library. The real signer is `peerKeySigner(privateKey)` from
`@serfab/cadre-core` (`packages/cadre-core/src/identity-key.ts`), which also owns
`loadOrCreateIdentityKey` — the single load-or-create rule the React Native app and
`CadreNode` share, so the app can sign with the very key the node then starts with.

### Forward pointers (TURN gaps — do not lose these when TURN is enabled)
- **`turn-credential-issuer`** (built — `../docker/turn-credential-issuer/`): the
  signing service that mints ephemeral TURN credentials and serves the dynamic
  manifest. This is what makes a TURN entry possible here. Peer-bound issuance
  (`PEER_AUTH_MODE`) is built into it — see the section above.
- **`web-turn-relayed-path-detection`** (backlog): the `connection-path` classifier treats
  a TURN-relayed WebRTC connection as `direct` (it only sees `/webrtc`), so a
  TURN-relayed path is **not** counted as relayed in connectivity observability.
  Dormant while TURN is off; must be fixed when TURN is switched on.
