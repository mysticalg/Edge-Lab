#!/bin/sh
set -eu
cd "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
echo "Edge Lab: open http://127.0.0.1:4178; Ctrl+C stops the server."
if [ -x runtime/bin/node ]; then
  exec runtime/bin/node server.mjs
fi
exec node server.mjs
