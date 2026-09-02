## Quickstart: Serve the dynamic ICE manifest (turn-credential-issuer)

Goal: serve the **ICE-config manifest** (`/ice-servers.json`) WebRTC clients fetch
at startup. With TURN off it's STUN-only; with the co-located coturn TURN relay on,
each fetch carries a **short-lived, freshly-minted** TURN credential — the piece
that lets you safely advertise TURN to browsers and phones.

### Prereqs
- Docker + Docker Compose v2 installed (see `../README.md` → "Installing Docker (optional)").
- A coturn deployment (`coturn/`) — usually on the **same host**. If you'll enable
  TURN, have its `TURN_SECRET` handy (the issuer must use the same value).
- A TLS reverse proxy (nginx/caddy). The issuer listens **plain HTTP**; you
  terminate HTTPS in front of it.
- A DNS name clients will fetch (example: `turn-issuer.sereus.org`).

### Steps
From your ops root:

```bash
./sereus/ops/scripts/install docker turn-credential-issuer
cd docker-turn-credential-issuer
vi env.local            # set STUN_URLS; if enabling TURN, set TURN_* (secret MUST match coturn)
./svc up
./svc logs
```

### Front it with TLS
Point your reverse proxy at `http://127.0.0.1:${ISSUER_PORT}` and terminate HTTPS,
e.g. `https://turn-issuer.sereus.org/ice-servers.json`. Do **not** expose the
plain-HTTP port publicly — the manifest carries TURN credentials.

### Point clients at it
The existing client helper already fetches a manifest URL — just set the build-time
env var:
- web: `VITE_ICE_CONFIG_URL=https://turn-issuer.sereus.org/ice-servers.json`
- React Native: `EXPO_PUBLIC_ICE_CONFIG_URL=https://turn-issuer.sereus.org/ice-servers.json`

With `ISSUER_AUTH_TOKEN` set, gate with zero client change by appending
`?token=<token>` to that URL.

### Enabling TURN (deliberate)
A TURN entry appears **only** when ALL hold: `TURN_ENABLED=true`, `TURN_SECRET` set
(== coturn's), `TURN_URLS` non-empty, and `TURN_POLICY=gated|on`. Otherwise the
manifest stays STUN-only. Run **NTP** on both the issuer and coturn hosts — coturn
checks credential expiry against its own clock. See `../turn-credential-issuer/README.md`.

### Validate
From your ops root — scheme self-test (no network):

```bash
node sereus/ops/test/check-turn-creds.mjs --self-test
```

Live check against your deployed issuer:

```bash
node sereus/ops/test/check-turn-creds.mjs \
  --url https://turn-issuer.sereus.org/ice-servers.json --secret <TURN_SECRET>
```

### References
- ICE manifest + STUN-first policy: `../../docs/ice-servers.md`
- The relay this issues for: `../coturn/README.md`
