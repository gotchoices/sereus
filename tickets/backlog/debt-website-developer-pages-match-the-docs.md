description: The public website's "Get Started" page shows a database example that the product rejects, tells developers that any programming language will work, and never names the packages to install; it and the neighbouring technical pages should be brought in line with the developer documentation.
architecture: docs/web/README.md#keeping-the-site-true
files: docs/web/get-started.html, docs/web/stack.html, docs/web/architecture.html, docs/web/overview.html, docs/web/home.html, docs/web/README.md, docs/getting-started.md, docs/schema-guide.md, docs/concepts.md
tradeoffs: The site is a hand-written introduction for a general audience and publishing it needs access to the web host, so a maintainer may prefer to cut the technical detail from these pages and link to the documentation instead of keeping two descriptions in step.
----

# The website's developer-facing pages do not match the developer documentation

`docs/web/` is the source of the public site at sereus.org. `docs/web/README.md` ("Keeping the site true") says that when a page shows code or names a package, the example comes from `docs/getting-started.md` or `docs/schema-guide.md`, whose examples are checked. The pages below predate those documents and nothing checks them.

## `get-started.html`

- **The example schema is refused by the engine.** The page shows `CREATE TABLE messages (id SERIAL PRIMARY KEY, …, timestamp TIMESTAMP DEFAULT NOW())`. Run against the Quereus build this repository links, `id SERIAL PRIMARY KEY` fails with "Unknown type 'SERIAL'" and `DEFAULT NOW()` fails with "Function not found: NOW/0". The type name `TIMESTAMP` alone is accepted, and the `participants` table on the page is accepted. The page's `INSERT INTO messages (sender, content)` depends on both rejected defaults.
- **The example is not in the form an app uses.** An app declares its tables as a schema body (`table Message (…)`) passed as the sApp's `schema` option. `docs/schema-guide.md` says a strand table has no auto-increment and that Quereus rejects the current time in a default, because every node re-executes a write and must reach the same answer; the app supplies ids and timestamps with each insert. The chat schema the reference apps ship, `schemas/chat-simple.qsql`, is a working messaging example of the right shape.
- **"Choose your language: Any language with SQL support can work."** The API is a set of JavaScript and TypeScript packages, and the SQL engine runs inside the app's process. There is no network SQL endpoint or driver for another language.
- **The packages are never named.** "Step 1: Install the Sereus Stack" lists Quereus, Optimystic, Fret, libp2p and "bootstrap tools", and says "Detailed installation documentation is in development". `docs/getting-started.md` installs `@serfab/cadre-core` with npm; `@serfab/cadre-rn`, `@serfab/quereus-plugin-sereus`, `@serfab/cadre-cli`, `@serfab/cadre-host` and `@serfab/cadre-provider` are not mentioned anywhere on the site.
- **Steps 2 to 4 describe tools that do not exist under those names.** "Use bootstrap tools to create the strand database", "generate an invitation from your first node". The corresponding steps are calls on `CadreNode` (`foundStrand`, a formation invitation) or commands of cadre-cli and cadre-host.
- **"Fret: Distributed hash table (included with Optimystic)".** Fret is its own repository and npm package (`p2p-fret`), which `@optimystic/db-p2p` depends on.
- **"Linux/Unix environment: Most development happens on Linux; macOS works as well."** cadre-host installs as a service on Linux, macOS and Windows, and the contributor documents carry Windows instructions.
- **"Handle events: React to changes in the strand."** Change notifications are off by default and enabled in none of the reference apps, which poll (`docs/strands/app-schema.md`, "Change notifications").
- **"Cross-strand references"** is listed under advanced features. No document in `docs/` describes such a feature.

## The same kind of claim on other pages

Found by skimming `stack.html`, `architecture.html`, `overview.html` and `home.html`. The `use-*.html` pages are scenario descriptions with no code and were only searched for SQL and package names (none found).

- **Fret as part of Optimystic** (`stack.html`: "part of the Optimystic distribution", "Fret is distributed as part of Optimystic"). As above.
- **Access control done by the engine** (`stack.html`: Quereus "applies role-based access controls", "Role-based access control integration"; `architecture.html` and `overview.html`: "different read/write privileges on tables and fields", "access controlled by role-based permissions"). Write rules are constraints the app's own schema declares (`docs/schema-guide.md`, "Roles and permissions"). Nothing restricts reads inside a strand: every member's nodes store and re-execute every write, and `docs/strands/keys.md` says the closed-strand read secret does not restrict reads.
- **Invitation as the only way in** (`architecture.html`: "Only invited participants can join", "No one can join a strand without explicit invitation"; similar on `overview.html` and `home.html`). True of a closed strand. An open strand keeps no membership records, and "any node that knows the strand's id and can reach a node serving it can read it" (`docs/concepts.md`).
- **"End-to-end encryption: libp2p connections are encrypted"** (`architecture.html`). That is encryption of each connection between two nodes, not encryption of the data from one member to another. `docs/strands/keys.md` says no code encrypts strand data with the closed-strand read secret.
- **Transports** (`stack.html`: "TCP, WebSockets, QUIC, etc.", "NAT traversal and hole-punching"). These describe libp2p in general. A Sereus node configures TCP, WebSocket and circuit relay (`docs/cadre/node.md`); WebRTC is planned work in `tickets/implement/`, and QUIC is not among the transports a node sets up.
- **"Bob sees the update in real-time"** (`architecture.html`). See the change-notification point above.
- **"Bootstrap Tools"** (`stack.html`) lists capabilities without naming cadre-cli, cadre-host or cadre-provider, which are the tools.

## Expected

The developer-facing pages either state what `docs/getting-started.md`, `docs/schema-guide.md` and `docs/concepts.md` state, with examples copied from those documents, or drop the detail and link to them. The schema on the Get Started page is one the engine accepts. Claims about privacy and access (who can read a strand, what is encrypted) match `docs/concepts.md`, since these are the claims a reader is most likely to rely on.

## Evidence

The two SQL results were obtained by running the page's statements on a new `Database` from `@quereus/quereus` as linked in this workspace. Everything else was read from the pages and the documents named. The published site was not fetched; this is about the source in `docs/web/`.
