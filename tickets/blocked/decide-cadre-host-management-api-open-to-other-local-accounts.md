description: On a machine with several user accounts, any account can call cadre-host's local management service without logging in, so it can read a waiting node's one-time claim code and start or remove nodes, even though the data folder is now private. A person needs to decide whether shared machines are supported.
architecture: docs/hosting/cadre-host.md#security-posture
files: packages/cadre-host/src/server/origin-guard.ts, packages/cadre-host/src/server/server.ts, packages/cadre-host/src/server/routes/hosted-nodes.ts, packages/cadre-host/src/bin/host.ts, docs/hosting/cadre-host.md, packages/cadre-host/README.md
repro: static
----
# Decide whether other local accounts may use cadre-host's management API

**Blocked: the architecture document contradicts itself. Accept or edit the proposed text below to unblock.**

## The contradiction

`docs/hosting/cadre-host.md` → Security posture now says other local accounts are kept out of the data folder, because it holds claim secrets and other credentials. `docs/hosting/cadre-host.md` → No login says the case of an attacker on the machine who cannot run code as the cadre-host user is a "non-existent threat model", and "Don't add auth here". Both cannot steer the same code: the first treats other accounts as a threat, and the second says there is no such threat.

Until this is settled, the data folder's 0700 mode protects what is only on disk (node identities, push private keys, invitations, each node's data). It does not protect a pending claim secret, because the API returns it.

## What was observed

The host listens on `127.0.0.1` with no login. The origin guard checks only the `Host` and `Origin` headers, which stops web pages (DNS rebinding) and not local programs, because a program sets its own headers.

A scratch host built from `master` on Windows answered these requests sent by `curl` with no credentials:

- `GET /api/hosted-nodes`: 200
- `POST /api/hosted-nodes` with `{}`: 201, a new node started
- `GET /api/hosted-nodes/<id>/claim`: 200, the QR payload, which contains the claim secret
- `DELETE /api/hosted-nodes/<id>`: 204, the node removed

These ran from the same account as the host. A request from a different account has not been tried, and needs a machine with two accounts to confirm. It is inferred from the fact that a loopback TCP listener with no credential check does not look at who connected.

With the claim secret, another account can claim the waiting node for a cadre of its choosing before the owner scans the code. The other routes (settings, updates, NAT) have the same lack of a check and were not called.

## Proposed text (recommended default)

Replace the `docs/hosting/cadre-host.md` → No login section with:

> ### Local access token
>
> Every management API request carries a token. `start` generates a random token and writes it to `<dataDir>/api-token` (0600, inside the 0700 data directory), so only the cadre-host user can read it, and any other local account gets 401. The CLI reads the file. `cadre-host ui` prints and opens a URL carrying the token, which the page exchanges for an HttpOnly cookie, and this also works through an SSH forward. The token is never printed by `start`, because service logs may be readable by others. The origin guard stays, because it answers a different attack (a web page in the admin's browser). A password adds nothing: the admin account can already read everything the API serves.

Why this one: it extends the boundary that the data folder already draws. Whoever can read the data folder can use the API, and nobody else, with no accounts or passwords to manage.

## Alternatives rejected

- **Declare shared machines unsupported** (edit Security posture to say other local accounts are trusted, and keep no login). This is the cheapest option and a defensible one for the household machines the product targets, and it needs only documentation. Rejected as the default because the fix just shipped treats those accounts as a threat, and the docs describe running on a VPS, where several accounts are common; they say nothing either way about a family machine with several accounts. If this is chosen, the 0700 mode remains useful as protection for files, and the docs must say plainly that the API is open.
- **Unix socket in the data folder.** The filesystem would do the access check, but browsers and SSH port forwards of the local UI cannot use it as they use a TCP port, and it has no Windows equivalent with the same behaviour.
- **Ask the operating system which account owns the connection.** Node exposes no peer-credential call for TCP sockets, and it would need code for each platform.

## If nothing is done

Any local account on a shared machine can read a waiting node's claim secret, and start or remove nodes. A machine with one account is unaffected. The docs currently state this limit, in Security posture.

## Reversibility

Adding the token is easy to reverse, and the project has no backward-compatibility constraint yet. It touches the CLI's API client, the local UI's first load, and any spec that calls the API directly.

## Doc references

`docs/hosting/cadre-host.md` → "No login" (`#no-login`) was rewritten and no longer contains the quoted "non-existent threat model" or "Don't add auth here"; it now says other accounts on the machine can call the API, and the "Limits and accepted tradeoffs" list (`#limits-and-accepted-tradeoffs`) records that as a limit citing this ticket, so the decision asked for here is unchanged and the proposed text would replace the current "No login" section.
