#!/usr/bin/env bash
set -euo pipefail

# Back-compat wrapper. Prefer `./svc logs`.
exec "$(cd "$(dirname "$0")" && pwd)/svc" logs "$@"


