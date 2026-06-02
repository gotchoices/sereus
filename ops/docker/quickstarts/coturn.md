## Quickstart: Run a public STUN server (coturn)

Goal: run **coturn** as a public **STUN** server so WebRTC peers discover their
public (server-reflexive) address and connect **directly** instead of relaying
through the libp2p circuit relay. TURN (media relay) stays **off** by default.

### Prereqs
- Docker + Docker Compose v2 installed (see `../README.md` → "Installing Docker (optional)").
- A DNS name you control (example: `stun.sereus.org`).
- A server with a public IP. If it sits behind 1:1 NAT (typical cloud VM), know
  the public IP — you'll set `EXTERNAL_IP`.

### Steps
From your ops root:

```bash
./sereus/ops/scripts/install docker coturn
cd docker-coturn
vi env.local            # set STUN_PUBLIC_HOST=stun.sereus.org (+ EXTERNAL_IP if NATed)
./svc up
./svc logs
```

### Publish DNS (A/AAAA — NOT dnsaddr)
coturn is not a libp2p node, so it uses a plain host record, not `_dnsaddr` TXT:
- **A**: `stun.sereus.org -> <server public IPv4>`
- **AAAA** (optional): `stun.sereus.org -> <server public IPv6>`

### Advertise to clients (ICE manifest)
Clients don't hardcode STUN URLs — they fetch a small JSON manifest at runtime.
Copy `../coturn/ice-servers.example.json`, set the `stun:` URL to your host, and
host it over HTTPS. Full publication + rotation guidance:
- `../../docs/ice-servers.md`

### Validate
A live STUN binding check requires a deployed, reachable server:

```bash
node sereus/ops/test/check-stun.mjs --host stun.sereus.org --port 3478
```

You should see your mapped reflexive `IP:port` printed back.

### Enabling TURN (later, deliberate)
TURN relays media and costs bandwidth — leave it off until you need it. When you
do: set `TURN_ENABLED=true` + `TURN_SECRET`, publish the relay port range (or use
host networking), and stand up the credential service (backlog:
`turn-credential-issuance-service`). See `../coturn/README.md`.
