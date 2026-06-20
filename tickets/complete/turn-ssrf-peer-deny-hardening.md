----
description: Hardened the TURN relay so a client can no longer reach the host's private network through IPv6 encodings of private IPv4 addresses, and documented how to validate the config against the real coturn binary.
files: ops/docker/coturn/turnserver.conf, ops/docker/coturn/README.md
prereq: webrtc-stun-turn-infrastructure
difficulty: easy
----

## What shipped

Two ops files were changed to close TURN SSRF bypass vectors and document binary
config validation.

### `ops/docker/coturn/turnserver.conf`
The IPv6 `denied-peer-ip` block grew from 3 entries to 7, adding:
- `::` (unspecified, belt-and-suspenders alongside coturn's built-in loopback deny),
- `::ffff:0:0-::ffff:ffff:ffff` — IPv4-mapped IPv6 (`::ffff:0:0/96`),
- `64:ff9b::-64:ff9b::ffff:ffff` — NAT64 well-known prefix (`64:ff9b::/96`, RFC 6052),
- `64:ff9b:1::-64:ff9b:1:ffff:ffff:ffff:ffff:ffff` — NAT64 local-use prefix (`64:ff9b:1::/48`, RFC 8215).

The section header and IPv6 comment were reconciled to describe the new coverage.

### `ops/docker/coturn/README.md`
Added a "Config parse check" subsection (render via `entrypoint.sh` + a brief
`docker run` of the real coturn binary, grep-filtered for error lines), since
coturn has no `--check-config` flag.

## Review findings

### Verified (correct as implemented)
- **Range arithmetic.** All three new ranges were checked by hand against their
  CIDR. `::ffff:0:0/96` → `::ffff:0:0`–`::ffff:ffff:ffff` ✓. `64:ff9b::/96` →
  `64:ff9b::`–`64:ff9b::ffff:ffff` ✓. `64:ff9b:1::/48` →
  `64:ff9b:1::`–`64:ff9b:1:ffff:ffff:ffff:ffff:ffff` ✓ (the gap the implementer
  flagged for verification — the end address is correct for a /48).
- **Render is clean.** Ran the documented `COTURN_RENDER_ONLY=1` render against
  the template (entrypoint.sh): all `${...}` placeholders substituted, no
  leakage, all 7 IPv6 entries present in the active config, exit 0.
- **No conflict with coturn built-ins.** `no-loopback-peers` /
  `no-multicast-peers` are additive to the explicit `denied-peer-ip` set; the
  new entries extend (not duplicate) that coverage. Denying the *entire*
  `::ffff:0:0/96` (including mapped public IPv4) is intentional — a relay peer
  has no legitimate reason to use the mapped form; public IPv4 is reachable via
  a v4 literal.
- **Lint/test gate is N/A and that is correct.** The diff touches only
  `ops/**` (markdown + a `.conf` template); `ops/**` is in eslint's ignore list
  (`eslint.config.mjs:57`) and there is no JS/TS surface, so `yarn lint` /
  package tests do not cover these files. The applicable validation is the
  coturn binary parse check, which needs Docker.

### Fixed inline (minor)
- **README render env var was a no-op.** The new render example set
  `REALM=sereus`, but `entrypoint.sh` recomputes `REALM` from
  `TURN_REALM`/`STUN_PUBLIC_HOST` and never reads a bare `REALM` env var.
  Changed to `TURN_REALM=sereus` (the real knob) so the example teaches the
  correct variable; output is unchanged (`realm=sereus`).
- **Binary-check false-clean on slow image pull.** `timeout 3 docker run ...`
  would be killed mid-pull on the first run, leaving the grep with no input —
  which reads as a clean parse. Added an explicit `docker pull coturn/coturn`
  before the timed run so the 3s window covers only the parse, and noted the
  failure mode in a comment.

### Filed as follow-up (backlog)
- **`turn-deny-deprecated-transition-prefixes`** — the deny set closes the
  realistic modern bypasses (IPv4-mapped, NAT64) but not the deprecated 6to4
  (`2002::/16`) and Teredo (`2001:0000::/32`) transition prefixes, which can
  also encode an IPv4 target. These require a specific (and now-deprecated)
  transition gateway in path, so the residual exposure is low — defense-in-depth
  accuracy rather than an active hole. Tracked there rather than blocking this
  ticket, with the exact ranges and the alternative of softening the
  "every non-public range" comment.

### Not done / deferred (environment)
- **Binary parse check not executed.** Docker is unavailable in the review
  environment (`command -v docker` → not found), so the README's `docker run`
  coturn parse check could not be run. The start–end syntax of the new entries
  is identical to the pre-existing `fc00::`/`fe80::` entries (already validated
  when the deny block was first added), so confidence is high, but a human/CI
  with Docker should run the documented check once before TURN is enabled. This
  is the same deferral the implementer noted, now confirmed unavoidable here.

## Tests
No automated tests apply (config/docs-only change in `ops/**`, outside the
lint/test gate — see above). Manual validation performed: `COTURN_RENDER_ONLY=1`
render succeeds with correct substitution and all deny entries present. Binary
parse check deferred to a Docker-capable environment.
