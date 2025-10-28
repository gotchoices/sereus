#!/usr/bin/env bash
# Simple static server for the Sereus site
# Usage: ./server.sh [port]
# Default port: 8080

set -euo pipefail

PORT="${1:-8080}"

# Ensure web images exist (copy logo if needed)
mkdir -p images
if [ ! -f images/logo2.png ] && [ -f ../images/logo2.png ]; then
  cp ../images/logo2.png images/logo2.png
fi

echo "Serving Sereus at http://localhost:${PORT}/index.html#home"
python3 -m http.server "${PORT}"


