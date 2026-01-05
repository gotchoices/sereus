#!/usr/bin/env bash
set -euo pipefail

# Back-compat wrapper. Prefer `./svc up`.
exec "$(cd "$(dirname "$0")" && pwd)/svc" up "$@"


