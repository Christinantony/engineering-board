#!/bin/sh
# Engineering Board: start the server on Linux (or macOS).
# Needs Node.js 22.16 or newer on the PATH, or a `node` binary next to this script.
# Run from anywhere:  ./start.sh     Stop with Ctrl+C (or `systemctl stop` when run as a service).
set -e
cd "$(dirname "$0")"
[ -f app/server.mjs ] || cd ..            # the script also lives in linux/ inside the package
NODE=node
[ -x ./node ] && NODE=./node
if ! command -v "$NODE" >/dev/null 2>&1; then
  echo "Node.js is not installed. Install Node.js 22 LTS (https://nodejs.org) and run this again." >&2
  exit 1
fi
exec "$NODE" app/server.mjs
