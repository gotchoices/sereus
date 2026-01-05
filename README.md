## Sereus Fabric

Sereus is a Web3 programming fabric built on consent-based strands where users control identity, data, and connections. Instead of global identities and central brokers, Sereus forms small, private subnets by invitation only. Each strand is a shared SQL database with role-based permissions, distributed across participants' devices for resilience.

### Why Sereus
- **Privacy by design**: No global identity directory; identities exist only within strands you join.
- **Direct peer connections**: libp2p multiaddresses enable end-to-end encrypted, serverless communication.
- **Familiar SQL**: Each strand is a relational database; apps read/write via standard SQL.
- **Decentralized & resilient**: Data is distributed across participants’ devices (“cadres”).
- **Developer-friendly**: Focus on application logic; the fabric handles distribution and transport.

### Core Concepts
- **Strands**: Invitation-only trust domains; each strand contains a shared SQL database and RBAC.
- **Cadre**: The group of nodes that manage/store data on behalf of a given user (or strand member). Your personal infrastructure cluster.
- **Cohort**: All nodes belonging to a strand—the combined cadres of all strand members working together to distribute the strand's database.
- **Transport**: Peer-to-peer connectivity via libp2p (NAT traversal, relays, encrypted links).

### Technology Stack
- **Quereus** (SQL processor): Query parsing, transactions, distributed-aware optimization.
- **Optimystic** (storage engine): B-trees, block storage, sharding, synchronization.
- **Fret** (DHT): Content addressing and node discovery within strands (part of Optimystic).
- **libp2p** (P2P network): Multiaddressing, NAT traversal, relays, encryption.

### What You Can Build
- Secure messaging and social media (consent-based follows, no spam)
- Classifieds/marketplaces (neutral discovery, user-chosen services)
- Distributed storage (trusted-device backup networks)
- Medical records (patient-owned data, revocable provider access)
- Community voting (auditable, privacy-preserving)
- Digital currency (shared tallies for credit-based exchange)

### Getting Started
1) Understand the model: strands, cadres, roles, libp2p addressing.
2) Set up the stack locally (Quereus, Optimystic/Fret, libp2p).
3) Define a strand schema and roles; initialize your first strand.
4) Connect a second node via invitation; verify synchronized SQL state.
5) Build your app by issuing SQL against the strand database.

### Ops (running bootstrap/relay nodes)
If you’re operating infrastructure (e.g., **libp2p relay** and/or **bootstrap** nodes), start here:
- `ops/README.md` (entry point)
- `ops/docker/README.md` (Docker-based production workflow + installer)

See `docs/web/` for the full site content (Overview, Architecture, Stack, Use Cases, Get Started). Public site: `https://sereus.org`.

### Status
Active development. Core concepts are stable; APIs/tooling are evolving. Early adopters should expect rapid iteration and close-to-the-code workflows.

### Credits
Sereus is a project of the GotChoices Foundation.


