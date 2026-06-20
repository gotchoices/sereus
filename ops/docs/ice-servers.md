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
- `turnPolicy` records the intent: `"off"` (default), `"gated"` (TURN exists but
  only issued to vetted clients), or `"on"`. It is **informational** — clients use
  whatever `iceServers` entries are present; `turnPolicy` is for operators/telemetry.

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

When TURN is enabled **and** a credential service exists, add a TURN entry with
ephemeral (time-limited) credentials. The manifest is then per-client / short-lived
(the credentials expire), so it must be generated on demand by that service rather
than served as a static file:

```jsonc
{
  "urls": ["turn:turn.sereus.org:3478?transport=udp"],
  "username": "1735689600:web",                 // <unixExpiry>:<id>
  "credential": "base64(HMAC-SHA1(secret, username))"
}
```

> ⚠️ Never put static TURN user/password in the manifest — it would be a public,
> long-lived open-relay credential. TURN credentials must be ephemeral, issued by
> the (not-yet-built) **`turn-credential-issuance-service`** (backlog). Until that
> lands, keep `turnPolicy: "off"` and advertise STUN only.

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
`packages/reference-app-web/src/lib/ice-config.ts` exposes `loadIceConfig()`:
resolve URL (`VITE_ICE_CONFIG_URL` → `localStorage['ice-config-url']` → none),
fetch + validate, and return `RTCIceServer[]`. It returns `[]` on any failure (no
URL, network error, malformed) and **never** falls back to a third-party STUN
(e.g. Google) — empty is the privacy-preserving default. The WebRTC transport
wiring that consumes it is `web-webrtc-transport-to-bypass-relay` (ticket 3).

`packages/reference-app-rn/src/ice-config.ts` is the React Native port: same
validation, 5 s timeout, and never-throws contract, but resolves the URL from
`EXPO_PUBLIC_ICE_CONFIG_URL` only (no `localStorage`) and returns a local
structural `IceServer[]` (RN's tsconfig lacks the `dom` lib). The transport
wiring that consumes it is `rn-webrtc-transport`.

### Forward pointers (TURN gaps — do not lose these when TURN is enabled)
- **`turn-credential-issuance-service`** (backlog): the signing endpoint that mints
  ephemeral TURN credentials. Required before any TURN entry can appear here.
- **`turn-relayed-path-metrics`** (backlog): the `connection-path` classifier treats
  a TURN-relayed WebRTC connection as `direct` (it only sees `/webrtc`), so a
  TURN-relayed path is **not** counted as relayed in connectivity observability.
  Dormant while TURN is off; must be fixed when TURN is switched on.
